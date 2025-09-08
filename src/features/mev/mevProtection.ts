// src/core/mevProtection.ts
// Main MEV protection orchestrator - coordinates all MEV protection systems

import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import jitoBundleManager, { BundleSubmissionResult } from '../utils/jitoBundle.js';
import mevAwarePriorityFeeCalculator, {
  MEVRiskFactors,
  MEVAwareFeeCalculation,
} from '../utils/mevAwarePriorityFee.js';
import sandwichDetectionSystem, { SandwichRiskAssessment } from '../utils/sandwichDetection.js';
import logger from '../utils/logger.js';
import { loadBotConfig } from '../config/index.js';
import metricsCollector from '../utils/metricsCollector.js';

export interface MEVProtectionRequest {
  tokenMint: string;
  tradeAmountSOL: number;
  userPublicKey: PublicKey;
  connection: Connection;
  expectedPriceImpact?: number;
  marketCapSol?: number;
  tokenLiquidity?: number;
  isNewToken?: boolean;
  deployer?: string;
}

export interface MEVProtectionResult {
  shouldProceed: boolean;
  usePrivateMempool: boolean;
  delayMs: number;
  priorityFee: number;
  bundleTip?: number;
  protectionLevel: 'NONE' | 'BASIC' | 'STANDARD' | 'AGGRESSIVE';
  riskAssessment: {
    sandwichRisk: SandwichRiskAssessment;
    feeCalculation: MEVAwareFeeCalculation;
    overallRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    riskScore: number;
  };
  recommendations: string[];
  reason?: string;
}

export interface MEVProtectedTradeExecution {
  success: boolean;
  signature?: string;
  bundleId?: string;
  executionMethod: 'STANDARD' | 'JITO_BUNDLE';
  protectionApplied: string[];
  executionTime: number;
  error?: string;
  mevSavingsEstimate?: number; // Estimated SOL saved from MEV protection
}

class MEVProtectionOrchestrator {
  private config: any;
  private protectionStats = {
    totalTrades: 0,
    protectedTrades: 0,
    savedFromMEV: 0,
    bundleSuccessRate: 0,
  };

  constructor() {
    this.config = loadBotConfig();

    // Log protection system initialization
    logger.info('MEV_PROTECTION', 'MEV Protection System initialized', {
      enabled: this.config.mevProtection?.enabled ?? true,
      defaultProtectionLevel: this.config.mevProtection?.protectionLevel ?? 'MEDIUM',
      jitoEnabled: jitoBundleManager.getConfig().enabled,
    });
  }

