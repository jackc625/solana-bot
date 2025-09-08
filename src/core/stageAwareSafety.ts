// src/core/stageAwareSafety.ts
// Stage-aware safety checks that only run appropriate validations per token lifecycle stage

import { Connection, PublicKey } from "@solana/web3.js";
import { PumpToken } from "../types/PumpToken.js";
import { 
    TokenCandidate, 
    TokenStage, 
    StageTransitionResult, 
    SafetyCheckConfig, 
    DEFAULT_STAGE_CONFIG,
    FAILURE_REASONS,
    FailureReason 
} from "../types/TokenStage.js";
import { loadBotConfig } from "../config/index.js";
import metricsCollector from "../utils/metricsCollector.js";
import logger from "../utils/logger.js";
import { hasDirectJupiterRouteHttp } from "../utils/jupiterHttp.js";
import { getCurrentPriceViaJupiter } from "./trading.js";
import { checkTokenSafety as runFullSafetyChecks } from "./safety.js";
import { loadBlacklist } from "../utils/blacklist.js";

// Stage-specific safety check implementations
export class StageAwareSafetyChecker {
    private config: SafetyCheckConfig;
    private botConfig: any;
    
    // Creator behavior tracking
    private creatorBehaviorCache = new Map<string, {
        lastActivity: number;
        tokenCount: number;
        suspiciousPatterns: string[];
        riskScore: number;
    }>();
    
    // Velocity tracking for bonded tokens
    private velocityCache = new Map<string, {
        firstSeen: number;
        buyEvents: Array<{ timestamp: number; wallet: string; amount: number }>;
        uniqueWallets: Set<string>;
        totalVolume: number;
    }>();

    constructor(config?: Partial<SafetyCheckConfig>) {
        this.config = { ...DEFAULT_STAGE_CONFIG, ...config };
        this.refreshBotConfig();
    }

    private refreshBotConfig() {
        try {
            this.botConfig = loadBotConfig();
            // Update stage-aware config from bot config if available
            if (this.botConfig.stageAwarePipeline) {
                const pipelineConfig = this.botConfig.stageAwarePipeline;
                if (pipelineConfig.preBond) {
                    this.config.preBond = { ...this.config.preBond, ...pipelineConfig.preBond };
                }
                if (pipelineConfig.bondedOnPump) {
                    this.config.bondedOnPump = { ...this.config.bondedOnPump, ...pipelineConfig.bondedOnPump };
                }
                if (pipelineConfig.raydiumListed) {
                    this.config.raydiumListed = { ...this.config.raydiumListed, ...pipelineConfig.raydiumListed };
                }
            }
        } catch (error) {
            console.warn('⚠️ Failed to load bot config for stage-aware safety, using defaults');
        }
    }

