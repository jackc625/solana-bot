// src/core/safety.ts
// Hardened safety checks that avoid relying on a fabricated LP token address.

import { Connection, PublicKey } from "@solana/web3.js";
import { MintLayout } from "@solana/spl-token";
import JSBIImport from "jsbi";
import { z } from "zod";
import { PumpToken } from "../types/PumpToken.js";
import { addToBlacklist } from "../utils/blacklist.js";
import { getSharedJupiter, simulateBuySell, enhancedHoneypotDetection } from "../utils/jupiter.js";
import { loadBotConfig } from "../config/index.js";
import { verifyTokenLpLock } from "../utils/lpLockVerification.js";
import emergencyCircuitBreaker from "./emergencyCircuitBreaker.js";
import liquidityAnalyzer from "../utils/liquidityAnalysis.js";
import socialVerificationService from "../utils/socialVerification.js";
import metricsCollector from "@features/telemetry/metricsCollector.js";

const JSBI: any = JSBIImport;

// --- Config schema & types
const ConfigSchema = z.object({
    minLiquidity: z.number().nonnegative(),
    maxLiquidity: z.number().nonnegative().optional(),
    maxTaxPercent: z.number().min(0).max(100).optional(),
    honeypotCheck: z.boolean().default(true).optional(),
    honeypotSellTaxThreshold: z.number().min(0).max(100).default(95).optional(),
    enhancedHoneypotDetection: z.boolean().default(true).optional(),
    honeypotTestAmounts: z.array(z.number().positive()).default([0.001, 0.01, 0.1]).optional(),
    lpLockCheck: z.boolean().default(true).optional(),
    lpLockMinPercentage: z.number().min(0).max(100).default(80).optional(),
    lpLockMinDurationHours: z.number().min(0).default(24).optional(),
    acceptBurnedLp: z.boolean().default(true).optional(),
    acceptVestingLock: z.boolean().default(true).optional(),
    socialVerificationCheck: z.boolean().default(true).optional(),
    minSocialScore: z.number().min(0).max(10).default(2).optional(),
    requireSocialPresence: z.boolean().default(false).optional(),
    blockBlacklistedTokens: z.boolean().default(true).optional()
});

type Config = z.infer<typeof ConfigSchema>;

export interface SafetyResult {
    passed: boolean;
    reason?: string;
}

// Dedup cache to avoid re-checking same mint too often
const evaluatedTokens = new Map<string, number>();
const SAFETY_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
    const now = Date.now();
    for (const [mint, ts] of evaluatedTokens.entries()) {
        if (now - ts > SAFETY_TTL_MS) evaluatedTokens.delete(mint);
    }
}, 60_000);

