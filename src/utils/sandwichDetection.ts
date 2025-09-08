// src/utils/sandwichDetection.ts
// Sandwich attack detection and prevention system

import {
  Connection,
  PublicKey,
  VersionedTransaction,
  ParsedTransactionWithMeta,
} from '@solana/web3.js';
import { computeSwapHttp } from './jupiterHttp.js';
import logger from './logger.js';
import { loadBotConfig } from '../config/index.js';
import rpcManager from './rpcManager.js';

export interface SandwichRiskAssessment {
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  riskScore: number; // 0-100
  indicators: SandwichIndicator[];
  recommendations: string[];
  shouldDelay: boolean;
  delayMs?: number;
  shouldUsePrivateMempool: boolean;
}

export interface SandwichIndicator {
  type:
    | 'LARGE_PRECEDING_TRADE'
    | 'SUSPICIOUS_MEV_BOT'
    | 'PRICE_MANIPULATION'
    | 'HIGH_SLIPPAGE_VARIANCE'
    | 'MEMPOOL_CONGESTION'
    | 'REPEATED_FRONTRUN_PATTERN'
    | 'UNUSUAL_PRIORITY_FEES'
    | 'COORDINATED_TRADES';
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  description: string;
  confidence: number; // 0-1
  evidence?: any;
}

export interface MempoolAnalysis {
  recentTransactions: any[];
  largeTrades: any[];
  mevBotActivity: any[];
  averagePriorityFee: number;
  priceImpactAnalysis: {
    expectedImpact: number;
    recentImpacts: number[];
    variance: number;
  };
}

interface TradePattern {
  tokenMint: string;
  pattern: 'FRONTRUN' | 'BACKRUN' | 'SANDWICH';
  timestamp: number;
  botAddress: string;
  tradeSize: number;
  priceImpact: number;
}

class SandwichDetectionSystem {
  private config: any;
  private suspiciousAddresses = new Set<string>();
  private recentPatterns: TradePattern[] = [];
  private mempoolCache: Map<string, MempoolAnalysis> = new Map();
  private priceHistoryCache: Map<string, { price: number; timestamp: number; impact: number }[]> =
    new Map();

  constructor() {
    this.config = loadBotConfig();

    // Clean old patterns every 5 minutes
    setInterval(() => {
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
      this.recentPatterns = this.recentPatterns.filter((p) => p.timestamp > fiveMinutesAgo);

      // Clean old mempool cache
      for (const [key, analysis] of this.mempoolCache) {
        if (Date.now() - (analysis as any).timestamp > 30000) {
          // 30 seconds
          this.mempoolCache.delete(key);
        }
      }

      // Clean old price history
      for (const [token, history] of this.priceHistoryCache) {
        const filtered = history.filter((entry) => Date.now() - entry.timestamp < 300000); // 5 minutes
        if (filtered.length === 0) {
          this.priceHistoryCache.delete(token);
        } else {
          this.priceHistoryCache.set(token, filtered);
        }
      }
    }, 60000);

    // Load known MEV bot addresses
    this.loadKnownMEVBots();
  }

