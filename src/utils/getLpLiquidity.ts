// src/utils/getLpLiquidity.ts
import fetch from "node-fetch";
import { normalizeMint } from "./normalizeMint.js"; // ✅ ADD THIS IMPORT
import { getLpTokenAddress } from "./getLpTokenAddress.js";
import {connection} from "./solana.js";
import {PublicKey} from "@solana/web3.js";
import { getJupiter } from "./jupiterInstance.js";

/**
 * Fetch LP liquidity and early holder estimate from pump.fun /api/runners.
 */
export async function getLpLiquidityFromPump(
    mint: string
): Promise<{ lpSol: number; earlyHolders: number } | null> {
    const cleanedMint = normalizeMint(mint); // ✅ CLEANING
    if (!cleanedMint) {
        console.warn(`❌ Invalid mint passed to getLpLiquidityFromPump: ${mint}`);
        return null;
    }

    try {
        const res = await fetch("https://pump.fun/api/runners", {
            headers: {
                "User-Agent": "Mozilla/5.0"
            }
        });

        const data = await res.json();

        if (!Array.isArray(data)) {
            throw new Error("Unexpected response format from pump.fun");
        }

        const token = data.find((t) => t.mint === cleanedMint); // ✅ MATCH WITH CLEANED MINT
        if (!token) {
            console.warn(`❌ Token ${cleanedMint} not found in /api/runners`);
            return null;
        }

        const lpSol = typeof token.virtual_sol_reserves === "number" ? token.virtual_sol_reserves : 0;

        // Best guess — estimate early holders from unique creators if available
        const earlyHolders = token.creator ? 1 : 0;

        return {
            lpSol,
            earlyHolders
        };
    } catch (err) {
        console.warn(`⚠️ Failed to fetch LP liquidity from pump.fun for ${mint}:`, err);
        return null;
    }
}

export async function getLpLiquidityDirectly(
    tokenMint: string,
    baseMint: string = "So11111111111111111111111111111111111111112"
): Promise<{ lpSol: number; earlyHolders: number }> {
    try {
        const jupiter = await getJupiter(); // ✅ get jupiter instance
        if (!jupiter) throw new Error("Jupiter unavailable");

        const lpAddr = await getLpTokenAddress(
            jupiter,
            new PublicKey(baseMint),
            new PublicKey(tokenMint)
        );
        if (!lpAddr) throw new Error("LP address not found");

        const balanceInfo = await connection.getTokenAccountBalance(new PublicKey(lpAddr));
        const lpSol = Number(balanceInfo.value.uiAmount ?? 0);
        return {
            lpSol,
            earlyHolders: 0,
        };
    } catch (err) {
        console.warn(`⚠️ Failed to get LP balance for ${tokenMint}:`, err);
        return { lpSol: 0, earlyHolders: 0 };
    }
}
