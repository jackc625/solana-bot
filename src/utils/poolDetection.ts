// src/utils/poolDetection.ts
// Pool detection with exponential backoff and multiple detection methods

import { Connection, PublicKey } from "@solana/web3.js";
import { hasDirectJupiterRouteHttp } from "./jupiterHttp.js";
import { getCurrentPriceViaJupiter } from "../core/trading.js";
import { getSimplifiedLiquidity } from "./onChainLpReserves.js";
import { POOL_DETECTION_CONFIG } from "../types/TokenStage.js";
import logger from "./logger.js";
import metricsCollector from "./metricsCollector.js";

export interface PoolDetectionResult {
    hasPool: boolean;
    method?: 'jupiter_route' | 'on_chain_liquidity' | 'price_quote';
    liquidity?: number;
    confidence: 'LOW' | 'MEDIUM' | 'HIGH';
    checkedAt: number;
    error?: string;
}

export class PoolDetector {
    private static instance: PoolDetector;
    
    // Cache to avoid redundant checks
    private detectionCache = new Map<string, PoolDetectionResult>();
    private readonly CACHE_TTL_MS = 30_000; // 30 seconds

    static getInstance(): PoolDetector {
        if (!PoolDetector.instance) {
            PoolDetector.instance = new PoolDetector();
        }
        return PoolDetector.instance;
    }

    /**
     * Detect if a Raydium pool exists for a token with exponential backoff
     */
    async detectPoolWithBackoff(
        mint: string, 
        maxWaitTimeMs: number = POOL_DETECTION_CONFIG.maxPoolDetectionTime
    ): Promise<PoolDetectionResult> {
        const startTime = Date.now();
        const delays = POOL_DETECTION_CONFIG.backoffDelaysMs;
        let lastResult: PoolDetectionResult | null = null;

        logger.debug('POOL_DETECTION', 'Starting pool detection with backoff', {
            mint: mint.substring(0, 8) + '...',
            maxWaitMs: maxWaitTimeMs,
            delays: delays
        });

        // Try immediate detection first
        lastResult = await this.detectPool(mint);
        if (lastResult.hasPool) {
            // metricsCollector.recordPoolDetection('immediate', true);
            return lastResult;
        }

        // Exponential backoff attempts
        for (let i = 0; i < delays.length; i++) {
            const delay = delays[i];
            const elapsedTime = Date.now() - startTime;
            
            // Check if we would exceed max wait time
            if (elapsedTime + delay > maxWaitTimeMs) {
                logger.debug('POOL_DETECTION', 'Would exceed max wait time, stopping', {
                    mint: mint.substring(0, 8) + '...',
                    elapsedMs: elapsedTime,
                    nextDelayMs: delay,
                    maxWaitMs: maxWaitTimeMs
                });
                break;
            }

            logger.debug('POOL_DETECTION', `Waiting ${delay}ms before attempt ${i + 2}`, {
                mint: mint.substring(0, 8) + '...',
                attempt: i + 2,
                totalAttempts: delays.length + 1
            });

            await this.sleep(delay);
            
            lastResult = await this.detectPool(mint);
            if (lastResult.hasPool) {
                const totalTime = Date.now() - startTime;
                logger.info('POOL_DETECTION', 'Pool found with backoff', {
                    mint: mint.substring(0, 8) + '...',
                    attempt: i + 2,
                    totalTimeMs: totalTime,
                    method: lastResult.method,
                    confidence: lastResult.confidence
                });
                
                // metricsCollector.recordPoolDetection(`backoff_${i + 1}`, true);
                return lastResult;
            }
        }

        const totalTime = Date.now() - startTime;
        logger.debug('POOL_DETECTION', 'Pool not found after backoff', {
            mint: mint.substring(0, 8) + '...',
            totalTimeMs: totalTime,
            attempts: delays.length + 1
        });

        // metricsCollector.recordPoolDetection('backoff_exhausted', false);
        return lastResult || {
            hasPool: false,
            confidence: 'HIGH',
            checkedAt: Date.now(),
            error: 'No pool found after exhaustive backoff'
        };
    }

    /**
     * Single pool detection attempt using multiple methods
     */
    async detectPool(mint: string): Promise<PoolDetectionResult> {
        // Check cache first
        const cached = this.detectionCache.get(mint);
        if (cached && (Date.now() - cached.checkedAt) < this.CACHE_TTL_MS) {
            return cached;
        }

        const result = await this.performPoolDetection(mint);
        
        // Cache the result
        this.detectionCache.set(mint, result);
        
        // Clean old cache entries
        this.cleanCache();
        
        return result;
    }

