// src/utils/getLpLiquidity.ts
import fetch from "node-fetch";

export async function getLpLiquidity(mint: string): Promise<{ lpSol: number; earlyHolders: number } | null> {
    try {
        const res = await fetch(`https://pump.fun/coin/${mint}`);
        const text = await res.text();

        // Sometimes HTML is returned if token doesn't exist
        if (!text.startsWith("{")) {
            throw new Error(`Invalid response from pump.fun for ${mint}`);
        }

        const data = JSON.parse(text);

        const rawLp = data?.bondingCurve?.vSolInBondingCurve;
        const lpSol = typeof rawLp === "string" ? parseFloat(rawLp) : 0;

        const earlyHolders = Array.isArray(data?.holders) ? data.holders.length : 0;

        return {
            lpSol: isNaN(lpSol) ? 0 : lpSol,
            earlyHolders,
        };
    } catch (err) {
        if (err instanceof Error) {
            console.warn(`⚠️ Failed to fetch LP liquidity for ${mint}:`, err.message);
        } else {
            console.warn(`⚠️ Failed to fetch LP liquidity for ${mint}:`, err);
        }
        return null;
    }
}