    /**
     * PRE_BOND stage checks - only run fast, off-chain-ish validations
     * No Jupiter routes, LP depth, or on-chain state checks
     */
    async checkPreBond(candidate: TokenCandidate): Promise<StageTransitionResult> {
        const reasons: FailureReason[] = [];
        
        try {
            if (!this.config.preBond.enabled) {
                return { success: true, newStage: 'BONDED_ON_PUMP' };
            }

            // 1) Basic token name/symbol validation
            const tokenName = candidate.mint; // This would need to be enhanced with actual metadata
            if (tokenName.length < this.config.preBond.minNameLength || 
                tokenName.length > this.config.preBond.maxNameLength) {
                reasons.push(FAILURE_REASONS.INVALID_NAME);
            }

            // 2) Creator wallet history and age check
            if (this.config.preBond.checkCreatorHistory) {
                const creatorAge = Date.now() - candidate.createdAt;
                if (creatorAge < this.config.preBond.minCreatorAge) {
                    reasons.push(FAILURE_REASONS.CREATOR_TOO_NEW);
                }

                // Creator blacklist/reputation check
                const blacklist = await loadBlacklist();
                if (blacklist.has(candidate.creator.toLowerCase())) {
                    reasons.push(FAILURE_REASONS.CREATOR_BLACKLISTED);
                }
                
                // Check creator behavior patterns
                const creatorBehavior = this.analyzeCreatorBehavior(candidate.creator);
                if (creatorBehavior.riskScore > 0.7) {
                    reasons.push(FAILURE_REASONS.CREATOR_BLACKLISTED);
                }
            }

            // 3) Time window check (skip dead hours)
            if (this.config.preBond.skipDeadHours) {
                const hour = new Date().getUTCHours();
                // Skip 2-8 AM UTC (dead hours)
                if (hour >= 2 && hour <= 8) {
                    reasons.push(FAILURE_REASONS.DEAD_HOURS);
                }
            }

            // 4) Calculate pre-bond score based on available data
            const preBondScore = this.calculatePreBondScore(candidate);
            candidate.preBondScore = preBondScore;

            const minScore = this.botConfig.scoreThreshold || 4;
            if (preBondScore < minScore) {
                reasons.push(FAILURE_REASONS.LOW_PREBOND_SCORE);
            }

            // Record metrics (using existing safety check types)
            metricsCollector.recordSafetyCheck('social', reasons.includes(FAILURE_REASONS.INVALID_NAME) ? 'fail' : 'pass');
            metricsCollector.recordSafetyCheck('authority', reasons.includes(FAILURE_REASONS.CREATOR_TOO_NEW) ? 'fail' : 'pass');
            metricsCollector.recordSafetyCheck('social', reasons.includes(FAILURE_REASONS.DEAD_HOURS) ? 'fail' : 'pass');
            metricsCollector.recordSafetyCheck('social', reasons.includes(FAILURE_REASONS.LOW_PREBOND_SCORE) ? 'fail' : 'pass');

            if (reasons.length > 0) {
                candidate.failureReasons.push(...reasons);
                candidate.lastFailureReason = reasons[0];
                
                logger.debug('STAGE_SAFETY', 'PRE_BOND checks failed', {
                    mint: candidate.mint.substring(0, 8) + '...',
                    reasons: reasons,
                    score: preBondScore
                });

                return { 
                    success: false, 
                    reason: reasons.join(', '),
                    shouldDrop: true // Drop immediately on pre-bond failures
                };
            }

            logger.info('STAGE_SAFETY', 'PRE_BOND checks passed', {
                mint: candidate.mint.substring(0, 8) + '...',
                score: preBondScore
            });

            return { success: true, newStage: 'BONDED_ON_PUMP' };

        } catch (error) {
            logger.error('STAGE_SAFETY', 'PRE_BOND check error', {
                mint: candidate.mint?.substring(0, 8) + '...' || 'unknown'
            }, error);
            
            metricsCollector.recordSafetyCheck('social', 'fail');
            return { 
                success: false, 
                reason: FAILURE_REASONS.UNKNOWN_ERROR,
                retryAfter: 5000 // Retry in 5 seconds
            };
        }
    }