  /**
   * Analyzes sandwich attack risk for a pending trade
   */
  async assessSandwichRisk(
    tokenMint: string,
    tradeAmountSOL: number,
    userPublicKey: PublicKey,
    connection: Connection,
    expectedPriceImpact?: number,
  ): Promise<SandwichRiskAssessment> {
    const startTime = Date.now();

    try {
      logger.debug('SANDWICH_DETECTION', 'Assessing sandwich risk', {
        tokenMint: tokenMint.substring(0, 8) + '...',
        tradeAmount: tradeAmountSOL,
        expectedPriceImpact,
      });

      const indicators: SandwichIndicator[] = [];
      let riskScore = 0;

      // 1. Analyze current mempool for the token
      const mempoolAnalysis = await this.analyzeMempoolForToken(tokenMint, connection);
      const mempoolRisk = await this.assessMempoolRisk(mempoolAnalysis, tradeAmountSOL);
      indicators.push(...mempoolRisk.indicators);
      riskScore += mempoolRisk.score;

      // 2. Check for recent trade patterns
      const patternRisk = this.assessTradePatterns(tokenMint, tradeAmountSOL);
      indicators.push(...patternRisk.indicators);
      riskScore += patternRisk.score;

      // 3. Analyze price impact variance
      const priceRisk = await this.assessPriceImpactRisk(
        tokenMint,
        tradeAmountSOL,
        userPublicKey,
        expectedPriceImpact,
      );
      indicators.push(...priceRisk.indicators);
      riskScore += priceRisk.score;

      // 4. Check for suspicious priority fees
      const feeRisk = this.assessPriorityFeeAnomaly(mempoolAnalysis);
      indicators.push(...feeRisk.indicators);
      riskScore += feeRisk.score;

      // 5. Network congestion analysis
      const congestionRisk = await this.assessNetworkCongestion(connection);
      indicators.push(...congestionRisk.indicators);
      riskScore += congestionRisk.score;

      // Determine risk level and recommendations
      const riskLevel = this.getRiskLevel(riskScore);
      const recommendations = this.generateRecommendations(riskLevel, indicators, tradeAmountSOL);
      const shouldDelay = riskLevel === 'HIGH' || riskLevel === 'CRITICAL';
      const delayMs = shouldDelay ? this.calculateOptimalDelay(riskLevel, indicators) : undefined;
      const shouldUsePrivateMempool = riskLevel !== 'LOW';

      logger.info('SANDWICH_DETECTION', 'Sandwich risk assessment completed', {
        tokenMint: tokenMint.substring(0, 8) + '...',
        riskLevel,
        riskScore,
        indicatorCount: indicators.length,
        shouldDelay,
        delayMs,
        shouldUsePrivateMempool,
        assessmentTime: Date.now() - startTime,
      });

      return {
        riskLevel,
        riskScore: Math.min(100, riskScore),
        indicators,
        recommendations,
        shouldDelay,
        delayMs,
        shouldUsePrivateMempool,
      };
    } catch (error) {
      logger.error('SANDWICH_DETECTION', 'Error during sandwich risk assessment', {
        tokenMint: tokenMint.substring(0, 8) + '...',
        error: (error as Error).message,
        stack: (error as Error).stack,
      });

      // Return conservative assessment on error
      return {
        riskLevel: 'HIGH',
        riskScore: 75,
        indicators: [
          {
            type: 'UNUSUAL_PRIORITY_FEES',
            severity: 'HIGH',
            description: 'Risk assessment failed - using conservative approach',
            confidence: 1,
          },
        ],
        recommendations: ['Use private mempool', 'Consider delaying trade'],
        shouldDelay: true,
        delayMs: 3000,
        shouldUsePrivateMempool: true,
      };
    }
  }