    private async performPoolDetection(mint: string): Promise<PoolDetectionResult> {
        const startTime = Date.now();
        const methods: Array<{
            name: 'jupiter_route' | 'on_chain_liquidity' | 'price_quote';
            detector: () => Promise<PoolDetectionResult>;
        }> = [
            {
                name: 'jupiter_route',
                detector: () => this.detectViaJupiterRoute(mint)
            },
            {
                name: 'on_chain_liquidity', 
                detector: () => this.detectViaOnChainLiquidity(mint)
            },
            {
                name: 'price_quote',
                detector: () => this.detectViaPriceQuote(mint)
            }
        ];

        const results: PoolDetectionResult[] = [];
        let bestResult: PoolDetectionResult = {
            hasPool: false,
            confidence: 'LOW',
            checkedAt: Date.now()
        };

        // Try each detection method
        for (const method of methods) {
            try {
                const result = await method.detector();
                results.push(result);
                
                // If we found a pool, prefer higher confidence results
                if (result.hasPool) {
                    if (!bestResult.hasPool || 
                        this.getConfidenceScore(result.confidence) > this.getConfidenceScore(bestResult.confidence)) {
                        bestResult = { ...result, method: method.name };
                    }
                    
                    // If we have high confidence, we can stop here
                    if (result.confidence === 'HIGH') {
                        break;
                    }
                }
            } catch (error) {
                logger.debug('POOL_DETECTION', `Method ${method.name} failed`, {
                    mint: mint.substring(0, 8) + '...',
                    error: error instanceof Error ? error.message : String(error)
                });
                
                results.push({
                    hasPool: false,
                    method: method.name,
                    confidence: 'LOW',
                    checkedAt: Date.now(),
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }

        const duration = Date.now() - startTime;
        
        logger.debug('POOL_DETECTION', 'Pool detection completed', {
            mint: mint.substring(0, 8) + '...',
            hasPool: bestResult.hasPool,
            method: bestResult.method,
            confidence: bestResult.confidence,
            durationMs: duration,
            methodsAttempted: results.length
        });

        // metricsCollector.recordTradingOperation('pool_detection', bestResult.hasPool ? 'success' : 'failure', duration);
        
        return bestResult;
    }

    private async detectViaJupiterRoute(mint: string): Promise<PoolDetectionResult> {
        try {
            const hasRoute = await hasDirectJupiterRouteHttp(
                "So11111111111111111111111111111111111111112", // SOL
                mint
            );
            
            return {
                hasPool: hasRoute,
                confidence: hasRoute ? 'MEDIUM' : 'MEDIUM', // Jupiter route is fairly reliable
                checkedAt: Date.now()
            };
        } catch (error) {
            throw new Error(`Jupiter route check failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    private async detectViaOnChainLiquidity(mint: string): Promise<PoolDetectionResult> {
        try {
            const liquidityData = await getSimplifiedLiquidity(mint);
            
            const hasPool = liquidityData && 
                             liquidityData.hasLiquidity && 
                             liquidityData.totalSolLiquidity > 0;
            
            return {
                hasPool: !!hasPool,
                liquidity: liquidityData?.totalSolLiquidity,
                confidence: hasPool ? 'HIGH' : 'HIGH', // On-chain data is most reliable
                checkedAt: Date.now()
            };
        } catch (error) {
            throw new Error(`On-chain liquidity check failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    private async detectViaPriceQuote(mint: string): Promise<PoolDetectionResult> {
        try {
            // Create a minimal wallet mock for the price check
            const mockWallet = {
                publicKey: new PublicKey("11111111111111111111111111111111")
            };
            
            const priceInfo = await getCurrentPriceViaJupiter(mint, 0.001, mockWallet as any);
            
            const hasPool = priceInfo && 
                           priceInfo.price > 0 && 
                           priceInfo.liquidity && 
                           priceInfo.liquidity > 0;
            
            return {
                hasPool: !!hasPool,
                liquidity: priceInfo?.liquidity,
                confidence: hasPool ? 'MEDIUM' : 'LOW', // Price quotes can be less reliable
                checkedAt: Date.now()
            };
        } catch (error) {
            throw new Error(`Price quote check failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    private getConfidenceScore(confidence: 'LOW' | 'MEDIUM' | 'HIGH'): number {
        switch (confidence) {
            case 'LOW': return 1;
            case 'MEDIUM': return 2;
            case 'HIGH': return 3;
        }
    }

    private cleanCache(): void {
        const now = Date.now();
        for (const [mint, result] of this.detectionCache.entries()) {
            if (now - result.checkedAt > this.CACHE_TTL_MS) {
                this.detectionCache.delete(mint);
            }
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Utility method to get cache stats (for debugging/monitoring)
    getCacheStats(): { size: number; entries: Array<{ mint: string; hasPool: boolean; age: number }> } {
        const now = Date.now();
        const entries = Array.from(this.detectionCache.entries()).map(([mint, result]) => ({
            mint: mint.substring(0, 8) + '...',
            hasPool: result.hasPool,
            age: now - result.checkedAt
        }));
        
        return {
            size: this.detectionCache.size,
            entries
        };
    }
}

// Global instance for easy access
export const poolDetector = PoolDetector.getInstance();