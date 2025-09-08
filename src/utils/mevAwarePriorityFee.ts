// src/utils/mevAwarePriorityFee.ts
// MEV-aware priority fee calculation with enhanced protection strategies

import { Connection, PublicKey } from '@solana/web3.js';
import { calcPriorityFeeSOL } from './priorityFee.js';
import networkHealthMonitor from './networkHealth.js';
import logger from './logger.js';
import { loadBotConfig } from '../config/index.js';

export interface MEVRiskFactors {
  tradeSize: number; // SOL amount being traded
  tokenLiquidity: number; // Token's total liquidity
  priceImpact: number; // Expected price impact %
  marketCapSol: number; // Token market cap in SOL
  isNewToken: boolean; // Token age < 1 hour
  networkCongestion: number; // Network congestion level 0-1
  mempoolActivity: number; // Recent mempool activity score
}

export interface MEVAwareFeeCalculation {
  basePriorityFee: number; // Standard priority fee in SOL
  mevAdjustment: number; // MEV protection adjustment in SOL
  totalFee: number; // Total priority fee in SOL
  bundleTip: number; // Recommended bundle tip in SOL
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  riskScore: number; // MEV risk score 0-100
  explanation: string[]; // Reasons for fee adjustments
}

class MEVAwarePriorityFeeCalculator {
  private config: any;
  private recentMevEvents: Map<string, number> = new Map(); // Track recent MEV activity by token
  private networkActivityCache: { timestamp: number; score: number } | null = null;

  constructor() {
    this.config = loadBotConfig();

    // Clean up old MEV events every 5 minutes
    setInterval(() => {
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
      for (const [token, timestamp] of this.recentMevEvents) {
        if (timestamp < fiveMinutesAgo) {
          this.recentMevEvents.delete(token);
        }
      }
    }, 60000); // Run every minute
  }

  /**
   * Calculates MEV-aware priority fee with protection adjustments
   */
  async calculateMEVAwareFee(
    connection: Connection,
    riskFactors: MEVRiskFactors,
    tokenMint?: string,
    targetUnits = 1_200_000,
  ): Promise<MEVAwareFeeCalculation> {
    const startTime = Date.now();

    try {
      // Get base priority fee
      const basePriorityFee = await calcPriorityFeeSOL(connection, targetUnits, 0.9);

      // Calculate MEV risk score
      const riskScore = await this.calculateMEVRiskScore(riskFactors, tokenMint);

      // Determine risk level
      const riskLevel = this.getRiskLevel(riskScore);

      // Calculate MEV protection adjustments
      const { mevAdjustment, bundleTip, explanation } = await this.calculateMEVAdjustments(
        basePriorityFee,
        riskScore,
        riskLevel,
        riskFactors,
      );

      const totalFee = basePriorityFee + mevAdjustment;

      logger.debug('MEV_PRIORITY_FEE', 'MEV-aware fee calculated', {
        tokenMint: tokenMint?.substring(0, 8) + '...' || 'unknown',
        riskScore,
        riskLevel,
        baseFee: basePriorityFee.toFixed(6),
        mevAdjustment: mevAdjustment.toFixed(6),
        totalFee: totalFee.toFixed(6),
        bundleTip: bundleTip.toFixed(6),
        calculationTime: Date.now() - startTime,
      });

      return {
        basePriorityFee,
        mevAdjustment,
        totalFee,
        bundleTip,
        riskLevel,
        riskScore,
        explanation,
      };
    } catch (error) {
      logger.error('MEV_PRIORITY_FEE', 'Error calculating MEV-aware fee', {
        tokenMint: tokenMint?.substring(0, 8) + '...' || 'unknown',
        error: (error as Error).message,
      });

      // Fallback to basic calculation with moderate protection
      const baseFee = await calcPriorityFeeSOL(connection, targetUnits, 0.95);
      return {
        basePriorityFee: baseFee,
        mevAdjustment: baseFee * 0.5, // 50% increase for safety
        totalFee: baseFee * 1.5,
        bundleTip: 0.0005, // Medium protection tip
        riskLevel: 'MEDIUM',
        riskScore: 50,
        explanation: ['Fallback calculation due to error'],
      };
    }
  }

