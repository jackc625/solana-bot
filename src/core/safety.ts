// src/core/safety.ts

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
import { getSharedJupiter, simulateBuySell } from "../utils/jupiter.js";
import { SOL_MINT } from "../utils/solana.js";
import { sendTelegramMessage } from "../utils/telegram.js";
import { scoreToken } from "./scoring.js";

// --- Config schema & types
type RawConfig = unknown;
const ConfigSchema = z.object({
    minLiquidity: z.number().nonnegative(),
    maxLiquidity: z.number().nonnegative().optional(),
    maxTaxPercent: z.number().min(0).max(100),
    honeypotCheck: z.boolean().default(true),
    honeypotSellTaxThreshold: z.number().min(0).max(100).optional(),
});
type Config = z.infer<typeof ConfigSchema>;

// --- Safety result interface
export interface SafetyResult {
    passed: boolean;
    reason?: string;
}

const evaluatedTokens = new Map<string, number>();
const SAFETY_TTL_MS = 10 * 60 * 1000;

// Periodic cleanup
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
let _blacklist: string[] = [];

async function loadBlacklist(): Promise<string[]> {
    if (_blacklist.length > 0) return _blacklist;
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
    return {
        supply: mintInfo.supply as bigint,
        mintAuthority: mintInfo.mintAuthorityOption ? new PublicKey(mintInfo.mintAuthority) : null,
        freezeAuthority: mintInfo.freezeAuthorityOption ? new PublicKey(mintInfo.freezeAuthority) : null,
    };
}

