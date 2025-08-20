// src/core/retryValidator.ts
// Periodically revisits pending tokens to see if they're ready to trade,
// using real route/depth plus a stability guard (2 consecutive stable quotes)
// before handing off for full processing.

import { PublicKey } from "@solana/web3.js";
import { hasDirectJupiterRoute } from "../utils/hasDirectJupiterRoute.js";
import { PumpToken } from "../types/PumpToken.js";
import { pendingTokens } from "../state/pendingTokens.js";
import { normalizeMint } from "../utils/normalizeMint.js";
import { loadWallet } from "../utils/solana.js";
import { getCurrentPriceViaJupiter } from "./trading.js";
import { loadBotConfig } from "../config/index.js";
import { getSharedJupiter } from "../utils/jupiter.js";
import liquidityAnalyzer from "../utils/liquidityAnalysis.js";

// Retry loop frequency
const INTERVAL_MS = 2500;
// Max retries per token before skipping (only counts when route/depth are NOT ready)
const MAX_ATTEMPTS = 6;
// Stability tolerances & requirement
const PRICE_TOL_PCT = 0.05;   // 5% price drift allowed between consecutive quotes
const DEPTH_TOL_PCT = 0.25;   // 25% depth drift allowed between consecutive quotes
const STABLE_REQUIRED = 2;    // need 2 consecutive stable quotes

// Track attempts per rawKey
const retryAttempts: Record<string, number> = {};

// Per-mint quote stability cache
type StableState = { lastPrice: number | null; lastDepth: number | null; stableCount: number };
const stability = new Map<string, StableState>();