  /**
   * Calculates comprehensive MEV risk score (0-100)
   */
  private async calculateMEVRiskScore(
    riskFactors: MEVRiskFactors,
    tokenMint?: string,
  ): Promise<number> {
    let riskScore = 0;

    // Trade size impact (0-25 points)
    // Larger trades are more attractive for MEV
    const tradeSizeRisk = Math.min(25, (riskFactors.tradeSize / 0.5) * 15); // 0.5 SOL = high risk
    riskScore += tradeSizeRisk;

    // Price impact risk (0-20 points)
    // Higher price impact = more MEV opportunity
    const priceImpactRisk = Math.min(20, riskFactors.priceImpact * 2); // 10% impact = 20 points
    riskScore += priceImpactRisk;

    // Liquidity risk (0-15 points)
    // Lower liquidity = higher MEV risk
    const liquidityRisk =
      riskFactors.tokenLiquidity < 10
        ? 15
        : riskFactors.tokenLiquidity < 50
          ? 10
          : riskFactors.tokenLiquidity < 100
            ? 5
            : 0;
    riskScore += liquidityRisk;

    // New token premium (0-15 points)
    // New tokens have higher MEV activity
    const newTokenRisk = riskFactors.isNewToken ? 15 : 0;
    riskScore += newTokenRisk;

    // Network congestion multiplier (0-10 points)
    // High congestion = more MEV competition
    const congestionRisk = riskFactors.networkCongestion * 10;
    riskScore += congestionRisk;

    // Market cap factor (0-10 points)
    // Smaller market caps are more manipulable
    const marketCapRisk =
      riskFactors.marketCapSol < 50_000
        ? 10 // < 50k SOL
        : riskFactors.marketCapSol < 200_000
          ? 5 // < 200k SOL
          : 0;
    riskScore += marketCapRisk;

    // Recent MEV activity (0-5 points)
    if (tokenMint && this.recentMevEvents.has(tokenMint)) {
      const recentActivity = Date.now() - this.recentMevEvents.get(tokenMint)!;
      if (recentActivity < 60000) {
        // Within 1 minute
        riskScore += 5;
      } else if (recentActivity < 300000) {
        // Within 5 minutes
        riskScore += 3;
      }
    }

    return Math.min(100, Math.max(0, riskScore));
  }

  /**
   * Determines risk level from score
   */
  private getRiskLevel(riskScore: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
    if (riskScore >= 80) return 'CRITICAL';
    if (riskScore >= 60) return 'HIGH';
    if (riskScore >= 30) return 'MEDIUM';
    return 'LOW';
  }

  /**
   * Calculates MEV protection adjustments
   */
  private async calculateMEVAdjustments(
    baseFee: number,
    riskScore: number,
    riskLevel: string,
    riskFactors: MEVRiskFactors,
  ): Promise<{ mevAdjustment: number; bundleTip: number; explanation: string[] }> {
    const explanation: string[] = [];
    let mevAdjustment = 0;
    let bundleTip = 0.0001; // Base tip

    // Base MEV adjustment based on risk level
    switch (riskLevel) {
      case 'LOW':
        mevAdjustment = baseFee * 0.1; // 10% increase
        bundleTip = 0.0001;
        explanation.push('Low MEV risk - minimal fee adjustment');
        break;
      case 'MEDIUM':
        mevAdjustment = baseFee * 0.3; // 30% increase
        bundleTip = 0.0005;
        explanation.push('Medium MEV risk - standard protection');
        break;
      case 'HIGH':
        mevAdjustment = baseFee * 0.6; // 60% increase
        bundleTip = 0.001;
        explanation.push('High MEV risk - enhanced protection');
        break;
      case 'EXTREME':
        mevAdjustment = baseFee * 1.0; // 100% increase
        bundleTip = 0.002;
        explanation.push('Extreme MEV risk - maximum protection');
        break;
    }

    // Additional adjustments for specific risk factors

    // Large trade size multiplier
    if (riskFactors.tradeSize > 0.1) {
      const sizeMultiplier = Math.min(0.5, (riskFactors.tradeSize - 0.1) * 2);
      mevAdjustment += baseFee * sizeMultiplier;
      bundleTip += 0.0002 * sizeMultiplier;
      explanation.push(
        `Large trade size (${riskFactors.tradeSize.toFixed(3)} SOL) - increased protection`,
      );
    }

    // High price impact adjustment
    if (riskFactors.priceImpact > 5) {
      const impactMultiplier = Math.min(0.3, (riskFactors.priceImpact - 5) / 10);
      mevAdjustment += baseFee * impactMultiplier;
      explanation.push(
        `High price impact (${riskFactors.priceImpact.toFixed(1)}%) - sandwich protection`,
      );
    }

    // Network congestion adjustment
    if (riskFactors.networkCongestion > 0.7) {
      const congestionBoost = baseFee * 0.2;
      mevAdjustment += congestionBoost;
      explanation.push('High network congestion - competitive priority needed');
    }

    // New token premium
    if (riskFactors.isNewToken) {
      mevAdjustment += baseFee * 0.25;
      bundleTip += 0.0003;
      explanation.push('New token detected - enhanced MEV protection');
    }

    // Apply configured limits
    const maxFeeMultiplier = this.config.mevProtection?.maxFeeMultiplier ?? 3.0;
    const maxTotalFee = baseFee * maxFeeMultiplier;

    if (baseFee + mevAdjustment > maxTotalFee) {
      mevAdjustment = maxTotalFee - baseFee;
      explanation.push(`Fee capped at ${maxFeeMultiplier}x base fee limit`);
    }

    // Ensure minimum viable tips
    bundleTip = Math.max(bundleTip, 0.0001);
    const maxTip = this.config.mevProtection?.maxBundleTip ?? 0.005;
    bundleTip = Math.min(bundleTip, maxTip);

    return { mevAdjustment, bundleTip, explanation };
  }