  /**
   * Analyzes mempool for sandwich attack patterns
   */
  private async analyzeMempoolForToken(
    tokenMint: string,
    connection: Connection,
  ): Promise<MempoolAnalysis> {
    const cacheKey = `mempool_${tokenMint}`;

    // Check cache first (30 second TTL)
    if (this.mempoolCache.has(cacheKey)) {
      const cached = this.mempoolCache.get(cacheKey)!;
      if (Date.now() - (cached as any).timestamp < 30000) {
        return cached;
      }
    }

    try {
      // Get recent confirmed transactions for price analysis
      const tokenPubkey = new PublicKey(tokenMint);
      const signatures = await rpcManager.executeWithFailover(
        async (conn: Connection) => {
          return conn.getSignaturesForAddress(tokenPubkey, { limit: 20 });
        },
        'getSignaturesForAddress',
        2,
      );

      const recentTransactions: any[] = [];
      const largeTrades: any[] = [];
      const mevBotActivity: any[] = [];
      let totalPriorityFee = 0;
      let feeCount = 0;
      const recentImpacts: number[] = [];

      // Analyze recent transactions
      for (const sigInfo of signatures.slice(0, 10)) {
        try {
          const tx = await rpcManager.executeWithFailover(
            async (conn: Connection) => {
              return conn.getParsedTransaction(sigInfo.signature, {
                maxSupportedTransactionVersion: 0,
              });
            },
            'getParsedTransaction',
            1,
          );

          if (tx && tx.meta) {
            recentTransactions.push({
              signature: sigInfo.signature,
              slot: sigInfo.slot,
              fee: tx.meta.fee,
              computeUnitsConsumed: tx.meta.computeUnitsConsumed,
              priorityFee: this.extractPriorityFee(tx),
              accounts: tx.transaction.message.accountKeys.map((key) => key.pubkey.toString()),
            });

            // Check if this looks like a large trade
            const priorityFee = this.extractPriorityFee(tx);
            if (priorityFee > 10000) {
              // High priority fee
              largeTrades.push(recentTransactions[recentTransactions.length - 1]);
            }

            // Check for known MEV bot patterns
            const signer = tx.transaction.message.accountKeys[0]?.pubkey.toString();
            if (signer && this.suspiciousAddresses.has(signer)) {
              mevBotActivity.push(recentTransactions[recentTransactions.length - 1]);
            }

            if (priorityFee > 0) {
              totalPriorityFee += priorityFee;
              feeCount++;
            }
          }
        } catch (error) {
          // Skip failed transaction parsing
          continue;
        }
      }

      const averagePriorityFee = feeCount > 0 ? totalPriorityFee / feeCount : 0;

      // Calculate price impact variance
      const impacts = this.priceHistoryCache.get(tokenMint) || [];
      const recentImpactValues = impacts.map((entry) => entry.impact);
      const variance =
        recentImpactValues.length > 1 ? this.calculateVariance(recentImpactValues) : 0;

      const analysis: MempoolAnalysis = {
        recentTransactions,
        largeTrades,
        mevBotActivity,
        averagePriorityFee,
        priceImpactAnalysis: {
          expectedImpact: 0, // Will be filled by caller
          recentImpacts: recentImpactValues,
          variance,
        },
      };

      // Cache the analysis
      (analysis as any).timestamp = Date.now();
      this.mempoolCache.set(cacheKey, analysis);

      return analysis;
    } catch (error) {
      logger.warn('SANDWICH_DETECTION', 'Failed to analyze mempool', {
        tokenMint: tokenMint.substring(0, 8) + '...',
        error: (error as Error).message,
      });

      // Return empty analysis on error
      return {
        recentTransactions: [],
        largeTrades: [],
        mevBotActivity: [],
        averagePriorityFee: 0,
        priceImpactAnalysis: {
          expectedImpact: 0,
          recentImpacts: [],
          variance: 0,
        },
      };
    }
  }

  /**
   * Assesses mempool-based sandwich risks
   */
  private async assessMempoolRisk(
    analysis: MempoolAnalysis,
    tradeAmountSOL: number,
  ): Promise<{ indicators: SandwichIndicator[]; score: number }> {
    const indicators: SandwichIndicator[] = [];
    let score = 0;

    // Check for large preceding trades
    if (analysis.largeTrades.length > 0) {
      const recentLargeTrades = analysis.largeTrades.filter(
        (trade) => Date.now() - (trade.timestamp || 0) < 60000,
      );

      if (recentLargeTrades.length > 0) {
        indicators.push({
          type: 'LARGE_PRECEDING_TRADE',
          severity: 'MEDIUM',
          description: `${recentLargeTrades.length} large trade(s) detected in recent mempool`,
          confidence: 0.7,
          evidence: { count: recentLargeTrades.length },
        });
        score += 15;
      }
    }

    // Check for MEV bot activity
    if (analysis.mevBotActivity.length > 0) {
      indicators.push({
        type: 'SUSPICIOUS_MEV_BOT',
        severity: 'HIGH',
        description: `${analysis.mevBotActivity.length} known MEV bot(s) recently active`,
        confidence: 0.9,
        evidence: { botCount: analysis.mevBotActivity.length },
      });
      score += 25;
    }

    // Check for mempool congestion
    if (analysis.recentTransactions.length > 15) {
      indicators.push({
        type: 'MEMPOOL_CONGESTION',
        severity: 'MEDIUM',
        description: 'High mempool activity detected',
        confidence: 0.6,
        evidence: { transactionCount: analysis.recentTransactions.length },
      });
      score += 10;
    }

    return { indicators, score };
  }

