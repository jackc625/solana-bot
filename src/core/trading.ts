// src/core/trading.ts
// Exports: snipeToken, sellToken, getCurrentPriceViaJupiter

import { Keypair, PublicKey, Connection } from "@solana/web3.js";
import { computeSwap } from "../utils/jupiter.js";
import { sendPumpTrade } from "../utils/pumpTrade.js";
import { shouldCooldown } from "../utils/globalCooldown.js";
import { connection as sharedConnection, loadWallet } from "../utils/solana.js";
import { begin, end } from "../state/inflight.js";
import riskManager from "./riskManager.js";
import logger from "../utils/logger.js";
import { loadBotConfig } from "../config/index.js";
import emergencyCircuitBreaker from "./emergencyCircuitBreaker.js";
import networkHealthMonitor from "../utils/networkHealth.js";
import liquidityAnalyzer, { LiquidityDepthAnalysis, PriceImpactCalculation } from "../utils/liquidityAnalysis.js";

/**
 * Enhanced price and liquidity assessment with proper depth analysis.
 * SAFETY-006: Replaces flawed probe-amount liquidity proxy with real analysis.
 * - price: SOL per token
 * - liquidity: actual tradeable liquidity depth
 * - priceImpact: estimated price impact for the trade
 * - recommendation: trading recommendations based on analysis
 */
export async function getCurrentPriceViaJupiter(
    mint: string,
    amount: number,
    walletArg?: Keypair | null
): Promise<{ 
    price: number; 
    liquidity: number; 
    priceImpact?: number;
    recommendation?: {
        maxSafeSize: number;
        riskLevel: string;
        warnings: string[];
    }
} | null> {
    if (shouldCooldown()) {
        logger.warn('TRADING', 'Skipping price check due to global cooldown', { mint });
        return null;
    }

    const wallet = walletArg ?? loadWallet();
    if (!wallet) {
        logger.warn('TRADING', 'Wallet not loaded for price check', { mint });
        return null;
    }

    try {
        const route = await computeSwap(mint, amount, wallet.publicKey);
        if (!route || !route.outAmount) {
            logger.debug('TRADING', 'No route found for price check', { mint, amount });
            return null;
        }

        const tokensOut = Number(route.outAmount);
        if (tokensOut <= 0) {
            logger.debug('TRADING', 'Invalid token output amount', { mint, amount, tokensOut });
            return null;
        }

        const price = amount / tokensOut; // SOL per token
        
        // SAFETY-006: Enhanced liquidity analysis for proper assessment
        let liquidity = amount; // Fallback to probe amount
        let priceImpact: number | undefined;
        let recommendation: any;
        
        try {
            // Only do full analysis for larger amounts or when specifically requested
            if (amount >= 0.01) {
                const analysis = await liquidityAnalyzer.analyzeLiquidityDepth(
                    mint, 
                    sharedConnection, 
                    wallet.publicKey, 
                    Math.max(amount * 2, 0.1) // Analyze up to 2x trade size or 0.1 SOL
                );
                
                liquidity = analysis.actualLiquidity;
                
                // Calculate price impact for this specific trade size
                const impactCalc = await liquidityAnalyzer.calculatePriceImpact(
                    mint,
                    amount,
                    wallet.publicKey
                );
                
                priceImpact = impactCalc.estimatedPriceImpact;
                recommendation = {
                    maxSafeSize: analysis.recommendation.maxSafeSize,
                    riskLevel: impactCalc.riskLevel,
                    warnings: analysis.recommendation.warnings
                };
                
                // Log enhanced analysis results
                logger.debug('TRADING', 'Enhanced liquidity analysis completed', {
                    mint: mint.substring(0, 8) + '...',
                    price,
                    actualLiquidity: liquidity.toFixed(4),
                    priceImpact: priceImpact.toFixed(2),
                    riskLevel: impactCalc.riskLevel,
                    maxSafeSize: analysis.recommendation.maxSafeSize.toFixed(4)
                });
                
                // Warn if trade size exceeds safe recommendations
                if (amount > analysis.recommendation.maxSafeSize) {
                    logger.warn('TRADING', '⚠️ Trade size exceeds recommended safe size', {
                        mint: mint.substring(0, 8) + '...',
                        requestedSize: amount,
                        maxSafeSize: analysis.recommendation.maxSafeSize,
                        estimatedPriceImpact: priceImpact
                    });
                }
            } else {
                // For small amounts, use basic assessment
                liquidity = Math.max(amount * 10, 0.01); // Estimate 10x minimum depth
                logger.debug('TRADING', 'Basic price check (small amount)', {
                    mint: mint.substring(0, 8) + '...',
                    price,
                    estimatedLiquidity: liquidity,
                    tokensOut
                });
            }
        } catch (error) {
            logger.warn('TRADING', 'Enhanced analysis failed, using fallback', {
                mint: mint.substring(0, 8) + '...',
                error: (error as Error).message
            });
            // Keep fallback liquidity value
        }
        
        return { 
            price, 
            liquidity, 
            priceImpact,
            recommendation
        };
    } catch (e) {
        logger.error('TRADING', 'Price check failed', { 
            mint: mint.substring(0, 8) + '...', 
            amount 
        }, e);
        return null;
    }
}