// --- Honeypot detection via Jupiter
async function simulateSwapTaxes(
    tokenMint: PublicKey,
    connection: Connection,
    walletPubkey: PublicKey,
    rawConfig: RawConfig
): Promise<{ sellTax: number; buyTax: number; isHoneypot: boolean }> {
    const config = ConfigSchema.parse(rawConfig);
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
    for (let i = 0; i < 3; i++) {
        const sellRoute = await jupiter.computeRoutes({
            inputMint: tokenMint,
            outputMint: NATIVE_MINT,
            amount: buyOut ? (JSBI as any).BigInt(buyOut) : amount,
            slippageBps: 50,
        });

        const sell = sellRoute.routesInfos?.[0];
        const sellOut = sell?.outAmount ? Number(sell.outAmount.toString()) : 0;

        sellSimulations.push(sellOut === 0 ? 1 : Math.min(1 - sellOut / (buyOut / 1e9), 1));
        await new Promise((r) => setTimeout(r, 750));
    }

    const avgSellTax = sellSimulations.reduce((a, b) => a + b, 0) / sellSimulations.length;
    const isHoneypot = avgSellTax * 100 >= (config.honeypotSellTaxThreshold ?? 95);

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

        const now = Date.now();
        const tokenAge = now - token.launchedAt * 1000;
        if (tokenAge < 30_000) {
            return { passed: false, reason: "Token too new — retry later" };
        }

        if (evaluatedTokens.has(token.mint)) return { passed: true };
        evaluatedTokens.set(token.mint, now);

        if (blacklist.map((c) => c.toLowerCase()).includes(token.creator.toLowerCase())) {
            await sendTelegramMessage(`🛑 *Blocked token* \`${token.mint}\` — Creator is *blacklisted*`);
            return { passed: false, reason: "Creator is blacklisted" };
        }

        if (!token.simulatedLp || token.simulatedLp < config.minLiquidity) {
            return { passed: false, reason: `Liquidity < ${config.minLiquidity} SOL` };
        }

        if (typeof config.maxLiquidity === "number" && token.simulatedLp > config.maxLiquidity) {
            return { passed: false, reason: `Liquidity > ${config.maxLiquidity} SOL (whale trap)` };
        }

        let accountInfo;
        try {
            accountInfo = await connection.getAccountInfo(new PublicKey(token.lpTokenAddress));
        } catch {
            return { passed: false, reason: "Invalid LP token address" };
        }

        if (!accountInfo) return { passed: true };

        const tokenAmountInfo = await connection.getTokenAccountBalance(new PublicKey(token.lpTokenAddress));
        const lpBalance = tokenAmountInfo?.value?.uiAmount ?? 0;
        if (lpBalance === 0) return { passed: true };

        const owner = accountInfo.owner.toBase58();
        const knownLockers = [
            "GnftVbZgDfFPgG7gPfsGgiUvkzzTxkN2PmdpZRU1iPd",
            "8crxnUjgyZQV7u9RQwnKeZKpYtVCULFki4uejFhnU3MJ",
            "3LSL4MfHRpDn59z7pkCjXEV6d8AoPtaMauMEii8n1ZRJ",
        ];

        if (!knownLockers.includes(owner)) {
            const ownerInfo = await connection.getAccountInfo(new PublicKey(owner));
            const isSystem = owner === "11111111111111111111111111111111";
            if (!(ownerInfo?.executable || isSystem)) {
                await addToBlacklist(token.creator);
                await sendTelegramMessage(`🛑 *Blocked token* \`${token.mint}\` — LP not locked (owner = ${owner})`);
                return { passed: false, reason: `LP not locked` };
            }
        }

        const meta = await getPumpMetadata(token.mint);
        if (!meta) return { passed: false, reason: "Failed to fetch pump.fun metadata" };

        const { supply, mintAuthority, freezeAuthority } = await getMintInfo(connection, new PublicKey(token.mint));
        const totalSupply = Number(supply) / 1e9;

        const largest = await connection.getTokenLargestAccounts(new PublicKey(token.mint));
        const largestBalance = largest.value[0]?.uiAmount ?? 0;
        const creatorHoldings = largest.value.find((a) =>
            a.address.toBase58().toLowerCase() === meta.creator.toLowerCase()
        );
        const creatorBalance = creatorHoldings?.uiAmount ?? 0;

        if (creatorBalance / totalSupply >= 0.1) {
            await addToBlacklist(meta.creator);
            return { passed: false, reason: `Creator holds ${((creatorBalance / totalSupply) * 100).toFixed(1)}%` };
        }

        if (meta.creator === meta.firstBuyer) {
            await addToBlacklist(meta.creator);
            return { passed: false, reason: "Creator is also first buyer" };
        }

        if (mintAuthority) {
            await addToBlacklist(token.creator);
            return { passed: false, reason: "Mint authority exists" };
        }

        if (freezeAuthority) {
            await addToBlacklist(token.creator);
            return { passed: false, reason: "Freeze authority exists" };
        }

        if (largestBalance > 0.2 * totalSupply) {
            return { passed: false, reason: "Top wallet holds >20%" };
        }

        if (config.honeypotCheck) {
            try {
                const { buyTax, sellTax, isHoneypot } = await simulateSwapTaxes(
                    new PublicKey(token.mint),
                    connection,
                    walletPubkey,
                    config
                );
                if (isHoneypot) {
                    await addToBlacklist(token.creator);
                    return { passed: false, reason: "Honeypot or 100% sell tax" };
                }
                if (buyTax * 100 > config.maxTaxPercent || sellTax * 100 > config.maxTaxPercent) {
                    return {
                        passed: false,
                        reason: `Tax too high: Buy ${(buyTax * 100).toFixed(1)}%, Sell ${(sellTax * 100).toFixed(1)}%`,
                    };
                }
            } catch (err) {
                return { passed: false, reason: "Jupiter route simulation failed" };
            }
        }

        const simAmount = 0.01 * 1e9;
        const { passed, buyPass, sellPass } = await simulateBuySell(
            walletPubkey,
            SOL_MINT.toBase58(),
            token.mint,
            simAmount
        );
        if (!passed) {
            await addToBlacklist(token.mint);
            return { passed: false, reason: `Simulation failed (buy: ${buyPass}, sell: ${sellPass})` };
        }

        const { score, details } = await scoreToken(token);
        let msg = `✅ *Token Passed Safety Check*\nScore: ${score}/7\n`;
        for (const [key, val] of Object.entries(details)) {
            msg += `${val ? "✔️" : "❌"} ${key}\n`;
        }
        await sendTelegramMessage(msg);

        return { passed: true };
    } catch (err) {
        return { passed: false, reason: `Safety check error: ${(err as Error).message}` };
    }
}
