// src/utils/liquidityAnalysis.ts
// Comprehensive liquidity depth analysis and price impact calculation

import { PublicKey, Connection } from "@solana/web3.js";
import { computeSwap, getSharedJupiter } from "./jupiter.js";
import { computeSwapHttp } from "./jupiterHttp.js";
import logger from "./logger.js";
import emergencyCircuitBreaker from "../core/emergencyCircuitBreaker.js";
import JSBIImport from "jsbi";

const JSBI: any = JSBIImport;

export interface LiquidityDepthAnalysis {
    actualLiquidity: number;        // Real SOL liquidity available
    priceImpact: number;           // Price impact percentage for trade
    slippageEstimate: number;      // Expected slippage percentage
    marketDepth: {
        shallow: number;           // Liquidity at 1% slippage
        medium: number;            // Liquidity at 5% slippage  
        deep: number;              // Liquidity at 10% slippage
    };
    routeAnalysis: {
        primaryDex: string;        // Main DEX providing liquidity
        routeCount: number;        // Number of available routes
        fragmentationScore: number; // How fragmented the liquidity is (0-1)
    };
    recommendation: {
        maxSafeSize: number;       // Maximum safe trade size in SOL
        confidence: number;        // Confidence score (0-1)
        warnings: string[];        // Liquidity warnings
    };
}

export interface PriceImpactCalculation {
    tradeSize: number;            // Requested trade size in SOL
    estimatedPriceImpact: number; // Expected price impact %
    effectiveSlippage: number;    // Total effective slippage %
    optimalSize: number;          // Recommended optimal trade size
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
}

class LiquidityAnalyzer {
    private readonly PROBE_AMOUNTS = [0.001, 0.01, 0.1]; // Reduced probe amounts to avoid rate limiting
    private readonly MAX_PRICE_IMPACT = 0.15; // 15% max price impact
    private readonly OPTIMAL_PRICE_IMPACT = 0.03; // 3% optimal price impact

    /**
     * Perform comprehensive liquidity depth analysis for a token
     */
    async analyzeLiquidityDepth(
        mintAddress: string,
        connection: Connection,
        userPubkey: PublicKey,
        maxTradeSize: number = 1.0
    ): Promise<LiquidityDepthAnalysis> {
        try {
            logger.info('LIQUIDITY', 'Starting liquidity depth analysis', {
                mint: mintAddress.substring(0, 8) + '...',
                maxTradeSize
            });

            // Add timeout to prevent hanging
            const analysisPromise = this.performAnalysis(mintAddress, userPubkey, maxTradeSize);
            const timeoutPromise = new Promise<LiquidityDepthAnalysis>((_, reject) => {
                setTimeout(() => reject(new Error('Liquidity analysis timeout')), 10000); // 10 second timeout
            });

            const result = await Promise.race([analysisPromise, timeoutPromise]);
            
            logger.info('LIQUIDITY', 'Liquidity analysis completed', {
                mint: mintAddress.substring(0, 8) + '...',
                actualLiquidity: result.actualLiquidity
            });
            
            return result;

        } catch (error) {
            logger.warn('LIQUIDITY', 'Liquidity analysis failed', {
                mint: mintAddress.substring(0, 8) + '...',
                error: (error as Error).message
            });
            return this.createFailedAnalysis(`Analysis failed: ${(error as Error).message}`);
        }
    }

    private async performAnalysis(
        mintAddress: string,
        userPubkey: PublicKey,
        maxTradeSize: number
    ): Promise<LiquidityDepthAnalysis> {
        // Test multiple trade sizes to build liquidity curve
        const liquidityCurve = await this.buildLiquidityCurve(mintAddress, userPubkey, maxTradeSize);
        
        if (liquidityCurve.length === 0) {
            return this.createFailedAnalysis('No liquidity data available');
        }

        // Calculate market depth at different slippage levels
        const marketDepth = this.calculateMarketDepth(liquidityCurve);
        
        // Analyze route information (skip for now due to Jupiter SDK issues)
        const routeAnalysis = { primaryDex: "Unknown", routeCount: 1, fragmentationScore: 0 };
        
        // Calculate actual liquidity (largest tradeable amount with reasonable slippage)
        const actualLiquidity = this.calculateActualLiquidity(liquidityCurve);
        
        // Generate recommendations
        const recommendation = this.generateRecommendations(liquidityCurve, actualLiquidity);

        const analysis: LiquidityDepthAnalysis = {
            actualLiquidity,
            priceImpact: liquidityCurve[liquidityCurve.length - 1]?.priceImpact || 0,
            slippageEstimate: liquidityCurve[liquidityCurve.length - 1]?.effectiveSlippage || 0,
            marketDepth,
            routeAnalysis,
            recommendation
        };

        return analysis;
    }