  /**
   * Comprehensive MEV protection analysis and recommendation
   */
  async analyzeMEVRisk(request: MEVProtectionRequest): Promise<MEVProtectionResult> {
    const startTime = Date.now();

    try {
      logger.info('MEV_PROTECTION', 'Starting MEV risk analysis', {
        tokenMint: request.tokenMint.substring(0, 8) + '...',
        tradeAmount: request.tradeAmountSOL,
        expectedPriceImpact: request.expectedPriceImpact,
      });

      // 1. Sandwich attack detection
      const sandwichRisk = await sandwichDetectionSystem.assessSandwichRisk(
        request.tokenMint,
        request.tradeAmountSOL,
        request.userPublicKey,
        request.connection,
        request.expectedPriceImpact,
      );

      // 2. MEV-aware priority fee calculation
      const riskFactors: MEVRiskFactors = {
        tradeSize: request.tradeAmountSOL,
        tokenLiquidity: request.tokenLiquidity ?? 0,
        priceImpact: request.expectedPriceImpact ?? 0,
        marketCapSol: request.marketCapSol ?? 0,
        isNewToken: request.isNewToken ?? false,
        networkCongestion: await this.estimateNetworkCongestion(request.connection),
        mempoolActivity: await mevAwarePriorityFeeCalculator.estimateNetworkMEVActivity(
          request.connection,
        ),
      };

      const feeCalculation = await mevAwarePriorityFeeCalculator.calculateMEVAwareFee(
        request.connection,
        riskFactors,
        request.tokenMint,
      );

      // 3. Overall risk assessment
      const overallRisk = this.calculateOverallRisk(sandwichRisk, feeCalculation);
      const riskScore = this.calculateOverallRiskScore(sandwichRisk, feeCalculation);

      // 4. Determine protection strategy
      const protectionStrategy = this.determineProtectionStrategy(
        overallRisk,
        sandwichRisk,
        feeCalculation,
        request.tradeAmountSOL,
      );

      // 5. Generate comprehensive recommendations
      const recommendations = this.generateComprehensiveRecommendations(
        sandwichRisk,
        feeCalculation,
        protectionStrategy,
        request,
      );

      const result: MEVProtectionResult = {
        shouldProceed: protectionStrategy.shouldProceed,
        usePrivateMempool: protectionStrategy.usePrivateMempool,
        delayMs: protectionStrategy.delayMs,
        priorityFee: feeCalculation.totalFee,
        bundleTip: protectionStrategy.usePrivateMempool ? feeCalculation.bundleTip : undefined,
        protectionLevel: protectionStrategy.level,
        riskAssessment: {
          sandwichRisk,
          feeCalculation,
          overallRisk,
          riskScore,
        },
        recommendations,
        reason: protectionStrategy.reason,
      };

      logger.info('MEV_PROTECTION', 'MEV risk analysis completed', {
        tokenMint: request.tokenMint.substring(0, 8) + '...',
        overallRisk,
        riskScore,
        protectionLevel: protectionStrategy.level,
        usePrivateMempool: protectionStrategy.usePrivateMempool,
        shouldProceed: protectionStrategy.shouldProceed,
        delayMs: protectionStrategy.delayMs,
        analysisTime: Date.now() - startTime,
      });

      // Record metrics
      metricsCollector.recordMEVAnalysis(
        overallRisk,
        protectionStrategy.level,
        Date.now() - startTime,
      );

      return result;
    } catch (error) {
      logger.error('MEV_PROTECTION', 'MEV risk analysis failed', {
        tokenMint: request.tokenMint.substring(0, 8) + '...',
        error: (error as Error).message,
        stack: (error as Error).stack,
      });

      // Return conservative fallback
      return {
        shouldProceed: false,
        usePrivateMempool: true,
        delayMs: 5000,
        priorityFee: 0.001,
        bundleTip: 0.001,
        protectionLevel: 'AGGRESSIVE',
        riskAssessment: {
          sandwichRisk: {
            riskLevel: 'HIGH',
            riskScore: 75,
            indicators: [],
            recommendations: ['Analysis failed - using conservative approach'],
            shouldDelay: true,
            delayMs: 5000,
            shouldUsePrivateMempool: true,
          },
          feeCalculation: {
            basePriorityFee: 0.0005,
            mevAdjustment: 0.0005,
            totalFee: 0.001,
            bundleTip: 0.001,
            riskLevel: 'HIGH',
            riskScore: 75,
            explanation: ['Fallback calculation'],
          },
          overallRisk: 'HIGH',
          riskScore: 75,
        },
        recommendations: ['Analysis error - recommend aborting or retrying'],
        reason: 'MEV analysis system error',
      };
    }
  }