  /**
   * Records MEV activity for a token to inform future calculations
   */
  recordMEVActivity(tokenMint: string): void {
    this.recentMevEvents.set(tokenMint, Date.now());
    logger.debug('MEV_PRIORITY_FEE', 'Recorded MEV activity', {
      tokenMint: tokenMint.substring(0, 8) + '...',
      timestamp: Date.now(),
    });
  }

  /**
   * Estimates current network MEV activity level
   */
  async estimateNetworkMEVActivity(connection: Connection): Promise<number> {
    try {
      // Cache network activity calculation for 30 seconds
      const now = Date.now();
      if (this.networkActivityCache && now - this.networkActivityCache.timestamp < 30000) {
        return this.networkActivityCache.score;
      }

      // Get recent prioritization fees to estimate activity
      const fees = await connection.getRecentPrioritizationFees();
      if (!fees || fees.length === 0) {
        this.networkActivityCache = { timestamp: now, score: 0.3 };
        return 0.3;
      }

      // Calculate fee variance and outliers as indicators of MEV activity
      const priorityFees = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
      const median = priorityFees[Math.floor(priorityFees.length / 2)];
      const p95 = priorityFees[Math.floor(priorityFees.length * 0.95)];

      // High variance indicates MEV competition
      const varianceRatio = median > 0 ? p95 / median : 1;
      const activityScore = Math.min(1, varianceRatio / 10); // Normalize to 0-1

      this.networkActivityCache = { timestamp: now, score: activityScore };

      logger.debug('MEV_PRIORITY_FEE', 'Network MEV activity estimated', {
        medianFee: median,
        p95Fee: p95,
        varianceRatio: varianceRatio.toFixed(2),
        activityScore: activityScore.toFixed(3),
      });

      return activityScore;
    } catch (error) {
      logger.warn('MEV_PRIORITY_FEE', 'Failed to estimate network MEV activity', {
        error: (error as Error).message,
      });
      return 0.5; // Default moderate activity
    }
  }

  /**
   * Gets recommended settings based on current market conditions
   */
  async getRecommendedProtectionLevel(
    connection: Connection,
    riskFactors: MEVRiskFactors,
  ): Promise<'LOW' | 'MEDIUM' | 'HIGH' | 'AGGRESSIVE'> {
    const networkActivity = await this.estimateNetworkMEVActivity(connection);
    const riskScore = await this.calculateMEVRiskScore(riskFactors);

    // Combine risk factors to recommend protection level
    const combinedScore = riskScore * 0.7 + networkActivity * 30;

    if (combinedScore >= 75) return 'AGGRESSIVE';
    if (combinedScore >= 60) return 'HIGH';
    if (combinedScore >= 35) return 'MEDIUM';
    return 'LOW';
  }
}

// Export singleton instance
const mevAwarePriorityFeeCalculator = new MEVAwarePriorityFeeCalculator();
export default mevAwarePriorityFeeCalculator;

// Types are already exported above