    /**
     * Calculate price impact for a specific trade size
     */
    async calculatePriceImpact(
        mintAddress: string,
        tradeSize: number,
        userPubkey: PublicKey
    ): Promise<PriceImpactCalculation> {
        try {
            // Get base price with tiny trade
            const baseRoute = await computeSwap(mintAddress, 0.001, userPubkey);
            if (!baseRoute || !baseRoute.outAmount) {
                throw new Error('Cannot establish base price');
            }

            const basePrice = 0.001 / Number(baseRoute.outAmount.toString());

            // Get price for actual trade size
            const tradeRoute = await computeSwap(mintAddress, tradeSize, userPubkey);
            if (!tradeRoute || !tradeRoute.outAmount) {
                throw new Error('Cannot get trade route');
            }

            const tradePrice = tradeSize / Number(tradeRoute.outAmount.toString());
            const priceImpact = ((tradePrice - basePrice) / basePrice) * 100;
            
            // Calculate effective slippage (includes both price impact and spread)
            const expectedTokensAtBasePrice = tradeSize / basePrice;
            const actualTokens = Number(tradeRoute.outAmount.toString());
            const effectiveSlippage = ((expectedTokensAtBasePrice - actualTokens) / expectedTokensAtBasePrice) * 100;

            // Determine optimal trade size (target 3% price impact)
            const optimalSize = this.findOptimalTradeSize(basePrice, tradeSize, priceImpact);

            // Assess risk level
            const riskLevel = this.assessRiskLevel(priceImpact, effectiveSlippage);

            return {
                tradeSize,
                estimatedPriceImpact: Math.abs(priceImpact),
                effectiveSlippage: Math.abs(effectiveSlippage),
                optimalSize,
                riskLevel
            };

        } catch (error) {
            logger.error('LIQUIDITY', 'Price impact calculation failed', {
                mint: mintAddress.substring(0, 8) + '...',
                tradeSize,
                error: (error as Error).message
            });

            return {
                tradeSize,
                estimatedPriceImpact: 100, // Assume worst case
                effectiveSlippage: 100,
                optimalSize: 0.001, // Minimal safe size
                riskLevel: 'EXTREME'
            };
        }
    }