  /**
   * Executes a MEV-protected trade
   */
  async executeMEVProtectedTrade(
    transaction: VersionedTransaction,
    payer: Keypair,
    connection: Connection,
    protection: MEVProtectionResult,
  ): Promise<MEVProtectedTradeExecution> {
    const startTime = Date.now();
    this.protectionStats.totalTrades++;

    try {
      const protectionApplied: string[] = [];

      // Apply delay if recommended
      if (protection.delayMs > 0) {
        logger.info('MEV_PROTECTION', 'Applying protection delay', {
          delayMs: protection.delayMs,
          reason: 'Sandwich attack mitigation',
        });

        await new Promise((resolve) => setTimeout(resolve, protection.delayMs));
        protectionApplied.push(`${protection.delayMs}ms delay`);
      }

      let result: MEVProtectedTradeExecution;

      // Execute based on protection level
      if (protection.usePrivateMempool) {
        this.protectionStats.protectedTrades++;

        logger.info('MEV_PROTECTION', 'Executing via private mempool (Jito bundle)', {
          protectionLevel: protection.protectionLevel,
          bundleTip: protection.bundleTip,
        });

        // Execute via Jito bundle
        const bundleResult = await jitoBundleManager.submitBundle(
          [transaction],
          payer,
          connection,
          protection.bundleTip,
        );

        protectionApplied.push('Private mempool (Jito bundle)');
        protectionApplied.push(`Enhanced priority fee: ${protection.priorityFee.toFixed(6)} SOL`);
        if (protection.bundleTip) {
          protectionApplied.push(`Bundle tip: ${protection.bundleTip.toFixed(6)} SOL`);
        }

        result = {
          success: bundleResult.success,
          signature: bundleResult.signature,
          bundleId: bundleResult.bundleId,
          executionMethod: 'JITO_BUNDLE',
          protectionApplied,
          executionTime: Date.now() - startTime,
          error: bundleResult.error,
          mevSavingsEstimate: this.estimateMEVSavings(protection),
        };

        // Update bundle success rate
        if (bundleResult.success) {
          this.protectionStats.bundleSuccessRate = (this.protectionStats.bundleSuccessRate + 1) / 2; // Moving average
        } else {
          this.protectionStats.bundleSuccessRate = this.protectionStats.bundleSuccessRate * 0.9; // Decay on failure
        }
      } else {
        logger.info('MEV_PROTECTION', 'Executing via standard method', {
          protectionLevel: protection.protectionLevel,
          priorityFee: protection.priorityFee,
        });

        // Execute via standard RPC with enhanced priority fees
        try {
          const signature = await connection.sendTransaction(transaction, {
            maxRetries: 3,
            skipPreflight: false,
          });

          protectionApplied.push('Enhanced priority fee');

          result = {
            success: true,
            signature,
            executionMethod: 'STANDARD',
            protectionApplied,
            executionTime: Date.now() - startTime,
            mevSavingsEstimate: this.estimateMEVSavings(protection),
          };
        } catch (error) {
          result = {
            success: false,
            executionMethod: 'STANDARD',
            protectionApplied,
            executionTime: Date.now() - startTime,
            error: (error as Error).message,
          };
        }
      }

      // Record execution metrics
      metricsCollector.recordMEVProtectedTrade(
        result.executionMethod,
        result.success ? 'success' : 'failure',
        protection.protectionLevel,
        Date.now() - startTime,
      );

      // Update MEV savings estimate
      if (result.success && result.mevSavingsEstimate) {
        this.protectionStats.savedFromMEV += result.mevSavingsEstimate;
      }

      logger.info('MEV_PROTECTION', 'MEV-protected trade execution completed', {
        success: result.success,
        executionMethod: result.executionMethod,
        protectionApplied,
        executionTime: result.executionTime,
        mevSavingsEstimate: result.mevSavingsEstimate,
        signature: result.signature?.substring(0, 8) + '...' || 'none',
      });

      return result;
    } catch (error) {
      logger.error('MEV_PROTECTION', 'MEV-protected trade execution failed', {
        error: (error as Error).message,
        stack: (error as Error).stack,
      });

      return {
        success: false,
        executionMethod: protection.usePrivateMempool ? 'JITO_BUNDLE' : 'STANDARD',
        protectionApplied: ['Error during execution'],
        executionTime: Date.now() - startTime,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Gets MEV protection statistics
   */
  getProtectionStats(): any {
    return {
      ...this.protectionStats,
      protectionRate:
        this.protectionStats.totalTrades > 0
          ? (this.protectionStats.protectedTrades / this.protectionStats.totalTrades) * 100
          : 0,
    };
  }

  /**
   * Health check for all MEV protection systems
   */
  async healthCheck(): Promise<{ healthy: boolean; components: any }> {
    const components = {
      jitoBundle: await jitoBundleManager.healthCheck(),
      sandwichDetection: { healthy: true }, // Sandwich detection is always available
      priorityFeeCalculator: { healthy: true }, // Priority fee calc is always available
    };

    const healthy = Object.values(components).every((comp: any) => comp.healthy);

    logger.debug('MEV_PROTECTION', 'Health check completed', {
      overall: healthy,
      components,
    });

    return { healthy, components };
  }

  /**
   * Private helper methods
   */

  private calculateOverallRisk(
    sandwichRisk: SandwichRiskAssessment,
    feeCalculation: MEVAwareFeeCalculation,
  ): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
    const riskLevels = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

    const sandwichScore = riskLevels[sandwichRisk.riskLevel];
    const feeScore = riskLevels[feeCalculation.riskLevel];

    const maxScore = Math.max(sandwichScore, feeScore);
    const avgScore = (sandwichScore + feeScore) / 2;

    // Use maximum risk with averaging for boundary cases
    const finalScore =
      maxScore >= 4 ? 4 : avgScore >= 3.5 ? 4 : avgScore >= 2.5 ? 3 : avgScore >= 1.5 ? 2 : 1;

    const levels = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
    return levels[finalScore - 1] as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  }

  private calculateOverallRiskScore(
    sandwichRisk: SandwichRiskAssessment,
    feeCalculation: MEVAwareFeeCalculation,
  ): number {
    // Weighted combination of risk scores
    return Math.min(100, sandwichRisk.riskScore * 0.6 + feeCalculation.riskScore * 0.4);
  }

  private determineProtectionStrategy(
    overallRisk: string,
    sandwichRisk: SandwichRiskAssessment,
    feeCalculation: MEVAwareFeeCalculation,
    tradeAmount: number,
  ): {
    shouldProceed: boolean;
    usePrivateMempool: boolean;
    delayMs: number;
    level: 'NONE' | 'BASIC' | 'STANDARD' | 'AGGRESSIVE';
    reason?: string;
  } {
    // Check if MEV protection is globally disabled
    if (!this.config.mevProtection?.enabled) {
      return {
        shouldProceed: true,
        usePrivateMempool: false,
        delayMs: 0,
        level: 'NONE',
        reason: 'MEV protection disabled in configuration',
      };
    }

    switch (overallRisk) {
      case 'CRITICAL':
        // Abort trades with critical MEV risk
        return {
          shouldProceed: false,
          usePrivateMempool: true,
          delayMs: sandwichRisk.delayMs || 10000,
          level: 'AGGRESSIVE',
          reason: 'Critical MEV risk detected - trade aborted for safety',
        };

      case 'HIGH':
        return {
          shouldProceed: true,
          usePrivateMempool: true,
          delayMs: sandwichRisk.delayMs || 5000,
          level: 'AGGRESSIVE',
          reason: 'High MEV risk - maximum protection applied',
        };

      case 'MEDIUM':
        return {
          shouldProceed: true,
          usePrivateMempool: tradeAmount > 0.05, // Use bundles for larger trades
          delayMs: sandwichRisk.delayMs || 2000,
          level: 'STANDARD',
          reason: 'Medium MEV risk - standard protection applied',
        };

      case 'LOW':
      default:
        return {
          shouldProceed: true,
          usePrivateMempool: tradeAmount > 0.1, // Only for very large trades
          delayMs: 0,
          level: 'BASIC',
          reason: 'Low MEV risk - basic protection sufficient',
        };
    }
  }

  private generateComprehensiveRecommendations(
    sandwichRisk: SandwichRiskAssessment,
    feeCalculation: MEVAwareFeeCalculation,
    strategy: any,
    request: MEVProtectionRequest,
  ): string[] {
    const recommendations: string[] = [];

    // Add sandwich-specific recommendations
    recommendations.push(...sandwichRisk.recommendations);

    // Add fee-specific recommendations
    recommendations.push(...feeCalculation.explanation);

    // Add strategy-specific recommendations
    if (strategy.usePrivateMempool) {
      recommendations.push('Execute via private mempool (Jito bundles)');
    }

    if (strategy.delayMs > 0) {
      recommendations.push(`Apply ${strategy.delayMs}ms delay before execution`);
    }

    // Add trade-specific recommendations
    if (request.tradeAmountSOL > 0.1) {
      recommendations.push('Consider splitting large trade into smaller amounts');
    }

    if (request.isNewToken) {
      recommendations.push('New token detected - exercise extra caution');
    }

    return recommendations;
  }

  private async estimateNetworkCongestion(connection: Connection): Promise<number> {
    try {
      const fees = await connection.getRecentPrioritizationFees();
      if (!fees || fees.length === 0) return 0.3;

      const avgFee = fees.reduce((sum, f) => sum + f.prioritizationFee, 0) / fees.length;

      // Normalize to 0-1 scale
      return Math.min(1, avgFee / 100000); // 100k microlamports = high congestion
    } catch {
      return 0.3; // Default moderate congestion
    }
  }

  private estimateMEVSavings(protection: MEVProtectionResult): number {
    // Estimate MEV savings based on protection applied
    // This is a heuristic calculation

    let savings = 0;

    if (protection.usePrivateMempool) {
      // Private mempool typically saves 0.1-0.5% of trade value from MEV
      savings += protection.priorityFee * 0.002; // Estimated 0.2% savings
    }

    if (protection.delayMs > 0) {
      // Timing delays can save additional MEV
      savings += protection.priorityFee * 0.001; // Estimated 0.1% additional savings
    }

    return savings;
  }
}

// Export singleton instance
const mevProtectionOrchestrator = new MEVProtectionOrchestrator();
export default mevProtectionOrchestrator;

// Types are already exported above
