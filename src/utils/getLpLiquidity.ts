// src/utils/getLpLiquidity.ts

import { normalizeMint } from "./normalizeMint.js";
import { getLpTokenAddress } from "./getLpTokenAddress.js";
import { connection } from "./solana.js";
import { PublicKey } from "@solana/web3.js";
import { getJupiter } from "./jupiterInstance.js";

/**
 * Get LP liquidity directly from the blockchain using Jupiter and token balances.
 */
export async function getLpLiquidityDirectly(
    tokenMint: string,
    pool: string,
    userPublicKey: PublicKey,
    baseMint: string = "So11111111111111111111111111111111111111112"
): Promise<{ lpSol: number; earlyHolders: number }> {
    try {
        const cleanedMint = normalizeMint(tokenMint, pool);
        if (!cleanedMint) throw new Error("Invalid token mint");

        const jupiter = await getJupiter(userPublicKey);
        if (!jupiter) throw new Error("Jupiter unavailable");

        const lpAddr = await getLpTokenAddress(
            jupiter,
            new PublicKey(baseMint),
            new PublicKey(cleanedMint)
        );
        if (!lpAddr) throw new Error("LP address not found");

        const balanceInfo = await connection.getTokenAccountBalance(new PublicKey(lpAddr));
        const lpSol = Number(balanceInfo.value.uiAmount ?? 0);

        return {
            lpSol,
            earlyHolders: 0, // You can update this in future with metadata if needed
        };
    } catch (err) {
        console.warn(`⚠️ Failed to get LP balance for ${tokenMint}:`, err);
        return { lpSol: 0, earlyHolders: 0 };
    }
}
