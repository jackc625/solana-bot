// src/utils/getLpLiquidity.ts
// Thin wrapper to the unified Jupiter helper. Kept for backward compatibility.
// Prefer using computeSwap/getCurrentPriceViaJupiter or getLpLiquidity from utils/jupiter.ts directly.

import { PublicKey } from "@solana/web3.js";
import { getSharedJupiter, getLpLiquidity as jupGetLpLiquidity } from "./jupiter.js";
import { getLpLiquidityHttp } from "./jupiterHttp.js";

/**
 * Get LP liquidity via a tiny route simulation using the HTTP API.
 * Returns a compatible shape with previous callers.
 */
export async function getLpLiquidityDirectly(
    tokenMint: string,
    _pool: string,
    userPublicKey: PublicKey,
    baseMint: string = "So11111111111111111111111111111111111111112"
): Promise<{ lpSol: number; earlyHolders: number }> {
    try {
        // Use HTTP API instead of problematic SDK
        const lp = await getLpLiquidityHttp(baseMint, tokenMint, 0.005);
        return { lpSol: lp ?? 0, earlyHolders: 0 };
    } catch (err) {
        console.warn(`⚠️ getLpLiquidityDirectly wrapper failed for ${tokenMint}:`, (err as any)?.message || err);
        return { lpSol: 0, earlyHolders: 0 };
    }

}
