// src/core/safety.ts

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { MintLayout, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import * as JSBI from "jsbi";
import { z } from "zod";
import { PumpToken } from "../types/PumpToken.js";
import { addToBlacklist } from "../utils/blacklist.js";
import { getSharedJupiter, simulateBuySell } from "../utils/jupiter.js";
import { SOL_MINT } from "../utils/solana.js";
import { sendTelegramMessage } from "../utils/telegram.js";
import { scoreToken } from "./scoring.js";

// --- Config schema & types
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

// --- In-memory caches
const evaluatedTokens = new Map<string, number>();
const SAFETY_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
    const now = Date.now();
    for (const [mint, ts] of evaluatedTokens.entries()) {
        if (now - ts > SAFETY_TTL_MS) evaluatedTokens.delete(mint);
    }
}, 60_000);

// --- Mint info helper (also returns decimals)
async function getMintInfo(
    connection: Connection,
    mintAddress: PublicKey
): Promise<{ supply: bigint; decimals: number; mintAuthority: PublicKey | null; freezeAuthority: PublicKey | null }> {
    const acct = await connection.getAccountInfo(mintAddress);
    if (!acct) throw new Error("Mint account not found");
    const info = MintLayout.decode(acct.data);
    return {
        supply: info.supply as bigint,
        decimals: info.decimals,
        mintAuthority: info.mintAuthorityOption ? new PublicKey(info.mintAuthority) : null,
        freezeAuthority: info.freezeAuthorityOption ? new PublicKey(info.freezeAuthority) : null,
    };
}