    /**
     * BONDED_ON_PUMP stage checks - track early velocity, no pool-dependent checks yet
     */
    async checkBondedOnPump(candidate: TokenCandidate): Promise<StageTransitionResult> {
        const reasons: FailureReason[] = [];
        
        try {
            if (!this.config.bondedOnPump.enabled) {
                return { success: true, newStage: 'RAYDIUM_LISTED' };
            }

            // 1) Check if we've exceeded the wait window for pool creation
            const waitTime = Date.now() - (candidate.firstSeenBondedAt || candidate.discoveredAt);
            if (waitTime > this.config.bondedOnPump.maxWaitTimeMs) {
                reasons.push(FAILURE_REASONS.NO_POOL_TIMEOUT);
                
                logger.debug('STAGE_SAFETY', 'BONDED_ON_PUMP timeout', {
                    mint: candidate.mint.substring(0, 8) + '...',
                    waitTimeMs: waitTime,
                    maxWaitMs: this.config.bondedOnPump.maxWaitTimeMs
                });

                return { 
                    success: false, 
                    reason: FAILURE_REASONS.NO_POOL_TIMEOUT,
                    shouldDrop: true 
                };
            }

            // 2) Check for Raydium pool existence (this determines if we can graduate)
            const hasPool = await this.detectRaydiumPool(candidate.mint);
            if (hasPool) {
                logger.info('STAGE_SAFETY', 'Raydium pool detected', {
                    mint: candidate.mint.substring(0, 8) + '...',
                    bondedTimeMs: waitTime
                });

                return { success: true, newStage: 'RAYDIUM_LISTED' };
            }

            // 3) Track bonding velocity metrics
            if (this.config.bondedOnPump.trackUniqueWallets) {
                const velocity = this.calculateBondingVelocity(candidate.mint);
                if (velocity.uniqueWallets.size < this.config.bondedOnPump.minVelocityChecks) {
                    const timeSinceStart = Date.now() - velocity.firstSeen;
                    // Only fail on velocity if we've had enough time to accumulate buyers
                    if (timeSinceStart > 60000) { // 1 minute minimum
                        reasons.push(FAILURE_REASONS.LOW_VELOCITY);
                    }
                }
            }

            // 4) Creator behavior analysis
            if (this.config.bondedOnPump.creatorBehaviorCheck) {
                const suspiciousActivity = await this.checkCreatorBehavior(candidate.creator, candidate.mint);
                if (suspiciousActivity) {
                    reasons.push(FAILURE_REASONS.SUSPICIOUS_CREATOR);
                }
            }

            // Still in bonding phase, continue waiting
            logger.debug('STAGE_SAFETY', 'BONDED_ON_PUMP waiting for pool', {
                mint: candidate.mint.substring(0, 8) + '...',
                waitTimeMs: waitTime,
                remainingMs: this.config.bondedOnPump.maxWaitTimeMs - waitTime
            });

            metricsCollector.recordSafetyCheck('liquidity', 'pass');

            return { 
                success: false, 
                reason: 'waiting_for_pool',
                retryAfter: 3000 // Check again in 3 seconds
            };

        } catch (error) {
            logger.error('STAGE_SAFETY', 'BONDED_ON_PUMP check error', {
                mint: candidate.mint?.substring(0, 8) + '...' || 'unknown'
            }, error);
            
            metricsCollector.recordSafetyCheck('liquidity', 'fail');
            return { 
                success: false, 
                reason: FAILURE_REASONS.UNKNOWN_ERROR,
                retryAfter: 5000
            };
        }
    }

