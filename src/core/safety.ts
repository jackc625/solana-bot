import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { MintLayout, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import * as JSBI from "jsbi";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import type { PumpToken } from "../monitor/pumpFun.js";
import { Jupiter } from "@jup-ag/core";
import { loadBotConfig } from "../config/index.js";
import { addToBlacklist } from "../utils/blacklist.js";
import { getPumpMetadata } from "../utils/pump.js";
import { getSharedJupiter } from "../utils/jupiter.js";

const config = loadBotConfig();

// --- Config schema & types
type RawConfig = unknown;
const ConfigSchema = z.object({
    minLiquidity: z.number().nonnegative(),
    maxLiquidity: z.number().nonnegative().optional(),
    maxTaxPercent: z.number().min(0).max(100),
    honeypotCheck: z.boolean().default(true),
});
type Config = z.infer<typeof ConfigSchema>;

// --- Safety result interface
export interface SafetyResult {
    passed: boolean;
    reason?: string;
}

const evaluatedTokens = new Map<string, number>();
const SAFETY_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Clean up old entries periodically
setInterval(() => {
    const now = Date.now();
    for (const [mint, ts] of evaluatedTokens.entries()) {
        if (now - ts > SAFETY_TTL_MS) {
            evaluatedTokens.delete(mint);
        }
    }
}, 60_000);

// --- Blacklist caching
const blacklistPath = path.resolve(
    new URL("../..", import.meta.url).pathname,
    "config/blacklist.json"
);
let _blacklist: string[] | null = null;
async function loadBlacklist(): Promise<string[]> {
    if (_blacklist) return _blacklist;
    try {
        const data = await fs.readFile(blacklistPath, "utf-8");
        _blacklist = JSON.parse(data) as string[];
    } catch {
        _blacklist = [];
    }
    return _blacklist;
}

// --- Helper to get mint info
async function getMintInfo(
    connection: Connection,
    mintAddress: PublicKey
): Promise<{
    supply: bigint;
    mintAuthority: PublicKey | null;
    freezeAuthority: PublicKey | null;
}> {
    const mintAccount = await connection.getAccountInfo(mintAddress);
    if (!mintAccount) throw new Error("Mint account not found");

    const mintInfo = MintLayout.decode(mintAccount.data);
    const supply = mintInfo.supply as bigint;
    const mintAuthority = mintInfo.mintAuthorityOption
        ? new PublicKey(mintInfo.mintAuthority)
        : null;
    const freezeAuthority = mintInfo.freezeAuthorityOption
        ? new PublicKey(mintInfo.freezeAuthority)
        : null;

    return {
        supply,
        mintAuthority,
        freezeAuthority,
    };
}

// --- Honeypot detection via Jupiter aggregator
async function simulateSwapTaxes(
    tokenMint: PublicKey,
    connection: Connection,
    walletPubkey: PublicKey
): Promise<{ sellTax: number; buyTax: number; isHoneypot: boolean }> {
    const jupiter = await getSharedJupiter(walletPubkey);


    const amountInSol = 0.1;
    const lamportsCount = Math.floor(amountInSol * LAMPORTS_PER_SOL);
    const amount = (JSBI as any).BigInt(lamportsCount);

    const buyRoute = await jupiter.computeRoutes({
        inputMint: NATIVE_MINT,
        outputMint: tokenMint,
        amount,
        slippageBps: 50,
    });

    const buy = buyRoute.routesInfos?.[0];
    const buyOut = buy?.outAmount ? Number(buy.outAmount.toString()) : 0;
    const buyTax = buyOut > 0 ? 1 - buyOut / amountInSol / 1e9 : 1;

    const sellSimulations: number[] = [];
    const sellAttempts = 3;

    for (let i = 0; i < sellAttempts; i++) {
        const sellRoute = await jupiter.computeRoutes({
            inputMint: tokenMint,
            outputMint: NATIVE_MINT,
            amount: buyOut ? (JSBI as any).BigInt(buyOut) : amount,
            slippageBps: 50,
        });

        const sell = sellRoute.routesInfos?.[0];
        const sellOut = sell?.outAmount ? Number(sell.outAmount.toString()) : 0;

        if (sellOut === 0) {
            sellSimulations.push(1); // 100% loss
        } else {
            const tax = 1 - sellOut / (buyOut / 1e9);
            sellSimulations.push(Math.min(Math.max(tax, 0), 1));
        }

        await new Promise((r) => setTimeout(r, 750)); // slight delay
    }

    const avgSellTax = sellSimulations.reduce((a, b) => a + b, 0) / sellSimulations.length;
    const honeypotThreshold = config.honeypotSellTaxThreshold ?? 95;
    const isHoneypot = avgSellTax * 100 >= honeypotThreshold;

    return {
        buyTax: Math.min(Math.max(buyTax, 0), 1),
        sellTax: avgSellTax,
        isHoneypot,
    };
}

// --- Main safety check
export async function checkTokenSafety(
    token: PumpToken,
    rawConfig: RawConfig,
    connection: Connection,
    walletPubkey: PublicKey
): Promise<SafetyResult> {
    try {
        const config = ConfigSchema.parse(rawConfig);
        const blacklist = await loadBlacklist();

        if (evaluatedTokens.has(token.mint)) {
            console.log(`✅ Skipping re-check for ${token.mint} — already evaluated recently`);
            return { passed: true };
        }

        // Cache this token as evaluated
        evaluatedTokens.set(token.mint, Date.now());

        if (blacklist.map((c) => c.toLowerCase()).includes(token.creator.toLowerCase())) {
            return { passed: false, reason: "Creator is blacklisted" };
        }

        console.log(`Liquidity for ${token.mint}: ${token.simulatedLp} SOL`);
        if (token.simulatedLp < config.minLiquidity) {
            return { passed: false, reason: `Liquidity < ${config.minLiquidity} SOL` };
        }
        if (typeof config.maxLiquidity === "number" && token.simulatedLp > config.maxLiquidity) {
            return { passed: false, reason: `Liquidity > ${config.maxLiquidity} SOL (whale trap)` };
        }

        const accountInfo = await connection.getAccountInfo(new PublicKey(token.lpTokenAddress));
        if (!accountInfo) {
            console.log(`🔥 LP token account ${token.lpTokenAddress} is burned — SAFE`);
        } else {
            const owner = accountInfo.owner.toBase58();
            const knownLockers = [
                "GnftVbZgDfFPgG7gPfsGgiUvkzzTxkN2PmdpZRU1iPd",
                "8crxnUjgyZQV7u9RQwnKeZKpYtVCULFki4uejFhnU3MJ",
                "3LSL4MfHRpDn59z7pkCjXEV6d8AoPtaMauMEii8n1ZRJ",
            ];
            if (knownLockers.includes(owner)) {
                console.log(`🔒 LP token is locked with: ${owner}`);
            } else {
                await addToBlacklist(token.creator);
                return { passed: false, reason: `LP token is not locked (owner = ${owner})` };
            }
        }

        const meta = await getPumpMetadata(token.mint);
        if (!meta) {
            return {
                passed: false,
                reason: "Failed to fetch pump.fun metadata",
            };
        }

        // 🧠 Check if creator holds >10% of supply
        const { supply, mintAuthority, freezeAuthority } = await getMintInfo(
            connection,
            new PublicKey(token.mint)
        );
        const totalSupply = Number(supply) / 1e9;

        const largestHolders = await connection.getTokenLargestAccounts(
            new PublicKey(token.mint)
        );

        const creatorHoldings = largestHolders.value.find((a) =>
            a.address.toBase58() === meta.creator ||
            a.address.toBase58().toLowerCase() === meta.creator.toLowerCase()
        );
        const creatorBalance = creatorHoldings?.uiAmount ?? 0;

        if (creatorBalance / totalSupply >= 0.1) {
            await addToBlacklist(meta.creator);
            return {
                passed: false,
                reason: `Creator holds ${(
                    (creatorBalance / totalSupply) *
                    100
                ).toFixed(1)}% of supply — possible whale rug`,
            };
        }

        // 🚨 Check if creator and first buyer are the same
        if (meta.creator === meta.firstBuyer) {
            await addToBlacklist(meta.creator);
            return {
                passed: false,
                reason: "Creator is also first buyer — likely front-run",
            };
        }

        if (mintAuthority) {
            await addToBlacklist(token.creator);
            return {
                passed: false,
                reason: `Mint authority exists: ${mintAuthority.toBase58()}`,
            };
        }

        if (freezeAuthority) {
            await addToBlacklist(token.creator);
            return {
                passed: false,
                reason: `Freeze authority exists: ${freezeAuthority.toBase58()}`,
            };
        }

        const largest = await connection.getTokenLargestAccounts(new PublicKey(token.mint));
        const largestBalance = largest.value[0]?.uiAmount ?? 0;

        if (largestBalance > 0.2 * totalSupply) {
            return {
                passed: false,
                reason: "Top wallet holds >20% — possible dev wallet or whale trap",
            };
        }

        if (config.honeypotCheck) {
            const { buyTax, sellTax, isHoneypot } = await simulateSwapTaxes(
                new PublicKey(token.mint),
                connection,
                walletPubkey
            );

            console.log(`💸 Tax Check: Buy = ${(buyTax * 100).toFixed(1)}%, Sell = ${(sellTax * 100).toFixed(1)}%`);

            if (isHoneypot) {
                await addToBlacklist(token.creator);
                return { passed: false, reason: "Honeypot or 100% sell tax detected" };
            }

            if (buyTax * 100 > config.maxTaxPercent || sellTax * 100 > config.maxTaxPercent) {
                return {
                    passed: false,
                    reason: `Tax too high: Buy ${buyTax * 100}%, Sell ${sellTax * 100}%`,
                };
            }
        }

        return { passed: true };
    } catch (err) {
        return {
            passed: false,
            reason: `Safety check error: ${(err as Error).message}`,
        };
    }
}