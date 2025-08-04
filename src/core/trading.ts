// src/core/trading.ts

import { computeSwap } from "../utils/jupiter.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { loadBotConfig } from "../config/index.js";
import { Jupiter, RouteInfo } from "@jup-ag/core";
import JSBI from "jsbi";
import { shouldCooldown } from "../utils/globalCooldown.js";
import { ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { logTrade } from "../utils/logger.js";
import { getJupiter } from "../utils/jupiterInstance.js";

const config = loadBotConfig();

export async function executeBuy(
    connection: Connection,
    wallet: Keypair,
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number
) {
    try {
        const jupiter = await getJupiter();
        if (!jupiter) throw new Error("❌ Jupiter instance unavailable");

        const route = await computeSwap(outputMint, amount, wallet.publicKey);
        if (!route) {
            console.log("❌ No valid route found for buy.");
            return;
        }

        const { swapTransaction } = await jupiter.exchange({
            routeInfo: route,
            userPublicKey: wallet.publicKey,
            wrapUnwrapSOL: false,
            computeUnitPriceMicroLamports: 50_000, // ✅ priority fee built-in
        });

        if (!swapTransaction) {
            console.error("❌ Failed to build swap transaction");
            return;
        }

        (swapTransaction as VersionedTransaction).sign([wallet]);
        const txid = await connection.sendTransaction(swapTransaction as VersionedTransaction);
        console.log(`✅ Buy executed: https://solscan.io/tx/${txid}`);

        await logTrade({
            type: "BUY",
            token: outputMint,
            txid,
            amount,
            pricePerToken: amount > 0 ? (amount / 1) : 0, // rough placeholder
            dryRun: false,
        });

    } catch (err) {
        console.error("❌ Buy TX failed:", err);
    }
}

export async function snipeToken(
    connection: Connection,
    wallet: Keypair,
    tokenMint: string,
    amount: number,
    dryRun: boolean
) {
    console.log(`🟢 [SNIPING] Token ${tokenMint} | Amount: ${amount} | DryRun: ${dryRun}`);

    if (dryRun) {
        console.log(`✅ [DRY-RUN] Simulated buy for ${tokenMint}`);
        return;
    }

    const SOL_MINT = "So11111111111111111111111111111111111111112";
    const slippageBps = config.slippage * 100;

    try {
        await executeBuy(connection, wallet, SOL_MINT, tokenMint, amount, slippageBps);
    } catch (err) {
        console.error(`❌ Buy failed for ${tokenMint}:`, err);
    }
}

export async function sellToken(
    connection: Connection,
    wallet: Keypair,
    tokenMint: string,
    amount: number,
    dryRun: boolean
) {
    console.log(`🔴 [SELLING] Token ${tokenMint} | Amount: ${amount} | DryRun: ${dryRun}`);

    if (dryRun) {
        console.log(`✅ [DRY-RUN] Simulated sell for ${tokenMint}`);
        return;
    }

    const SOL_MINT = "So11111111111111111111111111111111111111112";
    const slippageBps = config.slippage * 100;

    try {
        await executeBuy(connection, wallet, tokenMint, SOL_MINT, amount, slippageBps);
    } catch (err) {
        console.error(`❌ Sell failed for ${tokenMint}:`, err);
    }
}

export async function getCurrentPriceViaJupiter(
    mint: string,
    amount: number,
    wallet: Keypair
): Promise<{ price: number; liquidity: number } | null> {
    if (shouldCooldown()) {
        console.warn(`🧊 Skipping price check for ${mint} — global cooldown active`);
        return null;
    }

    try {
        const route = await computeSwap(mint, amount, wallet.publicKey);
        if (!route || !route.outAmount || !route.inAmount) return null;

        const outAmount = Number(route.outAmount.toString()) / 1e9;
        const inAmount = Number(route.inAmount.toString()) / 1e9;
        const price = outAmount / inAmount;
        const liquidity = Math.min(inAmount, outAmount);

        return { price, liquidity };
    } catch (e) {
        console.error(`❌ Failed to get price for ${mint}:`, e);
        return null;
    }
}