// --- Honeypot/tax simulation
async function simulateSwapTaxes(
    tokenMint: PublicKey,
    connection: Connection,
    walletPubkey: PublicKey,
    rawConfig: unknown
): Promise<{ buyTax: number; sellTax: number; isHoneypot: boolean }> {
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
    const buyOut = buyRoute.routesInfos?.[0]?.outAmount
        ? Number(buyRoute.routesInfos[0].outAmount.toString())
        : 0;
    const buyTax = buyOut > 0 ? 1 - buyOut / amountInSol / 1e9 : 1;

    const sellTaxes: number[] = [];
    for (let i = 0; i < 3; i++) {
        const sellRoute = await jupiter.computeRoutes({
            inputMint: tokenMint,
            outputMint: NATIVE_MINT,
            amount: buyOut ? (JSBI as any).BigInt(buyOut) : amount,
            slippageBps: 50,
        });
        const sellOut = sellRoute.routesInfos?.[0]?.outAmount
            ? Number(sellRoute.routesInfos[0].outAmount.toString())
            : 0;
        const tax = sellOut === 0 ? 1 : Math.min(1 - sellOut / (buyOut / 1e9), 1);
        sellTaxes.push(tax);
        await new Promise((r) => setTimeout(r, 750));
    }
    const avgSellTax = sellTaxes.reduce((a, b) => a + b, 0) / sellTaxes.length;
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
    rawConfig: unknown,
    connection: Connection,
    walletPubkey: PublicKey
): Promise<SafetyResult> {
    try {
        const config = ConfigSchema.parse(rawConfig);

        // 1) Age guard
        if (Date.now() - token.launchedAt < 0) {
            return { passed: false, reason: "Token too new — retry later" };
        }

        // 2) Deduplicate
        if (evaluatedTokens.has(token.mint)) return { passed: true };
        evaluatedTokens.set(token.mint, Date.now());

        // 3) Liquidity thresholds
        if (!token.simulatedLp || token.simulatedLp < config.minLiquidity) {
            return { passed: false, reason: `Liquidity < ${config.minLiquidity} SOL` };
        }
        if (config.maxLiquidity && token.simulatedLp > config.maxLiquidity) {
            return { passed: false, reason: `Liquidity > ${config.maxLiquidity} SOL` };
        }

        // 4) On-chain distribution checks
        try {
            const mintPk = new PublicKey(token.mint);
            const { supply, decimals, mintAuthority, freezeAuthority } = await getMintInfo(connection, mintPk);
            const totalSupply = Number(supply) / Math.pow(10, decimals);

            const largest = await connection.getTokenLargestAccounts(mintPk);
            const top = largest.value[0];
            const topAmt = top.uiAmount ?? 0;
            const topPct = totalSupply > 0 ? topAmt / totalSupply : 0;
            if (topPct >= 0.1) {
                await addToBlacklist(token.creator);
                return { passed: false, reason: `Creator holds ${(topPct * 100).toFixed(1)}%` };
            }
            if (mintAuthority || freezeAuthority) {
                await addToBlacklist(token.creator);
                return { passed: false, reason: "Mint or freeze authority exists" };
            }
        } catch (err) {
            console.warn(`⚠️ Distribution check failed for ${token.mint}:`, err);
            return { passed: false, reason: "On-chain distribution check error" };
        }

        if (token.pool !== "pump" && token.pool !== "bonk") {
            try {
                // 4) On-chain distribution checks for non-curve tokens
                const mintPk = new PublicKey(token.mint);
                const { supply, mintAuthority, freezeAuthority, decimals } = await getMintInfo(connection, mintPk);
                const totalSupply = Number(supply) / 10 ** decimals;

                const largest = await connection.getTokenLargestAccounts(mintPk);
                const top = largest.value[0];
                const topAmt = top.uiAmount ?? 0;
                const topPct = totalSupply > 0 ? topAmt / totalSupply : 0;
                if (topPct >= 0.1) {
                    await addToBlacklist(token.creator);
                    return { passed: false, reason: `Creator holds ${(topPct * 100).toFixed(1)}%` };
                }
                if (mintAuthority || freezeAuthority) {
                    await addToBlacklist(token.creator);
                    return { passed: false, reason: "Mint or freeze authority exists" };
                }
            } catch (err) {
                console.warn(`⚠️ Distribution check failed for ${token.mint}:`, err);
                return { passed: false, reason: "On-chain distribution check error" };
            }
        }

        // 5) Honeypot/tax check
        if (config.honeypotCheck) {
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
        }

        // 6) Swap simulation
        const simAmount = Math.floor(0.01 * LAMPORTS_PER_SOL);
        const { passed: simPass, buyPass, sellPass } = await simulateBuySell(
            walletPubkey,
            SOL_MINT.toBase58(),
            token.mint,
            simAmount
        );
        if (!simPass) {
            return { passed: false, reason: `Swap simulation failed (buy: ${buyPass}, sell: ${sellPass})` };
        }

        // 7) Scoring & notification
        try {
            const { score, details } = await scoreToken(token);
            let summary = `✅ *Token Passed Safety Check*\nScore: ${score}/7\n`;
            for (const [k, v] of Object.entries(details)) {
                summary += `${v ? "✔️" : "❌"} ${k}\n`;
            }
            await sendTelegramMessage(summary);
        } catch (err) {
            console.warn(`⚠️ Scoring failed for ${token.mint}:`, err);
        }

        // 8) LP lock checks
        if (token.pool !== "pump" && token.pool !== "bonk") {
            try {
                const lpInfo = await connection.getAccountInfo(new PublicKey(token.lpTokenAddress));
                if (lpInfo) {
                    const balInfo = await connection.getTokenAccountBalance(
                        new PublicKey(token.lpTokenAddress)
                    );
                    if ((balInfo.value.uiAmount ?? 0) > 0) {
                        const owner = lpInfo.owner.toBase58();
                        const lockers = [
                            "GnftVbZgDfFPgG7gPfsGgiUvkzzTxkN2PmdpZRU1iPd",
                            "8crxnUjgyZQV7u9RQwnKeZKpYtVCULFki4uejFhnU3MJ",
                            "3LSL4MfHRpDn59z7pkCjXEV6d8AoPtaMauMEii8n1ZRJ",
                        ];
                        if (!lockers.includes(owner)) {
                            await addToBlacklist(token.creator);
                            return { passed: false, reason: `LP not locked (owner = ${owner})` };
                        }
                    }
                }
            } catch {
                return { passed: false, reason: "Invalid LP token address" };
            }
        }

        // 9) Final pass
        return { passed: true };
    } catch (err) {
        return { passed: false, reason: `Safety check error: ${(err as Error).message}` };
    }
}