  /**
   * Analyzes trade patterns for sandwich indicators
   */
  private assessTradePatterns(
    tokenMint: string,
    tradeAmountSOL: number,
  ): { indicators: SandwichIndicator[]; score: number } {
    const indicators: SandwichIndicator[] = [];
    let score = 0;

    // Check for recent frontrun patterns on this token
    const recentPatterns = this.recentPatterns.filter(
      (pattern) => pattern.tokenMint === tokenMint && pattern.pattern === 'FRONTRUN',
    );

    if (recentPatterns.length > 0) {
      indicators.push({
        type: 'REPEATED_FRONTRUN_PATTERN',
        severity: 'HIGH',
        description: `${recentPatterns.length} recent frontrun pattern(s) detected`,
        confidence: 0.8,
        evidence: { patternCount: recentPatterns.length },
      });
      score += 20;
    }

    // Check for coordinated trading patterns
    const coordinatedTraders = new Map<string, number>();
    recentPatterns.forEach((pattern) => {
      coordinatedTraders.set(
        pattern.botAddress,
        (coordinatedTraders.get(pattern.botAddress) || 0) + 1,
      );
    });

    const suspiciousTraders = Array.from(coordinatedTraders.entries()).filter(
      ([_, count]) => count >= 3,
    );
    if (suspiciousTraders.length > 0) {
      indicators.push({
        type: 'COORDINATED_TRADES',
        severity: 'MEDIUM',
        description: `Coordinated trading activity detected from ${suspiciousTraders.length} address(es)`,
        confidence: 0.7,
        evidence: { suspiciousTraders },
      });
      score += 15;
    }

    return { indicators, score };
  }

  /**
   * Analyzes price impact variance for manipulation signs
   */
  private async assessPriceImpactRisk(
    tokenMint: string,
    tradeAmountSOL: number,
    userPublicKey: PublicKey,
    expectedPriceImpact?: number,
  ): Promise<{ indicators: SandwichIndicator[]; score: number }> {
    const indicators: SandwichIndicator[] = [];
    let score = 0;

    try {
      // Calculate current price impact
      const route = await computeSwapHttp(tokenMint, tradeAmountSOL, userPublicKey);
      if (!route || !route.priceImpactPct) {
        return { indicators, score };
      }

      const currentImpact = parseFloat(route.priceImpactPct);

      // Store price history
      const history = this.priceHistoryCache.get(tokenMint) || [];
      history.push({
        price: parseFloat(route.outAmount || '0'),
        timestamp: Date.now(),
        impact: currentImpact,
      });

      // Keep only recent entries
      const filtered = history.filter((entry) => Date.now() - entry.timestamp < 300000);
      this.priceHistoryCache.set(tokenMint, filtered);

      // Check for unusual price impact variance
      if (filtered.length >= 3) {
        const impacts = filtered.map((entry) => entry.impact);
        const variance = this.calculateVariance(impacts);
        const avgImpact = impacts.reduce((sum, impact) => sum + impact, 0) / impacts.length;

        // High variance indicates possible manipulation
        if (variance > avgImpact * 0.5) {
          indicators.push({
            type: 'HIGH_SLIPPAGE_VARIANCE',
            severity: 'MEDIUM',
            description: `High price impact variance detected (${variance.toFixed(2)})`,
            confidence: 0.6,
            evidence: { variance, averageImpact: avgImpact },
          });
          score += 12;
        }
      }

      // Compare with expected impact if provided
      if (expectedPriceImpact !== undefined) {
        const impactDifference = Math.abs(currentImpact - expectedPriceImpact);
        if (impactDifference > expectedPriceImpact * 0.3) {
          // 30% difference
          indicators.push({
            type: 'PRICE_MANIPULATION',
            severity: 'HIGH',
            description: `Price impact significantly different than expected (${impactDifference.toFixed(2)}% vs ${expectedPriceImpact.toFixed(2)}%)`,
            confidence: 0.8,
            evidence: { expected: expectedPriceImpact, actual: currentImpact },
          });
          score += 20;
        }
      }
    } catch (error) {
      logger.warn('SANDWICH_DETECTION', 'Failed to assess price impact risk', {
        tokenMint: tokenMint.substring(0, 8) + '...',
        error: (error as Error).message,
      });
    }

    return { indicators, score };
  }