async function getMintInfo(
    connection: Connection,
    mintAddress: PublicKey
): Promise<{
    supply: bigint;
    decimals: number;
    mintAuthority: PublicKey | null;
    freezeAuthority: PublicKey | null;
}> {
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

export async function checkTokenSafety(
    token: PumpToken,
    rawConfig: unknown,
    connection: Connection,
    walletPubkey: PublicKey
): Promise<SafetyResult> {
    try {
        const config = ConfigSchema.parse(rawConfig);

        // 1) Deduplicate
        if (evaluatedTokens.has(token.mint)) return { passed: true };
        evaluatedTokens.set(token.mint, Date.now());
        
        // Record safety check start
        metricsCollector.recordTokenValidation('safety_check', 'pass');

        // 2) SAFETY-006: Enhanced liquidity validation with proper depth analysis
        if (!token.simulatedLp || token.simulatedLp < config.minLiquidity) {
            metricsCollector.recordSafetyCheck('liquidity', 'fail');
            return { passed: false, reason: `Liquidity < ${config.minLiquidity} SOL` };
        }
        metricsCollector.recordSafetyCheck('liquidity', 'pass');
        if (config.maxLiquidity && token.simulatedLp > config.maxLiquidity) {
            return { passed: false, reason: `Liquidity > ${config.maxLiquidity} SOL` };
        }
        
        // SAFETY-005: Detect suspiciously high liquidity that might indicate manipulation
        if (token.simulatedLp > (config.maxLiquidity || 100) * 10) {
            emergencyCircuitBreaker.recordNetworkAnomaly(`Extremely high liquidity detected: ${token.simulatedLp} SOL`);
            return { passed: false, reason: `Suspicious liquidity level: ${token.simulatedLp} SOL` };
        }
        
        // SAFETY-006: Additional liquidity depth validation for non-pump pools
        if (token.pool !== "pump" && token.pool !== "bonk") {
            try {
                const mintPk = new PublicKey(token.mint);
                const liquidityAnalysis = await liquidityAnalyzer.analyzeLiquidityDepth(
                    token.mint,
                    connection,
                    walletPubkey,
                    Math.max(token.simulatedLp, 0.1)
                );
                
                // Validate actual liquidity meets requirements
                if (liquidityAnalysis.actualLiquidity < config.minLiquidity) {
                    return { 
                        passed: false, 
                        reason: `Actual liquidity insufficient: ${liquidityAnalysis.actualLiquidity.toFixed(4)} SOL (min: ${config.minLiquidity})` 
                    };
                }
                
                // Check liquidity confidence and warnings
                if (liquidityAnalysis.recommendation.confidence < 0.5) {
                    return { 
                        passed: false, 
                        reason: `Low liquidity confidence: ${(liquidityAnalysis.recommendation.confidence * 100).toFixed(1)}%` 
                    };
                }
                
                // Check for critical liquidity warnings
                const criticalWarnings = liquidityAnalysis.recommendation.warnings.filter(w => 
                    w.includes('Very low liquidity') || w.includes('Extremely limited')
                );
                if (criticalWarnings.length > 0) {
                    return { 
                        passed: false, 
                        reason: `Critical liquidity issue: ${criticalWarnings[0]}` 
                    };
                }
                
                // Validate route fragmentation
                if (liquidityAnalysis.routeAnalysis.routeCount === 0) {
                    return { 
                        passed: false, 
                        reason: 'No trading routes available' 
                    };
                }
                
                console.log(`✅ Enhanced liquidity validation passed for ${token.mint}:`, {
                    actualLiquidity: liquidityAnalysis.actualLiquidity.toFixed(4),
                    confidence: (liquidityAnalysis.recommendation.confidence * 100).toFixed(1),
                    maxSafeSize: liquidityAnalysis.recommendation.maxSafeSize.toFixed(4),
                    routeCount: liquidityAnalysis.routeAnalysis.routeCount
                });
                
            } catch (err) {
                console.warn(`⚠️ Enhanced liquidity validation failed for ${token.mint}:`, err);
                // Non-fatal - fall back to basic validation
            }
        }

        // 3) Non-curve on-chain distribution checks
        if (token.pool !== "pump" && token.pool !== "bonk") {
            try {
                const mintPk = new PublicKey(token.mint);
                const { supply, mintAuthority, freezeAuthority, decimals } = await getMintInfo(connection, mintPk);
                const totalSupply = Number(supply) / 10 ** decimals;

                const largest = await connection.getTokenLargestAccounts(mintPk);
                const top = largest.value[0];
                const topAmt = top?.uiAmount ?? 0;
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

            // 3.5) LP lock verification for non-pump pools
            if (config.lpLockCheck) {
                try {
                    const botConfig = loadBotConfig();
                    console.log(`🔐 Checking LP lock status for ${token.mint}...`);
                    
                    // Create LP lock config from bot settings
                    const lpLockConfig = {
                        minLockPercentage: config.lpLockMinPercentage || botConfig.lpLockMinPercentage || 80,
                        minLockDurationHours: config.lpLockMinDurationHours || botConfig.lpLockMinDurationHours || 24,
                        acceptBurnedLp: config.acceptBurnedLp ?? botConfig.acceptBurnedLp ?? true,
                        acceptVestingLock: config.acceptVestingLock ?? botConfig.acceptVestingLock ?? true
                    };

                    // Try to get LP mint if available
                    let lpMintPubkey: PublicKey | undefined;
                    if (token.lpTokenAddress && token.lpTokenAddress !== "LP_unknown") {
                        try {
                            lpMintPubkey = new PublicKey(token.lpTokenAddress);
                        } catch (err) {
                            console.warn(`⚠️ Invalid LP token address: ${token.lpTokenAddress}`);
                        }
                    }

                    const tokenMintPk = new PublicKey(token.mint);
                    const lpLockResult = await verifyTokenLpLock(
                        connection,
                        tokenMintPk,
                        { lpMint: lpMintPubkey },
                        lpLockConfig
                    );

                    if (!lpLockResult.isLocked) {
                        await addToBlacklist(token.creator);
                        return {
                            passed: false,
                            reason: `LP lock insufficient: ${lpLockResult.details}`
                        };
                    }

                    console.log(`✅ LP lock verification passed for ${token.mint}: ${lpLockResult.details}`);

                } catch (err) {
                    console.warn(`⚠️ LP lock verification failed for ${token.mint}:`, err);
                    // LP lock verification failure is treated as non-fatal by default
                    // Could be made fatal by adding a config option
                    const botConfig = loadBotConfig();
                    if (botConfig.lpLockCheck === true) {
                        return {
                            passed: false,
                            reason: `LP lock verification error: ${(err as Error)?.message || err}`
                        };
                    }
                }
            }
        }

        // 4) SAFETY-007: Social verification and reputation checks
        try {
            const socialResult = await socialVerificationService.verifySocialPresence(token);
            
            // Block tokens with critical social risk flags
            const criticalFlags = socialResult.details.riskFlags.filter(flag => 
                flag.includes('BLACKLISTED') || 
                (flag.includes('NO_SOCIAL_PRESENCE') && config.requireSocialPresence)
            );
            
            if (criticalFlags.length > 0) {
                await addToBlacklist(token.creator);
                return {
                    passed: false,
                    reason: `Social verification failed: ${criticalFlags.join(', ')}`
                };
            }
            
            // Warn for tokens with low social scores but don't block
            if (socialResult.score < 2 && socialResult.details.riskFlags.length > 0) {
                console.warn(`⚠️ Low social score for ${token.mint}:`, {
                    score: socialResult.score,
                    riskFlags: socialResult.details.riskFlags
                });
            }
            
            console.log(`✅ Social verification passed for ${token.mint}:`, {
                verified: socialResult.verified,
                score: socialResult.score,
                trustStatus: socialResult.details.trustedListStatus,
                hasTwitter: socialResult.details.hasTwitter,
                hasWebsite: socialResult.details.hasWebsite
            });
            
        } catch (err) {
            console.warn(`⚠️ Social verification failed for ${token.mint}:`, err);
            // Non-fatal - continue with other checks
        }
        
        // 5) Enhanced honeypot/sellability simulation
        if (config.honeypotCheck) {
            try {
                const botConfig = loadBotConfig();
                const mintPk = new PublicKey(token.mint);
                
                if (config.enhancedHoneypotDetection) {
                    // Use enhanced detection with multiple test amounts and realistic position sizes
                    let testAmounts = config.honeypotTestAmounts || [0.001, 0.01, 0.1];
                    
                    // SAFETY-006: Add realistic position size based on liquidity analysis
                    try {
                        const quickAnalysis = await liquidityAnalyzer.analyzeLiquidityDepth(
                            token.mint,
                            connection,
                            walletPubkey,
                            0.1 // Quick analysis up to 0.1 SOL
                        );
                        
                        // Use max safe size as additional test amount if reasonable
                        if (quickAnalysis.recommendation.maxSafeSize >= 0.001 && 
                            quickAnalysis.recommendation.maxSafeSize <= 0.1 &&
                            !testAmounts.includes(quickAnalysis.recommendation.maxSafeSize)) {
                            testAmounts = [...testAmounts, quickAnalysis.recommendation.maxSafeSize];
                        }
                    } catch (err) {
                        // Fallback to config-based realistic amounts
                        if (botConfig.buyAmounts) {
                            const scoreKeys = Object.keys(botConfig.buyAmounts);
                            if (scoreKeys.length > 0) {
                                const midScoreKey = scoreKeys[Math.floor(scoreKeys.length / 2)];
                                const realisticAmount = botConfig.buyAmounts[midScoreKey];
                                if (!testAmounts.includes(realisticAmount)) {
                                    testAmounts = [...testAmounts, realisticAmount];
                                }
                            }
                        }
                    }

                    const honeypotResult = await enhancedHoneypotDetection(
                        mintPk,
                        walletPubkey,
                        testAmounts,
                        config.honeypotSellTaxThreshold || 95
                    );

                    if (!honeypotResult.passed) {
                        await addToBlacklist(token.creator);
                        return { 
                            passed: false, 
                            reason: honeypotResult.reason || "Enhanced honeypot detection failed"
                        };
                    }

                    // Log successful honeypot check with details
                    if (honeypotResult.taxAnalysis) {
                        console.log(`✅ Enhanced honeypot check passed for ${token.mint}:`, {
                            sellTax: honeypotResult.taxAnalysis.sellTaxPercent.toFixed(2),
                            testAmounts: testAmounts.length,
                            avgValueRetention: honeypotResult.multiAmountResults 
                                ? (honeypotResult.multiAmountResults.reduce((sum, r) => sum + r.valueRetained, 0) / honeypotResult.multiAmountResults.length).toFixed(2)
                                : 'N/A'
                        });
                    }
                } else {
                    // Fallback to legacy detection
                    const rpcEndpoint = (connection as any).rpcEndpoint as string;
                    const sim = await simulateBuySell(
                        mintPk,
                        rpcEndpoint,
                        walletPubkey.toBase58(),
                        0.005
                    );
                    
                    if (sim && !sim.sellPass) {
                        await addToBlacklist(token.creator);
                        return { passed: false, reason: "Honeypot suspected (sell sim failed)" };
                    }
                }
            } catch (err) {
                console.warn(`⚠️ Honeypot simulation failed for ${token.mint}:`, err);
                // Non-fatal; allow pass-through unless error indicates definite honeypot
                const errorMsg = (err as Error)?.message || err?.toString() || "";
                if (errorMsg.includes("sell simulation failed") || errorMsg.includes("Excessive sell tax")) {
                    return { passed: false, reason: `Honeypot detection error: ${errorMsg}` };
                }
            }
        }

        // 5) Final pass
        return { passed: true };
    } catch (err) {
        return { passed: false, reason: `Safety check error: ${(err as Error).message}` };
    }
}
