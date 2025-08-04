// src/core/retryValidator.ts

import { PublicKey } from "@solana/web3.js";
import {getLpLiquidityDirectly, getLpLiquidityFromPump} from "../utils/getLpLiquidity.js";
import { hasDirectJupiterRoute } from "../utils/hasDirectJupiterRoute.js";
import { getLpTokenAddress } from "../utils/getLpTokenAddress.js";
import { PumpToken } from "../monitor/pumpFun.js";
import { pendingTokens } from "../state/pendingTokens.js";
import { getJupiter } from "../utils/jupiterInstance.js";
import { normalizeMint } from "../utils/normalizeMint.js";

// Retry loop frequency
const INTERVAL_MS = 2500;
// Max retries per token before skipping
const MAX_ATTEMPTS = 6;
// Delay between retries (used in setTimeout)
const RETRY_DELAY_MS = 10_000;

// Track retry attempts
const retryAttempts: Record<string, number> = {};

export const startRetryValidator = async (onValidToken: (token: PumpToken) => Promise<void>) => {
    const jupiter = await getJupiter();
    if (!jupiter) {
        console.warn("⚠️ Skipping retryValidator: Jupiter unavailable");
        return;
    }

    const solMint = new PublicKey("So11111111111111111111111111111111111111112");

    setInterval(async () => {
        for (const [rawKey, token] of Array.from(pendingTokens.entries())) {
            const normalized = normalizeMint(rawKey);
            if (!normalized) {
                console.warn(`⚠️ Skipping invalid mint in retryValidator: ${rawKey}`);
                pendingTokens.delete(rawKey);
                delete retryAttempts[rawKey];
                continue;
            }

            const tokenMint = new PublicKey(normalized);
            const attempts = retryAttempts[rawKey] ?? 0;

            try {
                const [liquidity, jupRoute, lpAddr] = await Promise.all([
                    getLpLiquidityDirectly(normalized),
                    hasDirectJupiterRoute(jupiter, solMint, tokenMint),
                    getLpTokenAddress(jupiter, solMint, tokenMint),
                ]);

                const simulatedLp = liquidity?.lpSol ?? 0;
                const earlyHolders = liquidity?.earlyHolders ?? 0;
                const hasLp = simulatedLp > 0 && lpAddr && lpAddr !== "LP_unknown";

                if (hasLp) {
                    console.log(`✅ Token ${normalized} passed LP checks${jupRoute ? " with Jupiter route" : " (no Jupiter route yet)"}`);

                    const updatedToken: PumpToken = {
                        ...token,
                        mint: normalized,
                        simulatedLp,
                        earlyHolders,
                        hasJupiterRoute: jupRoute,
                        lpTokenAddress: lpAddr ?? "unknown",
                    };

                    await onValidToken(updatedToken);
                    pendingTokens.delete(rawKey);
                    delete retryAttempts[rawKey];
                } else if (attempts < MAX_ATTEMPTS) {
                    retryAttempts[rawKey] = attempts + 1;
                    console.log(`⏳ Token ${normalized} not ready (LP=${simulatedLp}, LPAddr=${lpAddr}). Retrying attempt ${attempts + 1}/${MAX_ATTEMPTS}`);
                } else {
                    console.warn(`❌ Token ${normalized} failed retry check after ${MAX_ATTEMPTS} attempts. Skipping.`);
                    pendingTokens.delete(rawKey);
                    delete retryAttempts[rawKey];
                }
            } catch (err) {
                console.warn(`⚠️ Retry validator error for ${rawKey}:`, (err as Error).message);
                // Do not delete — will retry again on next interval
            }
        }
    }, INTERVAL_MS);
};