    /**
     * RAYDIUM_LISTED stage checks - full safety validation with Jupiter routes
     */
    async checkRaydiumListed(
        candidate: TokenCandidate, 
        connection: Connection, 
        walletPubkey: PublicKey
    ): Promise<StageTransitionResult> {
        const reasons: FailureReason[] = [];
        
        try {
            if (!this.config.raydiumListed.enabled) {
                return { success: true };
            }

            // 1) Jupiter route validation
            logger.debug('STAGE_SAFETY', 'Checking Jupiter route', {
                mint: candidate.mint.substring(0, 8) + '...'
            });

            const hasRoute = await hasDirectJupiterRouteHttp(
                "So11111111111111111111111111111111111111112", // SOL
                candidate.mint
            );

            if (!hasRoute) {
                reasons.push(FAILURE_REASONS.NO_ROUTE);
                metricsCollector.recordSafetyCheck('liquidity', 'fail');
            } else {
                metricsCollector.recordSafetyCheck('liquidity', 'pass');
            }

            // 2) Liquidity depth check
            if (hasRoute) {
                logger.debug('STAGE_SAFETY', 'Checking liquidity depth', {
                    mint: candidate.mint.substring(0, 8) + '...'
                });

                const wallet = { publicKey: walletPubkey } as any; // Mock wallet for price check
                const priceInfo = await getCurrentPriceViaJupiter(candidate.mint, 0.005, wallet);
                
                if (!priceInfo || !priceInfo.liquidity) {
                    reasons.push(FAILURE_REASONS.LOW_LIQUIDITY);
                    metricsCollector.recordSafetyCheck('liquidity', 'fail');
                } else {
                    candidate.simulatedLp = priceInfo.liquidity;
                    candidate.priceImpact = priceInfo.priceImpact;

                    if (priceInfo.liquidity < this.config.raydiumListed.minLiquidity) {
                        reasons.push(FAILURE_REASONS.LOW_LIQUIDITY);
                        metricsCollector.recordSafetyCheck('liquidity', 'fail');
                    } else if (this.config.raydiumListed.maxLiquidity && 
                             priceInfo.liquidity > this.config.raydiumListed.maxLiquidity) {
                        reasons.push(FAILURE_REASONS.HIGH_LIQUIDITY);
                        metricsCollector.recordSafetyCheck('liquidity', 'fail');
                    } else {
                        metricsCollector.recordSafetyCheck('liquidity', 'pass');
                    }
                }
            }

            // 3) Full safety checks if basic validations passed
            if (reasons.length === 0) {
                logger.debug('STAGE_SAFETY', 'Running full safety checks', {
                    mint: candidate.mint.substring(0, 8) + '...'
                });

                const pumpToken: PumpToken = {
                    mint: candidate.mint,
                    pool: candidate.pool,
                    creator: candidate.creator,
                    discoveredAt: candidate.discoveredAt,
                    simulatedLp: candidate.simulatedLp || 0,
                    hasJupiterRoute: hasRoute,
                    lpTokenAddress: "LP_unknown",
                    earlyHolders: 0,
                    metadata: null,
                    launchSpeedSeconds: null
                };

                const safetyResult = await runFullSafetyChecks(
                    pumpToken, 
                    this.botConfig, 
                    connection, 
                    walletPubkey
                );

                if (!safetyResult.passed) {
                    // Map safety failure to our failure reasons
                    const mappedReason = this.mapSafetyFailureReason(safetyResult.reason || 'unknown');
                    reasons.push(mappedReason);
                    
                    metricsCollector.recordSafetyCheck('honeypot', 'fail');
                } else {
                    metricsCollector.recordSafetyCheck('honeypot', 'pass');
                }
            }

            // Record results
            if (reasons.length > 0) {
                candidate.failureReasons.push(...reasons);
                candidate.lastFailureReason = reasons[0];
                
                logger.info('STAGE_SAFETY', 'RAYDIUM_LISTED checks failed', {
                    mint: candidate.mint.substring(0, 8) + '...',
                    reasons: reasons,
                    liquidity: candidate.simulatedLp
                });

                return { 
                    success: false, 
                    reason: reasons.join(', '),
                    shouldDrop: true
                };
            }

            logger.info('STAGE_SAFETY', 'RAYDIUM_LISTED checks passed', {
                mint: candidate.mint.substring(0, 8) + '...',
                liquidity: candidate.simulatedLp,
                priceImpact: candidate.priceImpact
            });

            return { success: true };

        } catch (error) {
            logger.error('STAGE_SAFETY', 'RAYDIUM_LISTED check error', {
                mint: candidate.mint?.substring(0, 8) + '...' || 'unknown'
            }, error);
            
            metricsCollector.recordSafetyCheck('liquidity', 'fail');
            return { 
                success: false, 
                reason: FAILURE_REASONS.UNKNOWN_ERROR,
                retryAfter: 5000
            };
        }
    }

    /**
     * Main stage-aware safety check dispatcher
     */
    async checkTokenSafety(
        candidate: TokenCandidate,
        connection?: Connection,
        walletPubkey?: PublicKey
    ): Promise<StageTransitionResult> {
        const startTime = Date.now();
        
        try {
            let result: StageTransitionResult;

            switch (candidate.stage) {
                case 'PRE_BOND':
                    result = await this.checkPreBond(candidate);
                    break;
                    
                case 'BONDED_ON_PUMP':
                    result = await this.checkBondedOnPump(candidate);
                    break;
                    
                case 'RAYDIUM_LISTED':
                    if (!connection || !walletPubkey) {
                        throw new Error('Connection and wallet required for RAYDIUM_LISTED checks');
                    }
                    result = await this.checkRaydiumListed(candidate, connection, walletPubkey);
                    break;
                    
                default:
                    throw new Error(`Unknown token stage: ${candidate.stage}`);
            }

            const duration = Date.now() - startTime;
            // Record success metrics using existing types
            
            return result;

        } catch (error) {
            const duration = Date.now() - startTime;
            // Record failure metrics using existing types
            
            logger.error('STAGE_SAFETY', 'Stage safety check error', {
                mint: candidate.mint?.substring(0, 8) + '...' || 'unknown',
                stage: candidate.stage
            }, error);

            return {
                success: false,
                reason: FAILURE_REASONS.UNKNOWN_ERROR,
                retryAfter: 5000
            };
        }
    }

