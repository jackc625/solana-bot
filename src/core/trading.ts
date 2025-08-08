// src/core/trading.ts

import { computeSwap } from "../utils/jupiter.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { loadBotConfig } from "../config/index.js";
import { Jupiter, RouteInfo } from "@jup-ag/core";
import JSBIImport from "jsbi";
import { shouldCooldown } from "../utils/globalCooldown.js";
import { ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { logTrade } from "../utils/logger.js";
import { getJupiter } from "../utils/jupiterInstance.js";
import { loadWallet } from "../utils/solana.js";
import {sendPumpTrade} from "../utils/pumpTrade.js";

const JSBI: any = JSBIImport;

const config = loadBotConfig();
const wallet = loadWallet();
if (!wallet) throw new Error("Wallet not loaded");

export async function executeBuy(
    connection: Connection,
    wallet: Keypair,
    _inputMint: string, // ignored
    tokenMint: string,
    amount: number,
    _slippageBps: number // ignored
) {
    try {
        const txid = await sendPumpTrade({
            connection,
            wallet,
            mint: tokenMint,
            amount,
            action: "buy",
            denominatedInSol: true,
            slippage: config.slippage,
            priorityFee: config.priorityFee ?? 0.00001,
            pool: "auto"
        });

        if (!txid) {
            console.error("❌ Buy TX failed");
            return;
        }

        console.log(`✅ Buy executed: https://solscan.io/tx/${txid}`);

        await logTrade({
            type: "BUY",
            token: tokenMint,
            txid,
            amount,
            pricePerToken: 0, // optional: update with real price if available
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

    try {
        await executeBuy(connection, wallet, "", tokenMint, amount, 0); // inputMint/slippageBps unused now
    } catch (err) {
        console.error(`❌ Buy failed for ${tokenMint}:`, err);
    }
}

export async function sellToken(
    connection: Connection,
    wallet: Keypair,
    tokenMint: string,
    amount: number,
    dryRun: boolean,
    priorityFee: number,
    pool: string
) {
    console.log(`🔴 [SELLING] Token ${tokenMint} | Amount: ${amount} | DryRun: ${dryRun}`);

    if (dryRun) {
        console.log(`✅ [DRY-RUN] Simulated sell for ${tokenMint}`);
        return;
    }

    try {
        const txid = await sendPumpTrade({
            connection,
            wallet,
            mint: tokenMint,
            amount,
            action: "sell",
            denominatedInSol: false, // selling tokens, not SOL
            slippage: config.slippage,
            priorityFee,
            pool
        });

        if (!txid) {
            console.error("❌ Sell TX failed");
            return;
        }

        console.log(`✅ Sell executed: https://solscan.io/tx/${txid}`);

        await logTrade({
            type: "SELL",
            token: tokenMint,
            txid,
            amount,
            pricePerToken: 0, // optionally update later
            dryRun: false,
        });
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