export const startRetryValidator = async (onValidToken: (token: PumpToken) => Promise<void>) => {
    const wallet = loadWallet();
    if (!wallet) {
        console.warn("⚠️ Monitor-only mode: retry validator disabled (no wallet)");
        return;
    }

    const config = loadBotConfig();
    const solMint = new PublicKey("So11111111111111111111111111111111111111112");

    // Cache Jupiter instance once initialized
    let jupiter: Awaited<ReturnType<typeof getSharedJupiter>> | null = null;

    setInterval(async () => {
        for (const [rawKey, token] of Array.from(pendingTokens.entries())) {
            try {
                // Curve pools (pump/bonk) are considered ready immediately
                if (token.pool === "pump" || token.pool === "bonk") {
                    await onValidToken(token);
                    pendingTokens.delete(rawKey);
                    delete retryAttempts[rawKey];
                    stability.delete(rawKey);
                    continue;
                }

                const normalized = normalizeMint(rawKey, token.pool);
                if (!normalized) {
                    console.warn(`⚠️ Skipping invalid mint in retryValidator: ${rawKey}`);
                    pendingTokens.delete(rawKey);
                    delete retryAttempts[rawKey];
                    stability.delete(rawKey);
                    continue;
                }

                const tokenMint = new PublicKey(normalized);
                const attempts = retryAttempts[rawKey] ?? 0;

                // Initialize Jupiter lazily only when we need it
                if (!jupiter) {
                    try {
                        jupiter = await getSharedJupiter(wallet.publicKey);
                        console.log("✅ Jupiter initialized successfully in retry validator");
                    } catch (err: any) {
                        console.warn("⚠️ Jupiter initialization failed in retry validator:", err?.message || err);
                        // Reset attempts counter to avoid spamming for this specific Jupiter failure
                        retryAttempts[rawKey] = (retryAttempts[rawKey] ?? 0) + 1;
                        if (retryAttempts[rawKey] >= MAX_ATTEMPTS) {
                            console.warn(`⚠️ Removing token ${rawKey} due to Jupiter init failures`);
                            pendingTokens.delete(rawKey);
                            delete retryAttempts[rawKey];
                            stability.delete(rawKey);
                        }
                        // Skip this cycle and try again later
                        continue;
                    }
                }

                // 1) Check for a direct Jupiter route
                let jupRoute = false;
                try {
                    jupRoute = await hasDirectJupiterRoute(jupiter, solMint, tokenMint);
                } catch (err: any) {
                    console.warn(`⚠️ Jupiter route check failed for ${normalized}:`, err?.message || err);
                    if (err?.message?.includes("Assertion failed")) {
                        // Reset Jupiter instance on assertion failures
                        jupiter = null;
                        console.warn("⚠️ Jupiter instance reset due to assertion failure");
                    }
                    jupRoute = false;
                }

                // 2) SAFETY-006: Enhanced liquidity assessment with proper depth analysis
                let priceInfo = null;
                try {
                    priceInfo = await getCurrentPriceViaJupiter(normalized, 0.005, wallet);
                } catch (err: any) {
                    console.warn(`⚠️ Jupiter price check failed for ${normalized}:`, err?.message || err);
                    if (err?.message?.includes("Assertion failed")) {
                        // Reset Jupiter instance on assertion failures
                        jupiter = null;
                        console.warn("⚠️ Jupiter instance reset due to assertion failure");
                    }
                }
                
                // SAFETY-006: Use actual liquidity analysis instead of probe amount
                const currDepth = priceInfo?.liquidity ?? 0;
                const currPrice = priceInfo?.price ?? null;
                const priceImpact = priceInfo?.priceImpact;
                const recommendation = priceInfo?.recommendation;
                
                // Additional validation for high price impact
                if (priceImpact && priceImpact > 10) {
                    console.warn(`⚠️ High price impact detected for ${normalized}: ${priceImpact.toFixed(2)}%`);
                }
                
                // Validate recommendation warnings
                if (recommendation && recommendation.warnings.length > 0) {
                    console.warn(`⚠️ Liquidity warnings for ${normalized}:`, recommendation.warnings);
                }

                // 3) Update stability counters
                const prev = stability.get(rawKey) ?? { lastPrice: null, lastDepth: null, stableCount: 0 };
                let nextStable = 0;

                if (jupRoute && currDepth > 0 && currPrice && prev.lastPrice && prev.lastDepth) {
                    const priceDrift = Math.abs(currPrice - prev.lastPrice) / prev.lastPrice;
                    const depthDrift = Math.abs(currDepth - prev.lastDepth) / Math.max(prev.lastDepth, 1e-9);
                    const isStable = priceDrift <= PRICE_TOL_PCT && depthDrift <= DEPTH_TOL_PCT;
                    nextStable = isStable ? prev.stableCount + 1 : 0;
                } else {
                    // Not enough data for stability yet
                    nextStable = 0;
                }

                stability.set(rawKey, { lastPrice: currPrice, lastDepth: currDepth, stableCount: nextStable });

                // 4) Readiness checks
                const minLiq = config.minLiquidity ?? 1;
                const hasDepth = jupRoute && currDepth >= minLiq;
                const stableEnough = nextStable >= STABLE_REQUIRED;

                if (hasDepth && stableEnough) {
                    // SAFETY-006: Enhanced logging with liquidity analysis details
                    const logData = {
                        depth: currDepth.toFixed(4),
                        stability: `${nextStable}/${STABLE_REQUIRED}`,
                        priceImpact: priceImpact ? `${priceImpact.toFixed(2)}%` : 'N/A',
                        riskLevel: recommendation?.riskLevel || 'UNKNOWN'
                    };
                    
                    console.log(
                        `✅ Token ${normalized} ready - Depth: ${logData.depth} SOL, ` +
                        `Stability: ${logData.stability}, Impact: ${logData.priceImpact}, ` +
                        `Risk: ${logData.riskLevel}`
                    );

                    const updatedToken: PumpToken = {
                        ...token,
                        mint: normalized,
                        simulatedLp: currDepth,
                        hasJupiterRoute: jupRoute,
                        lpTokenAddress: "LP_unknown",
                        earlyHolders: 0,
                    };

                    // delete first to avoid double processing
                    if (pendingTokens.has(rawKey)) pendingTokens.delete(rawKey);
                    delete retryAttempts[rawKey];
                    stability.delete(rawKey);
                    await onValidToken(updatedToken);
                    continue;
                }

                // If route/depth present but not yet stable, wait WITHOUT burning attempts
                if (hasDepth && !stableEnough) {
                    console.log(
                        `⏳ Token ${normalized} waiting stability (${nextStable}/${STABLE_REQUIRED}) ` +
                        `(price=${currPrice ?? "?"}, depth=${currDepth.toFixed(4)} SOL)`
                    );
                    continue;
                }

                // Else, route/depth NOT ready: use retry attempts
                if (attempts < MAX_ATTEMPTS) {
                    retryAttempts[rawKey] = attempts + 1;
                    console.log(
                        `⏳ Token ${normalized} not ready (route=${jupRoute}, depth=${currDepth.toFixed(4)}<${minLiq}). ` +
                        `Retry ${attempts + 1}/${MAX_ATTEMPTS}`
                    );
                } else {
                    console.warn(
                        `❌ Token ${normalized} failed retry check after ${MAX_ATTEMPTS} attempts. Skipping.`
                    );
                    pendingTokens.delete(rawKey);
                    delete retryAttempts[rawKey];
                    stability.delete(rawKey);
                }
            } catch (err: any) {
                console.warn(
                    `⚠️ Retry validator error for ${rawKey}:`,
                    err?.message || err
                );
                // Do not delete — will retry again on next interval
            }
        }
    }, INTERVAL_MS);
};