    // Helper methods
    private calculatePreBondScore(candidate: TokenCandidate): number {
        let score = 4; // Base score (neutral)
        
        // Token name quality assessment
        const nameQuality = this.assessTokenNameQuality(candidate.mint);
        score += nameQuality * 0.5; // Up to +1.5 points
        
        // Creator wallet assessment
        const creatorAssessment = this.assessCreatorQuality(candidate.creator);
        score += creatorAssessment * 1.0; // Up to +2 points
        
        // Time of day bonus (UTC hours)
        const hour = new Date().getUTCHours();
        if (hour >= 13 && hour <= 21) { // 1 PM - 9 PM UTC (prime trading hours)
            score += 0.5;
        } else if (hour >= 9 && hour <= 12) { // Morning hours
            score += 0.3;
        }
        
        // Recent creator activity penalty
        const creatorBehavior = this.analyzeCreatorBehavior(candidate.creator);
        if (creatorBehavior.tokenCount > 5) { // Too many recent tokens
            score -= 1.0;
        } else if (creatorBehavior.tokenCount > 2) {
            score -= 0.5;
        }
        
        // Suspicious pattern penalty
        if (creatorBehavior.suspiciousPatterns.length > 0) {
            score -= creatorBehavior.suspiciousPatterns.length * 0.5;
        }
        
        return Math.max(1, Math.min(7, Math.round(score * 10) / 10)); // Round to 1 decimal, clamp 1-7
    }
    
    private assessTokenNameQuality(mintOrName: string): number {
        // For now, using mint address as we don't have token metadata yet
        // In a real implementation, this would analyze the actual token name/symbol
        
        let quality = 0;
        
        // Penalize extremely short or long names (assuming we had the actual name)
        // For now, just return neutral score since we only have mint address
        return quality;
    }
    
    private assessCreatorQuality(creator: string): number {
        let quality = 0;
        
        // Check if creator has history of successful tokens
        const behavior = this.analyzeCreatorBehavior(creator);
        
        // Reward moderate activity (not too little, not too much)
        if (behavior.tokenCount >= 1 && behavior.tokenCount <= 3) {
            quality += 1.0;
        } else if (behavior.tokenCount === 0) {
            quality += 0.5; // New creator bonus (could be legitimate)
        } else if (behavior.tokenCount > 10) {
            quality -= 1.0; // Too prolific, likely spam
        }
        
        // Penalize high risk score
        quality -= behavior.riskScore;
        
        return quality;
    }
    
    private analyzeCreatorBehavior(creator: string): {
        lastActivity: number;
        tokenCount: number;
        suspiciousPatterns: string[];
        riskScore: number;
    } {
        const cached = this.creatorBehaviorCache.get(creator);
        if (cached) {
            return cached;
        }
        
        // Initialize behavior analysis for new creator
        const now = Date.now();
        const behavior = {
            lastActivity: now,
            tokenCount: 1, // This token
            suspiciousPatterns: [] as string[],
            riskScore: 0
        };
        
        // Check for suspicious patterns
        // Pattern 1: Too many tokens in short time
        if (behavior.tokenCount > 5) {
            behavior.suspiciousPatterns.push('high_frequency');
            behavior.riskScore += 0.3;
        }
        
        // Pattern 2: Very new wallet creating tokens immediately
        // (We'd need additional chain data to implement this fully)
        
        this.creatorBehaviorCache.set(creator, behavior);
        
        // Clean up old entries periodically
        if (this.creatorBehaviorCache.size > 1000) {
            const entries = Array.from(this.creatorBehaviorCache.entries());
            entries.sort(([,a], [,b]) => b.lastActivity - a.lastActivity);
            
            // Keep only the 500 most recent
            this.creatorBehaviorCache.clear();
            for (const [key, value] of entries.slice(0, 500)) {
                this.creatorBehaviorCache.set(key, value);
            }
        }
        
        return behavior;
    }
    