/**
 * Flexible snipe function used by bot.ts.
 * Supports:
 *  - snipeToken({ connection, wallet, mint, amountSOL, pool?, slippage?, priorityFee? })
 *  - snipeToken(mint: string, amountSOL: number)
 */
export async function snipeToken(...args: any[]): Promise<void> {
    let conn: Connection | null | undefined;
    let wallet: Keypair | null | undefined;
    let mint: string;
    let amountSOL: number;
    let opts: any = {};

    if (typeof args[0] === "object" && args[0] && "mint" in args[0]) {
        const p = args[0];
        conn = p.connection ?? sharedConnection;
        wallet = p.wallet ?? loadWallet();
        mint = p.mint;
        amountSOL = p.amountSOL ?? p.amount ?? p.size ?? 0;
        opts = p;
    } else {
        mint = args[0];
        amountSOL = args[1];
        conn = sharedConnection;
        wallet = loadWallet();
    }

    if (!conn || !wallet) throw new Error("snipeToken: wallet/connection not available");
    if (!mint || !(amountSOL > 0)) throw new Error("snipeToken: invalid mint/amount");

    // SAFETY-005: Critical balance validation
    const balance = await conn.getBalance(wallet.publicKey);
    const balanceSOL = balance / 1e9;
    const config = loadBotConfig();
    const minReserve = 0.01; // Minimum SOL reserve for gas fees
    
    if (balanceSOL < amountSOL + minReserve) {
        logger.error('TRADING', '❌ Insufficient balance for trade', {
            mint: mint.substring(0, 8) + '...',
            requested: amountSOL,
            available: balanceSOL,
            minReserve
        });
        throw new Error(`Insufficient balance: ${balanceSOL.toFixed(4)} SOL available, ${amountSOL + minReserve} SOL required`);
    }

    // SAFETY-005: Comprehensive network health validation
    const rpcHealthy = await networkHealthMonitor.validateRpcHealth(conn);
    if (!rpcHealthy) {
        logger.error('TRADING', '❌ RPC health validation failed', {
            mint: mint.substring(0, 8) + '...',
            healthMetrics: networkHealthMonitor.getMetrics()
        });
        throw new Error('RPC endpoint failed health validation');
    }

    // Check network congestion
    const congestionCheck = await networkHealthMonitor.checkNetworkCongestion(conn);
    if (!congestionCheck.isHealthy) {
        logger.warn('TRADING', '⚠️ Network congestion detected', {
            mint: mint.substring(0, 8) + '...',
            reason: congestionCheck.reason
        });
        // Don't halt trading but log the warning
    }

    // SAFETY-005: Token decimals validation
    try {
        const mintPubkey = new PublicKey(mint);
        const mintInfo = await conn.getParsedAccountInfo(mintPubkey);
        if (!mintInfo.value || !mintInfo.value.data || typeof mintInfo.value.data !== 'object') {
            throw new Error('Token mint account not found or invalid');
        }
        const parsedData = mintInfo.value.data as any;
        if (!parsedData.parsed || typeof parsedData.parsed.info.decimals !== 'number') {
            throw new Error('Token decimals information not available');
        }
        const decimals = parsedData.parsed.info.decimals;
        if (decimals < 0 || decimals > 18) {
            throw new Error(`Invalid token decimals: ${decimals}`);
        }
    } catch (error) {
        logger.error('TRADING', '❌ Token validation failed', {
            mint: mint.substring(0, 8) + '...',
            error: (error as Error).message
        });
        throw new Error(`Token validation failed: ${(error as Error).message}`);
    }

    // Check for emergency halt conditions
    if (riskManager.shouldHaltTrading()) {
        logger.error('TRADING', '🚨 Trading halted due to risk limits', {
            mint: mint.substring(0, 8) + '...',
            amount: amountSOL
        });
        return;
    }

    // SAFETY-005: Circuit breaker check
    if (emergencyCircuitBreaker.shouldHaltTrading()) {
        logger.error('TRADING', '🚨 Trading halted by emergency circuit breaker', {
            mint: mint.substring(0, 8) + '...',
            amount: amountSOL,
            circuitBreakerStatus: emergencyCircuitBreaker.getStatus()
        });
        return;
    }

    // Risk management check
    const riskCheck = await riskManager.checkPositionRisk({
        mint,
        requestedAmount: amountSOL,
        connection: conn,
        walletPubkey: wallet.publicKey
    });

    if (!riskCheck.allowed) {
        logger.warn('TRADING', '⚠️ Trade rejected by risk management', {
            mint: mint.substring(0, 8) + '...',
            requestedAmount: amountSOL,
            reason: riskCheck.reason,
            maxAllowed: riskCheck.maxAllowedAmount,
            portfolioState: riskManager.getRiskSummary()
        });
        return;
    }

    // de-dupe guard for BUY
    if (!begin(mint, "buy")) {
        logger.warn('TRADING', 'Skipping duplicate BUY operation', { 
            mint: mint.substring(0, 8) + '...', 
            amount: amountSOL 
        });
        return;
    }
    
    try {
        // SAFETY-006: Dynamic slippage based on price impact analysis
        if (!opts.slippage) {
            try {
                const impactCalc = await liquidityAnalyzer.calculatePriceImpact(
                    mint,
                    amountSOL,
                    wallet.publicKey
                );
                
                // Set slippage based on effective slippage + buffer
                const baseSlippage = config.slippage || 0.015;
                const impactBuffer = Math.max(impactCalc.effectiveSlippage / 100, baseSlippage);
                opts.slippage = Math.min(impactBuffer * 1.2, 0.1); // Max 10% slippage
                
                logger.debug('TRADING', 'Dynamic slippage calculated', {
                    mint: mint.substring(0, 8) + '...',
                    baseSlippage: (baseSlippage * 100).toFixed(1),
                    effectiveSlippage: impactCalc.effectiveSlippage.toFixed(1),
                    finalSlippage: (opts.slippage * 100).toFixed(1)
                });
                
            } catch (error) {
                // Fallback to size-based slippage
                if (amountSOL > 0.1) {
                    opts.slippage = config.slippage * 2;
                } else if (amountSOL > 0.05) {
                    opts.slippage = config.slippage * 1.5;
                } else {
                    opts.slippage = config.slippage;
                }
            }
        }
        
        logger.info('TRADING', 'Executing BUY order', {
            mint: mint.substring(0, 8) + '...',
            amount: amountSOL,
            slippage: opts.slippage,
            pool: opts.pool
        });

        const signature = await sendPumpTrade({
            connection: conn,
            wallet,
            mint,
            amount: amountSOL,
            action: "buy",
            denominatedInSol: true,
            slippage: opts.slippage,
            priorityFee: opts.priorityFee,
            pool: opts.pool,
        });

        if (signature) {
            // SAFETY-005: Record successful transaction for circuit breaker
            emergencyCircuitBreaker.recordTransaction();
            
            logger.info('TRADING', 'BUY order successful', {
                mint: mint.substring(0, 8) + '...',
                amount: amountSOL,
                signature: signature.substring(0, 8) + '...'
            });
            logger.recordSuccess('TRADING_BUY');
        } else {
            logger.warn('TRADING', 'BUY order returned no signature', {
                mint: mint.substring(0, 8) + '...',
                amount: amountSOL
            });
            logger.recordFailure('TRADING_BUY');
        }
    } catch (error) {
        logger.error('TRADING', 'BUY order failed', {
            mint: mint.substring(0, 8) + '...',
            amount: amountSOL,
            slippage: opts.slippage,
            pool: opts.pool
        }, error);
        logger.recordFailure('TRADING_BUY');
        throw error; // Re-throw to maintain existing error handling behavior
    } finally {
        end(mint, "buy");
    }

}

