// src/core/retryValidator.ts

import { PublicKey } from "@solana/web3.js";
import { getLpLiquidity } from "../utils/getLpLiquidity.js";
import { hasDirectJupiterRoute } from "../utils/hasDirectJupiterRoute.js";
import { getLpTokenAddress } from "../utils/getLpTokenAddress.js";
import { PumpToken } from "../monitor/pumpFun.js";
import { pendingTokens } from "../state/pendingTokens.js";
import { getJupiter } from "../utils/jupiterInstance.js";

// Frequency in ms to retry validation
const INTERVAL_MS = 2500;

export const startRetryValidator = async (onValidToken: (token: PumpToken) => Promise<void>) => {
    const jupiter = await getJupiter();
    const solMint = new PublicKey("So11111111111111111111111111111111111111112");

    setInterval(async () => {
        for (const [mint, token] of pendingTokens.entries()) {
            try {
                const tokenMint = new PublicKey(mint);

                const [liquidity, jupRoute, lpAddr] = await Promise.all([
                    getLpLiquidity(mint),
                    hasDirectJupiterRoute(jupiter, solMint, tokenMint),
                    getLpTokenAddress(jupiter, solMint, tokenMint),
                ]);

                const simulatedLp = liquidity?.lpSol ?? 0;
                const earlyHolders = liquidity?.earlyHolders ?? 0;

                const hasLp = simulatedLp > 0 && lpAddr !== null;

                if (hasLp) {
                    console.log(`✅ Token ${mint} passed LP checks${jupRoute ? " with Jupiter route" : " (no Jupiter route yet)"}`);

                    const updatedToken: PumpToken = {
                        ...token,
                        simulatedLp,
                        earlyHolders,
                        hasJupiterRoute: jupRoute,
                        lpTokenAddress: lpAddr ?? "unknown",
                    };

                    await onValidToken(updatedToken);
                } else {
                    console.warn(`❌ Token ${mint} failed retry check (LP=${simulatedLp}, LPAddr=${lpAddr}). Skipping.`);
                }

                pendingTokens.delete(mint);
            } catch (err) {
                console.warn(`⚠️ Retry validator error for ${mint}:`, (err as Error).message);
                // Leave token in map for future retries
            }
        }
    }, INTERVAL_MS);
};