    private calculateBondingVelocity(mint: string): {
        firstSeen: number;
        buyEvents: Array<{ timestamp: number; wallet: string; amount: number }>;
        uniqueWallets: Set<string>;
        totalVolume: number;
    } {
        const cached = this.velocityCache.get(mint);
        if (cached) {
            return cached;
        }
        
        // Initialize velocity tracking for new token
        const now = Date.now();
        const velocity = {
            firstSeen: now,
            buyEvents: [] as Array<{ timestamp: number; wallet: string; amount: number }>,
            uniqueWallets: new Set<string>(),
            totalVolume: 0
        };
        
        this.velocityCache.set(mint, velocity);
        
        // Clean up old entries (tokens older than 1 hour)
        const oneHourAgo = now - (60 * 60 * 1000);
        for (const [key, value] of this.velocityCache.entries()) {
            if (value.firstSeen < oneHourAgo) {
                this.velocityCache.delete(key);
            }
        }
        
        return velocity;
    }
    
    private async checkCreatorBehavior(creator: string, currentMint: string): Promise<boolean> {
        const behavior = this.analyzeCreatorBehavior(creator);
        
        // Update token count for this creator
        behavior.tokenCount++;
        behavior.lastActivity = Date.now();
        
        // Check for suspicious patterns
        
        // Pattern 1: Too many tokens in short time (>3 tokens in last hour)
        if (behavior.tokenCount > 3) {
            const recentTokens = behavior.tokenCount;
            if (recentTokens > 3) {
                behavior.suspiciousPatterns.push('rapid_deployment');
                behavior.riskScore += 0.4;
            }
        }
        
        // Pattern 2: Consistent failure pattern (would need historical data)
        // This would require tracking success rates of previous tokens
        
        // Pattern 3: Wallet funding patterns (would need on-chain analysis)
        // This would require checking recent SOL deposits/patterns
        
        this.creatorBehaviorCache.set(creator, behavior);
        
        // Return true if suspicious (risk score > threshold)
        return behavior.riskScore > 0.6;
    }

    private async detectRaydiumPool(mint: string): Promise<boolean> {
        try {
            // Use Jupiter route existence as proxy for Raydium pool
            const hasRoute = await hasDirectJupiterRouteHttp(
                "So11111111111111111111111111111111111111112",
                mint
            );
            return hasRoute;
        } catch {
            return false;
        }
    }

    private mapSafetyFailureReason(reason: string): FailureReason {
        const lowerReason = reason.toLowerCase();
        
        if (lowerReason.includes('liquidity')) return FAILURE_REASONS.LOW_LIQUIDITY;
        if (lowerReason.includes('honeypot')) return FAILURE_REASONS.HONEYPOT;
        if (lowerReason.includes('lock')) return FAILURE_REASONS.NO_LP_LOCK;
        if (lowerReason.includes('social')) return FAILURE_REASONS.LOW_SOCIAL_SCORE;
        if (lowerReason.includes('holder')) return FAILURE_REASONS.BAD_HOLDER_DISTRIBUTION;
        if (lowerReason.includes('authority')) return FAILURE_REASONS.DANGEROUS_AUTHORITIES;
        if (lowerReason.includes('slippage')) return FAILURE_REASONS.HIGH_SLIPPAGE;
        
        return FAILURE_REASONS.UNKNOWN_ERROR;
    }
}

// Global instance
export const stageAwareSafety = new StageAwareSafetyChecker();