/**
 * Flexible sell function used by auto-sell manager and elsewhere.
 * Supports:
 *  - sellToken({ connection, wallet, mint, amountTokens })
 *  - sellToken(mint: string, amountTokens: number)
 */
export async function sellToken(...args: any[]): Promise<void> {
    let conn: Connection | null | undefined;
    let wallet: Keypair | null | undefined;
    let mint: string;
    let amountTokens: number;

    if (typeof args[0] === "object" && args[0] && "mint" in args[0]) {
        const p = args[0];
        conn = p.connection ?? sharedConnection;
        wallet = p.wallet ?? loadWallet();
        mint = p.mint;
        amountTokens = p.amountTokens ?? p.amount ?? 0;
    } else {
        mint = args[0];
        amountTokens = args[1];
        conn = sharedConnection;
        wallet = loadWallet();
    }

    if (!conn || !wallet) throw new Error("sellToken: wallet/connection not available");
    if (!mint || !(amountTokens > 0)) throw new Error("sellToken: invalid mint/amountTokens");

    // de-dupe guard for SELL
    if (!begin(mint, "sell")) {
        logger.warn('TRADING', 'Skipping duplicate SELL operation', { 
            mint: mint.substring(0, 8) + '...', 
            amount: amountTokens 
        });
        return;
    }
    
    try {
        logger.info('TRADING', 'Executing SELL order', {
            mint: mint.substring(0, 8) + '...',
            amount: amountTokens
        });

        const signature = await sendPumpTrade({
            connection: conn,
            wallet,
            mint,
            amount: amountTokens,
            action: "sell",
            denominatedInSol: false, // selling by token amount
        });

        if (signature) {
            // SAFETY-005: Record successful transaction for circuit breaker
            emergencyCircuitBreaker.recordTransaction();
            
            logger.info('TRADING', 'SELL order successful', {
                mint: mint.substring(0, 8) + '...',
                amount: amountTokens,
                signature: signature.substring(0, 8) + '...'
            });
            logger.recordSuccess('TRADING_SELL');
        } else {
            logger.warn('TRADING', 'SELL order returned no signature', {
                mint: mint.substring(0, 8) + '...',
                amount: amountTokens
            });
            logger.recordFailure('TRADING_SELL');
        }
    } catch (error) {
        logger.error('TRADING', 'SELL order failed', {
            mint: mint.substring(0, 8) + '...',
            amount: amountTokens
        }, error);
        logger.recordFailure('TRADING_SELL');
        throw error; // Re-throw to maintain existing error handling behavior
    } finally {
        end(mint, "sell");
    }

}