    /**
     * Build liquidity curve by testing multiple trade sizes
     */
    private async buildLiquidityCurve(
        mintAddress: string,
        userPubkey: PublicKey,
        maxSize: number
    ): Promise<Array<{ size: number; priceImpact: number; effectiveSlippage: number; success: boolean }>> {
        const curve = [];
        let basePrice: number | null = null;

        for (let i = 0; i < this.PROBE_AMOUNTS.length; i++) {
            const probeAmount = this.PROBE_AMOUNTS[i];
            if (probeAmount > maxSize) continue;

            try {
                // Add delay between API calls to avoid rate limiting
                if (i > 0) {
                    await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second between calls
                }

                logger.debug('LIQUIDITY', 'Testing liquidity probe', {
                    mint: mintAddress.substring(0, 8) + '...',
                    amount: probeAmount
                });

                const route = await computeSwapHttp(mintAddress, probeAmount, userPubkey);
                if (!route || !route.outAmount) {
                    curve.push({
                        size: probeAmount,
                        priceImpact: 100,
                        effectiveSlippage: 100,
                        success: false
                    });
                    continue;
                }

                const price = probeAmount / Number(route.outAmount);
                
                // Establish base price with smallest successful trade
                if (basePrice === null) {
                    basePrice = price;
                }

                const priceImpact = basePrice > 0 ? ((price - basePrice) / basePrice) * 100 : 0;
                
                // Calculate slippage from route price impact if available
                const routePriceImpact = Number(route.priceImpactPct || 0);
                const effectiveSlippage = Math.max(Math.abs(priceImpact), Math.abs(routePriceImpact));

                curve.push({
                    size: probeAmount,
                    priceImpact: Math.abs(priceImpact),
                    effectiveSlippage,
                    success: true
                });

                // Stop if price impact becomes too high
                if (Math.abs(priceImpact) > this.MAX_PRICE_IMPACT * 100) {
                    break;
                }

            } catch (error) {
                curve.push({
                    size: probeAmount,
                    priceImpact: 100,
                    effectiveSlippage: 100,
                    success: false
                });
            }

            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        return curve;
    }

    /**
     * Calculate market depth at different slippage levels
     */
    private calculateMarketDepth(
        curve: Array<{ size: number; priceImpact: number; effectiveSlippage: number; success: boolean }>
    ) {
        const findMaxSizeAtSlippage = (maxSlippage: number) => {
            const validPoints = curve.filter(p => p.success && p.effectiveSlippage <= maxSlippage);
            return validPoints.length > 0 ? Math.max(...validPoints.map(p => p.size)) : 0;
        };

        return {
            shallow: findMaxSizeAtSlippage(1),   // 1% slippage
            medium: findMaxSizeAtSlippage(5),    // 5% slippage
            deep: findMaxSizeAtSlippage(10)      // 10% slippage
        };
    }

    /**
     * Analyze available routes for the token
     */
    private async analyzeRoutes(mintAddress: string, userPubkey: PublicKey) {
        try {
            // Skip Jupiter SDK route analysis due to assertion failures
            // This is non-critical analysis, so we'll use defaults
            logger.debug('LIQUIDITY', 'Skipping route analysis due to Jupiter SDK issues', {
                mint: mintAddress.substring(0, 8) + '...'
            });
            
            return {
                primaryDex: "Unknown",
                routeCount: 1, // Assume single route exists if we got here
                fragmentationScore: 0 // Assume not fragmented
            };

        } catch (error) {
            return {
                primaryDex: "Unknown",
                routeCount: 0,
                fragmentationScore: 1 // Assume worst case
            };
        }
    }

    /**
     * Calculate actual tradeable liquidity with reasonable slippage
     */
    private calculateActualLiquidity(
        curve: Array<{ size: number; priceImpact: number; effectiveSlippage: number; success: boolean }>
    ): number {
        // Find largest size with acceptable slippage (5% or less)
        const acceptablePoints = curve.filter(p => p.success && p.effectiveSlippage <= 5);
        return acceptablePoints.length > 0 ? Math.max(...acceptablePoints.map(p => p.size)) : 0;
    }

    /**
     * Generate trading recommendations based on liquidity analysis
     */
    private generateRecommendations(
        curve: Array<{ size: number; priceImpact: number; effectiveSlippage: number; success: boolean }>,
        actualLiquidity: number
    ) {
        const warnings: string[] = [];
        let confidence = 1.0;

        // Find optimal trade size (target 3% slippage)
        const optimalPoints = curve.filter(p => p.success && p.effectiveSlippage <= 3);
        const maxSafeSize = optimalPoints.length > 0 ? Math.max(...optimalPoints.map(p => p.size)) : 0.001;

        // Generate warnings based on liquidity analysis
        if (actualLiquidity < 0.01) {
            warnings.push("Very low liquidity - high slippage expected");
            confidence *= 0.3;
        } else if (actualLiquidity < 0.1) {
            warnings.push("Low liquidity - moderate slippage expected");
            confidence *= 0.6;
        }

        if (maxSafeSize < 0.005) {
            warnings.push("Extremely limited trade size recommended");
            confidence *= 0.4;
        }

        const successfulTrades = curve.filter(p => p.success).length;
        if (successfulTrades < 3) {
            warnings.push("Limited liquidity data - analysis may be incomplete");
            confidence *= 0.5;
        }

        return {
            maxSafeSize,
            confidence: Math.max(confidence, 0.1), // Minimum 10% confidence
            warnings
        };
    }

    /**
     * Find optimal trade size based on price impact curve
     */
    private findOptimalTradeSize(basePrice: number, currentSize: number, currentImpact: number): number {
        if (currentImpact <= this.OPTIMAL_PRICE_IMPACT * 100) {
            return currentSize;
        }

        // Estimate optimal size based on linear approximation
        const targetImpact = this.OPTIMAL_PRICE_IMPACT * 100;
        const scaleFactor = targetImpact / Math.max(currentImpact, 0.1);
        return Math.max(currentSize * scaleFactor, 0.001);
    }

    /**
     * Assess risk level based on price impact and slippage
     */
    private assessRiskLevel(priceImpact: number, slippage: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME' {
        const maxMetric = Math.max(priceImpact, slippage);
        
        if (maxMetric > 15) return 'EXTREME';
        if (maxMetric > 10) return 'HIGH';
        if (maxMetric > 5) return 'MEDIUM';
        return 'LOW';
    }

    /**
     * Create failed analysis result
     */
    private createFailedAnalysis(reason: string): LiquidityDepthAnalysis {
        return {
            actualLiquidity: 0,
            priceImpact: 100,
            slippageEstimate: 100,
            marketDepth: {
                shallow: 0,
                medium: 0,
                deep: 0
            },
            routeAnalysis: {
                primaryDex: "Unknown",
                routeCount: 0,
                fragmentationScore: 1
            },
            recommendation: {
                maxSafeSize: 0,
                confidence: 0,
                warnings: [reason]
            }
        };
    }
}

// Singleton instance
export const liquidityAnalyzer = new LiquidityAnalyzer();

export default liquidityAnalyzer;