  /**
   * Detects priority fee anomalies that may indicate MEV activity
   */
  private assessPriorityFeeAnomaly(analysis: MempoolAnalysis): {
    indicators: SandwichIndicator[];
    score: number;
  } {
    const indicators: SandwichIndicator[] = [];
    let score = 0;

    if (analysis.recentTransactions.length === 0) {
      return { indicators, score };
    }

    // Calculate priority fee statistics
    const fees = analysis.recentTransactions
      .map((tx) => tx.priorityFee || 0)
      .filter((fee) => fee > 0);

    if (fees.length >= 3) {
      const avgFee = fees.reduce((sum, fee) => sum + fee, 0) / fees.length;
      const maxFee = Math.max(...fees);

      // Unusual priority fee spikes
      if (maxFee > avgFee * 5) {
        indicators.push({
          type: 'UNUSUAL_PRIORITY_FEES',
          severity: 'MEDIUM',
          description: `Unusual priority fee spike detected (${maxFee} vs avg ${avgFee.toFixed(0)})`,
          confidence: 0.7,
          evidence: { maxFee, averageFee: avgFee, ratio: maxFee / avgFee },
        });
        score += 10;
      }
    }

    return { indicators, score };
  }

  /**
   * Assesses network congestion impact on MEV risk
   */
  private async assessNetworkCongestion(
    connection: Connection,
  ): Promise<{ indicators: SandwichIndicator[]; score: number }> {
    const indicators: SandwichIndicator[] = [];
    let score = 0;

    try {
      // Get recent prioritization fees to assess congestion
      const fees = await connection.getRecentPrioritizationFees();
      if (fees && fees.length > 10) {
        const avgFee = fees.reduce((sum, f) => sum + f.prioritizationFee, 0) / fees.length;

        // High fees indicate congestion and potential MEV competition
        if (avgFee > 50000) {
          // > 50k microlamports per CU
          indicators.push({
            type: 'MEMPOOL_CONGESTION',
            severity: 'HIGH',
            description: `High network congestion detected (${avgFee.toFixed(0)} μLamports/CU)`,
            confidence: 0.8,
            evidence: { averagePriorityFee: avgFee },
          });
          score += 15;
        } else if (avgFee > 10000) {
          indicators.push({
            type: 'MEMPOOL_CONGESTION',
            severity: 'MEDIUM',
            description: `Moderate network congestion detected`,
            confidence: 0.6,
            evidence: { averagePriorityFee: avgFee },
          });
          score += 8;
        }
      }
    } catch (error) {
      logger.warn('SANDWICH_DETECTION', 'Failed to assess network congestion', {
        error: (error as Error).message,
      });
    }

    return { indicators, score };
  }

  /**
   * Determines risk level from score
   */
  private getRiskLevel(score: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
    if (score >= 80) return 'CRITICAL';
    if (score >= 50) return 'HIGH';
    if (score >= 25) return 'MEDIUM';
    return 'LOW';
  }

  /**
   * Generates recommendations based on risk assessment
   */
  private generateRecommendations(
    riskLevel: string,
    indicators: SandwichIndicator[],
    tradeAmountSOL: number,
  ): string[] {
    const recommendations: string[] = [];

    switch (riskLevel) {
      case 'CRITICAL':
        recommendations.push('ABORT: Extremely high sandwich risk detected');
        recommendations.push('Wait for market conditions to improve');
        recommendations.push('Consider breaking trade into smaller amounts');
        break;

      case 'HIGH':
        recommendations.push('Use private mempool (Jito bundles) for execution');
        recommendations.push('Increase priority fees significantly');
        recommendations.push('Delay execution by 3-10 seconds');
        recommendations.push('Monitor for MEV bot activity before executing');
        break;

      case 'MEDIUM':
        recommendations.push('Consider using private mempool');
        recommendations.push('Increase priority fees moderately');
        recommendations.push('Brief delay (1-3 seconds) may be beneficial');
        break;

      case 'LOW':
        recommendations.push('Standard execution recommended');
        recommendations.push('Monitor transaction for unusual activity');
        break;
    }

    // Specific recommendations based on indicators
    const hasLargeTradeIndicator = indicators.some((i) => i.type === 'LARGE_PRECEDING_TRADE');
    if (hasLargeTradeIndicator) {
      recommendations.push('Wait for large trade impact to settle');
    }

    const hasMEVBotIndicator = indicators.some((i) => i.type === 'SUSPICIOUS_MEV_BOT');
    if (hasMEVBotIndicator) {
      recommendations.push('Mandatory private mempool usage');
      recommendations.push('Consider significant delay (10+ seconds)');
    }

    if (tradeAmountSOL > 0.1) {
      recommendations.push('Large trade detected - consider splitting');
    }

    return recommendations;
  }

  /**
   * Calculates optimal delay based on risk factors
   */
  private calculateOptimalDelay(riskLevel: string, indicators: SandwichIndicator[]): number {
    let baseDelay = 0;

    switch (riskLevel) {
      case 'CRITICAL':
        baseDelay = 10000;
        break; // 10 seconds
      case 'HIGH':
        baseDelay = 5000;
        break; // 5 seconds
      case 'MEDIUM':
        baseDelay = 2000;
        break; // 2 seconds
      default:
        baseDelay = 0;
    }

    // Add extra delay for specific indicators
    indicators.forEach((indicator) => {
      if (indicator.type === 'SUSPICIOUS_MEV_BOT') {
        baseDelay += 5000; // Additional 5 seconds for MEV bots
      }
      if (indicator.type === 'LARGE_PRECEDING_TRADE') {
        baseDelay += 2000; // Additional 2 seconds for large trades
      }
    });

    // Cap maximum delay
    return Math.min(baseDelay, 30000); // Maximum 30 seconds
  }

  /**
   * Records detected MEV activity for pattern analysis
   */
  recordMEVActivity(
    tokenMint: string,
    pattern: 'FRONTRUN' | 'BACKRUN' | 'SANDWICH',
    botAddress: string,
    tradeSize: number,
    priceImpact: number,
  ): void {
    this.recentPatterns.push({
      tokenMint,
      pattern,
      timestamp: Date.now(),
      botAddress,
      tradeSize,
      priceImpact,
    });

    // Add to suspicious addresses
    this.suspiciousAddresses.add(botAddress);

    logger.info('SANDWICH_DETECTION', 'MEV activity recorded', {
      tokenMint: tokenMint.substring(0, 8) + '...',
      pattern,
      botAddress: botAddress.substring(0, 8) + '...',
      tradeSize,
      priceImpact,
    });
  }

  /**
   * Utility functions
   */
  private extractPriorityFee(tx: ParsedTransactionWithMeta): number {
    // Try to extract priority fee from transaction
    // This is a simplified implementation - real implementation would need
    // to parse compute budget instructions
    return 0; // Placeholder
  }

  private calculateVariance(numbers: number[]): number {
    if (numbers.length < 2) return 0;

    const mean = numbers.reduce((sum, num) => sum + num, 0) / numbers.length;
    const variance =
      numbers.reduce((sum, num) => sum + Math.pow(num - mean, 2), 0) / numbers.length;

    return variance;
  }

  private loadKnownMEVBots(): void {
    // Load known MEV bot addresses (this would come from a curated list)
    const knownMEVBots: string[] = [
      // Add known MEV bot addresses here
      // These would be maintained as part of the bot's intelligence
    ];

    knownMEVBots.forEach((address) => this.suspiciousAddresses.add(address));

    logger.info('SANDWICH_DETECTION', 'Loaded known MEV bot addresses', {
      count: knownMEVBots.length,
    });
  }
}

// Export singleton instance
const sandwichDetectionSystem = new SandwichDetectionSystem();
export default sandwichDetectionSystem;
