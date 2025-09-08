// src/core/dualExecutionStrategy.ts
// Dual execution strategy: Jito bundle (private mempool) + public fallback for maximum reliability

import {
  Connection,
  Keypair,
  VersionedTransaction,
  Transaction,
  PublicKey,
  TransactionSignature,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import jitoBundleManager from '../utils/jitoBundle.js';
import { sendMEVAwarePumpTrade } from '../utils/mevAwarePumpTrade.js';
import { sendPumpTrade } from '../utils/pumpTrade.js';
import { calcPriorityFeeSOL } from '../utils/priorityFee.js';
import logger from '../utils/logger.js';
import metricsCollector from '../utils/metricsCollector.js';
import { loadBotConfig } from '../config/index.js';
import transactionPrep from '../utils/transactionPreparation.js';

export enum ExecutionStrategy {
  JITO_ONLY = 'JITO_ONLY',
  PUBLIC_ONLY = 'PUBLIC_ONLY',
  JITO_WITH_FALLBACK = 'JITO_WITH_FALLBACK',
  PARALLEL_EXECUTION = 'PARALLEL_EXECUTION',
}

export enum ExecutionMethod {
  JITO_BUNDLE = 'JITO_BUNDLE',
  PUBLIC_MEMPOOL = 'PUBLIC_MEMPOOL',
  BOTH_SUCCEEDED = 'BOTH_SUCCEEDED',
}

export interface DualExecutionConfig {
  strategy: ExecutionStrategy;
  jitoEnabled: boolean;
  jitoTimeoutMs: number;
  publicFallbackDelayMs: number;
  maxExecutionTimeMs: number;
  priorityFeeMultiplier: {
    jito: number;
    public: number;
  };
  retryConfig: {
    maxRetries: number;
    retryDelayMs: number;
    exponentialBackoff: boolean;
  };
}

export interface ExecutionResult {
  success: boolean;
  method: ExecutionMethod;
  signature?: string;
  bundleId?: string;
  executionTime: number;
  executionMethod?: string; // For trading.ts compatibility
  priorityFee?: number;
  bundleTip?: number;
  totalCost?: number;
  tipUsed?: number;
  priorityFeeUsed?: number;
  error?: string;
  fallbackUsed: boolean;
  jitoAttempted: boolean;
  publicAttempted: boolean;
  details: {
    jitoResult?: {
      success: boolean;
      bundleId?: string;
      error?: string;
      executionTime: number;
    };
    publicResult?: {
      success: boolean;
      signature?: string;
      error?: string;
      executionTime: number;
    };
  };
}

export interface TradeParams {
  connection: Connection;
  wallet: Keypair;
  mint: string;
  amount: number;
  action: 'buy' | 'sell';
  slippage?: number;
  pool?: string;
  denominatedInSol?: boolean;
  customTipAmount?: number;
  maxDelayMs?: number;
  priorityFee?: number;
}

class DualExecutionStrategy {
  private config: DualExecutionConfig;
  private executionStats = {
    totalExecutions: 0,
    jitoSuccess: 0,
    publicSuccess: 0,
    fallbacksUsed: 0,
    parallelExecutions: 0,
  };

  constructor() {
    const botConfig = loadBotConfig();
    const dualConfig = botConfig.dualExecution || {};

    this.config = {
      strategy: this.parseStrategy(dualConfig.defaultStrategy || 'JITO_WITH_FALLBACK'),
      jitoEnabled: botConfig.mevProtection?.enabled ?? true,
      jitoTimeoutMs: dualConfig.jitoTimeoutMs ?? 3000,
      publicFallbackDelayMs: dualConfig.fallbackDelayMs ?? 1000,
      maxExecutionTimeMs: Math.max(
        dualConfig.jitoTimeoutMs ?? 3000,
        dualConfig.publicTimeoutMs ?? 8000,
      ),
      priorityFeeMultiplier: {
        jito: 1.0,
        public: dualConfig.priorityFeeMultiplier ?? 1.5,
      },
      retryConfig: {
        maxRetries: dualConfig.maxRetries ?? 2,
        retryDelayMs: 1000,
        exponentialBackoff: true,
      },
    };

    logger.info('DUAL_EXECUTION', 'Dual execution strategy initialized', {
      enabled: dualConfig.enabled ?? true,
      strategy: this.config.strategy,
      jitoTimeout: this.config.jitoTimeoutMs,
      publicTimeout: dualConfig.publicTimeoutMs ?? 8000,
      emergencyFallback: dualConfig.emergencyPublicFallback ?? true,
    });
  }

  /**
   * Dynamically select execution strategy based on risk level and trade parameters
   */
  selectStrategy(riskLevel: string, tradeAmount: number): ExecutionStrategy {
    const botConfig = loadBotConfig();
    const dualConfig = botConfig.dualExecution || {};
    const strategyConfig = dualConfig.strategySelection || {};

    if (!strategyConfig.autoSelectByRisk) {
      return this.config.strategy;
    }

    // Force strategies based on trade amount
    if (strategyConfig.forceJitoAboveAmount && tradeAmount >= strategyConfig.forceJitoAboveAmount) {
      return ExecutionStrategy.JITO_ONLY;
    }

    if (
      strategyConfig.forceParallelBelowAmount &&
      tradeAmount <= strategyConfig.forceParallelBelowAmount
    ) {
      return ExecutionStrategy.PARALLEL_EXECUTION;
    }

    // Select by risk level
    switch (riskLevel.toUpperCase()) {
      case 'HIGH':
        return this.parseStrategy(dualConfig.highRiskStrategy || 'JITO_ONLY');
      case 'LOW':
        return this.parseStrategy(dualConfig.lowRiskStrategy || 'PARALLEL_EXECUTION');
      case 'MEDIUM':
      default:
        return this.parseStrategy(dualConfig.defaultStrategy || 'JITO_WITH_FALLBACK');
    }
  }

  /**
   * Execute a trade using the configured dual execution strategy
   */
  async executeTrade(params: TradeParams): Promise<ExecutionResult> {
    const startTime = Date.now();
    this.executionStats.totalExecutions++;

    logger.info('DUAL_EXECUTION', 'Starting dual execution strategy', {
      strategy: this.config.strategy,
      jitoEnabled: this.config.jitoEnabled,
      mint: params.mint.substring(0, 8) + '...',
      action: params.action,
      amount: params.amount,
    });

    const result: ExecutionResult = {
      success: false,
      method: ExecutionMethod.PUBLIC_MEMPOOL,
      executionTime: 0,
      fallbackUsed: false,
      jitoAttempted: false,
      publicAttempted: false,
      details: {},
    };

    try {
      switch (this.config.strategy) {
        case ExecutionStrategy.JITO_ONLY:
          return await this.executeJitoOnly(params, result);

        case ExecutionStrategy.PUBLIC_ONLY:
          return await this.executePublicOnly(params, result);

        case ExecutionStrategy.JITO_WITH_FALLBACK:
          return await this.executeJitoWithFallback(params, result);

        case ExecutionStrategy.PARALLEL_EXECUTION:
          return await this.executeParallel(params, result);

        default:
          return await this.executeJitoWithFallback(params, result);
      }
    } catch (error) {
      result.success = false;
      result.error = error instanceof Error ? error.message : 'Unknown execution error';
      result.executionTime = Date.now() - startTime;

      logger.error('DUAL_EXECUTION', 'Execution strategy failed', {
        strategy: this.config.strategy,
        error: result.error,
        executionTime: result.executionTime,
      });

      return result;
    }
  }

  /**
   * Execute using Jito bundle only
   */
  private async executeJitoOnly(
    params: TradeParams,
    result: ExecutionResult,
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    result.jitoAttempted = true;

    try {
      logger.debug('DUAL_EXECUTION', 'Executing Jito-only strategy');

      const jitoResult = await this.executeViaMevAware(params, true);

      result.details.jitoResult = {
        success: jitoResult.success,
        bundleId: jitoResult.bundleId,
        error: jitoResult.error,
        executionTime: jitoResult.executionTime,
      };

      if (jitoResult.success) {
        this.executionStats.jitoSuccess++;
        result.success = true;
        result.method = ExecutionMethod.JITO_BUNDLE;
        result.signature = jitoResult.signature;
        result.bundleId = jitoResult.bundleId;
        result.tipUsed = jitoResult.bundleTipUsed;
      } else {
        result.error = jitoResult.error || 'Jito execution failed';
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Jito-only execution error';
      result.details.jitoResult = {
        success: false,
        error: result.error,
        executionTime: Date.now() - startTime,
      };
    }

    result.executionTime = Date.now() - startTime;
    return result;
  }

  /**
   * Execute using public mempool only
   */
  private async executePublicOnly(
    params: TradeParams,
    result: ExecutionResult,
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    result.publicAttempted = true;

    try {
      logger.debug('DUAL_EXECUTION', 'Executing public-only strategy');

      const publicResult = await this.executeViaPublic(params);

      result.details.publicResult = {
        success: !!publicResult,
        signature: publicResult || undefined,
        executionTime: Date.now() - startTime,
      };

      if (publicResult) {
        this.executionStats.publicSuccess++;
        result.success = true;
        result.method = ExecutionMethod.PUBLIC_MEMPOOL;
        result.signature = publicResult;
      } else {
        result.error = 'Public mempool execution failed';
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Public-only execution error';
      result.details.publicResult = {
        success: false,
        error: result.error,
        executionTime: Date.now() - startTime,
      };
    }

    result.executionTime = Date.now() - startTime;
    return result;
  }

  /**
   * Execute Jito first, fallback to public if needed
   */
  private async executeJitoWithFallback(
    params: TradeParams,
    result: ExecutionResult,
  ): Promise<ExecutionResult> {
    const overallStartTime = Date.now();

    logger.debug('DUAL_EXECUTION', 'Executing Jito-with-fallback strategy');

    // Phase 1: Try Jito bundle execution
    if (this.config.jitoEnabled) {
      result.jitoAttempted = true;
      const jitoStartTime = Date.now();

      try {
        logger.debug('DUAL_EXECUTION', 'Attempting Jito bundle execution');

        const jitoResult = await Promise.race([
          this.executeViaMevAware(params, true),
          this.createTimeoutPromise(this.config.jitoTimeoutMs),
        ]);

        const jitoExecutionTime = Date.now() - jitoStartTime;

        result.details.jitoResult = {
          success: jitoResult.success,
          bundleId: jitoResult.bundleId,
          error: jitoResult.error,
          executionTime: jitoExecutionTime,
        };

        if (jitoResult.success) {
          this.executionStats.jitoSuccess++;
          result.success = true;
          result.method = ExecutionMethod.JITO_BUNDLE;
          result.signature = jitoResult.signature;
          result.bundleId = jitoResult.bundleId;
          result.tipUsed = jitoResult.bundleTipUsed;
          result.executionTime = Date.now() - overallStartTime;

          logger.info('DUAL_EXECUTION', 'Jito execution succeeded', {
            bundleId: jitoResult.bundleId,
            executionTime: jitoExecutionTime,
          });

          return result;
        }

        logger.warn('DUAL_EXECUTION', 'Jito execution failed, preparing fallback', {
          error: jitoResult.error,
          executionTime: jitoExecutionTime,
        });
      } catch (error) {
        const jitoExecutionTime = Date.now() - jitoStartTime;
        const errorMessage = error instanceof Error ? error.message : 'Jito timeout or error';

        result.details.jitoResult = {
          success: false,
          error: errorMessage,
          executionTime: jitoExecutionTime,
        };

        logger.warn('DUAL_EXECUTION', 'Jito execution failed with error', {
          error: errorMessage,
          executionTime: jitoExecutionTime,
        });
      }
    }

    // Phase 2: Fallback to public mempool
    logger.info('DUAL_EXECUTION', 'Falling back to public mempool execution');

    // Optional delay before fallback
    if (this.config.publicFallbackDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.publicFallbackDelayMs));
    }

    result.publicAttempted = true;
    result.fallbackUsed = true;
    this.executionStats.fallbacksUsed++;

    const publicStartTime = Date.now();

    try {
      const publicResult = await this.executeViaPublic(params);
      const publicExecutionTime = Date.now() - publicStartTime;

      result.details.publicResult = {
        success: !!publicResult,
        signature: publicResult || undefined,
        error: publicResult ? undefined : 'Public execution returned null',
        executionTime: publicExecutionTime,
      };

      if (publicResult) {
        this.executionStats.publicSuccess++;
        result.success = true;
        result.method = ExecutionMethod.PUBLIC_MEMPOOL;
        result.signature = publicResult;

        logger.info('DUAL_EXECUTION', 'Public fallback succeeded', {
          signature: publicResult,
          executionTime: publicExecutionTime,
        });
      } else {
        result.error = 'Both Jito and public execution failed';
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Public fallback error';
      result.details.publicResult = {
        success: false,
        error: errorMessage,
        executionTime: Date.now() - publicStartTime,
      };
      result.error = `Jito failed, public fallback error: ${errorMessage}`;
    }

    result.executionTime = Date.now() - overallStartTime;
    return result;
  }

  /**
   * Execute both strategies in parallel (race condition)
   */
  private async executeParallel(
    params: TradeParams,
    result: ExecutionResult,
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    this.executionStats.parallelExecutions++;

    logger.debug('DUAL_EXECUTION', 'Executing parallel strategy');

    result.jitoAttempted = true;
    result.publicAttempted = true;

    try {
      // Start both executions simultaneously
      const [jitoPromise, publicPromise] = [
        this.executeViaMevAware(params, true).catch((error) => ({ error })),
        this.executeViaPublic(params).catch((error) => ({ error })),
      ];

      // Race both executions
      const raceResult = await Promise.race([
        jitoPromise.then((result) => ({ type: 'jito', result })),
        publicPromise.then((result) => ({ type: 'public', result })),
      ]);

      // Wait a bit more to see if the other completes too
      const otherResult = await Promise.race([
        new Promise((resolve) => setTimeout(resolve, 2000)).then(() => null),
        raceResult.type === 'jito'
          ? publicPromise.then((result) => ({ type: 'public', result }))
          : jitoPromise.then((result) => ({ type: 'jito', result })),
      ]);

      // Process results
      if (raceResult.type === 'jito' && !raceResult.result.error) {
        const jitoResult = raceResult.result as any;
        result.success = jitoResult.success;
        result.method = ExecutionMethod.JITO_BUNDLE;
        result.signature = jitoResult.signature;
        result.bundleId = jitoResult.bundleId;
        result.tipUsed = jitoResult.bundleTipUsed;

        if (otherResult && !otherResult.result.error) {
          result.method = ExecutionMethod.BOTH_SUCCEEDED;
          logger.warn(
            'DUAL_EXECUTION',
            'Both parallel executions succeeded - potential duplicate trade',
          );
        }
      } else if (raceResult.type === 'public' && typeof raceResult.result === 'string') {
        result.success = true;
        result.method = ExecutionMethod.PUBLIC_MEMPOOL;
        result.signature = raceResult.result;

        if (otherResult && !otherResult.result.error) {
          result.method = ExecutionMethod.BOTH_SUCCEEDED;
          logger.warn(
            'DUAL_EXECUTION',
            'Both parallel executions succeeded - potential duplicate trade',
          );
        }
      } else {
        result.success = false;
        result.error = 'Both parallel executions failed';
      }
    } catch (error) {
      result.success = false;
      result.error = error instanceof Error ? error.message : 'Parallel execution error';
    }

    result.executionTime = Date.now() - startTime;
    return result;
  }

  /**
   * Execute via MEV-aware PumpTrade (Jito bundle)
   */
  private async executeViaMevAware(params: TradeParams, usePrivateMempool: boolean): Promise<any> {
    const basePriorityFee = await calcPriorityFeeSOL(
      params.connection,
      transactionPrep.COMPUTE_UNITS.JITO_BUNDLE,
      0.95,
    );
    const adjustedPriorityFee = basePriorityFee * this.config.priorityFeeMultiplier.jito;

    return await sendMEVAwarePumpTrade({
      connection: params.connection,
      wallet: params.wallet,
      mint: params.mint,
      amount: params.amount,
      action: params.action,
      denominatedInSol: params.denominatedInSol ?? true,
      slippage: params.slippage ?? 10,
      priorityFee: adjustedPriorityFee,
      pool: params.pool ?? 'auto',
      usePrivateMempool,
      bundleTip: this.calculateOptimalTip(),
      delayMs: 0,
      protectionLevel: 'STANDARD',
    });
  }

  /**
   * Execute via public mempool
   */
  private async executeViaPublic(params: TradeParams): Promise<string | null> {
    const basePriorityFee = await calcPriorityFeeSOL(
      params.connection,
      transactionPrep.COMPUTE_UNITS.PUMP_TRADE,
      0.95,
    );
    const adjustedPriorityFee = basePriorityFee * this.config.priorityFeeMultiplier.public;

    return await sendPumpTrade({
      connection: params.connection,
      wallet: params.wallet,
      mint: params.mint,
      amount: params.amount,
      action: params.action,
      denominatedInSol: params.denominatedInSol ?? true,
      slippage: params.slippage ?? 10,
      priorityFee: adjustedPriorityFee,
      pool: params.pool ?? 'auto',
    });
  }

  /**
   * Calculate optimal tip amount based on current network conditions
   */
  private calculateOptimalTip(): number {
    const config = loadBotConfig();
    const protectionLevel = config.mevProtection?.protectionLevel || 'MEDIUM';

    // Base tip amounts
    const baseTips = {
      LOW: 0.0001,
      MEDIUM: 0.0005,
      HIGH: 0.001,
      AGGRESSIVE: 0.002,
    };

    return baseTips[protectionLevel as keyof typeof baseTips] || baseTips.MEDIUM;
  }

  /**
   * Create a timeout promise for racing executions
   */
  private createTimeoutPromise(timeoutMs: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Execution timeout after ${timeoutMs}ms`)), timeoutMs);
    });
  }

  /**
   * Parse strategy string to enum
   */
  private parseStrategy(strategy: string): ExecutionStrategy {
    switch (strategy.toUpperCase()) {
      case 'JITO_ONLY':
        return ExecutionStrategy.JITO_ONLY;
      case 'PUBLIC_ONLY':
        return ExecutionStrategy.PUBLIC_ONLY;
      case 'JITO_WITH_FALLBACK':
        return ExecutionStrategy.JITO_WITH_FALLBACK;
      case 'PARALLEL_EXECUTION':
        return ExecutionStrategy.PARALLEL_EXECUTION;
      default:
        return ExecutionStrategy.JITO_WITH_FALLBACK;
    }
  }

  /**
   * Main execution entry point used by trading.ts
   */
  async executeStrategy(params: {
    strategy: ExecutionStrategy;
    connection: Connection;
    wallet: Keypair;
    mint: string;
    amount: number;
    action: 'buy' | 'sell';
    denominatedInSol: boolean;
    slippage?: number;
    pool?: string;
    customTipAmount?: number;
    maxDelayMs?: number;
    priorityFee?: number;
  }): Promise<ExecutionResult> {
    // Override strategy selection if configured for auto-selection
    const selectedStrategy = this.selectStrategy('MEDIUM', params.amount); // Default to MEDIUM risk
    const finalStrategy = params.strategy || selectedStrategy;

    // Convert to internal TradeParams format
    const tradeParams: TradeParams = {
      connection: params.connection,
      wallet: params.wallet,
      mint: params.mint,
      amount: params.amount,
      action: params.action,
      denominatedInSol: params.denominatedInSol,
      slippage: params.slippage,
      pool: params.pool,
      customTipAmount: params.customTipAmount,
      maxDelayMs: params.maxDelayMs,
      priorityFee: params.priorityFee,
    };

    // Temporarily override the strategy
    const originalStrategy = this.config.strategy;
    this.config.strategy = finalStrategy;

    try {
      const result = await this.executeTrade(tradeParams);

      // Map internal result to external interface
      return {
        success: result.success,
        signature: result.signature,
        bundleId: result.bundleId,
        method: result.method,
        executionMethod: result.method, // Map method to executionMethod for trading.ts
        executionTime: result.executionTime,
        priorityFee: result.priorityFee,
        bundleTip: result.bundleTip,
        totalCost: result.totalCost,
        error: result.error,
        fallbackUsed: result.fallbackUsed,
        jitoAttempted: result.jitoAttempted,
        publicAttempted: result.publicAttempted,
        details: result.details,
      };
    } finally {
      // Restore original strategy
      this.config.strategy = originalStrategy;
    }
  }

  /**
   * Get execution statistics
   */
  getStatistics() {
    const total = this.executionStats.totalExecutions;
    return {
      ...this.executionStats,
      jitoSuccessRate:
        total > 0 ? ((this.executionStats.jitoSuccess / total) * 100).toFixed(1) + '%' : '0%',
      publicSuccessRate:
        total > 0 ? ((this.executionStats.publicSuccess / total) * 100).toFixed(1) + '%' : '0%',
      fallbackRate:
        total > 0 ? ((this.executionStats.fallbacksUsed / total) * 100).toFixed(1) + '%' : '0%',
      currentStrategy: this.config.strategy,
    };
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(newConfig: Partial<DualExecutionConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info('DUAL_EXECUTION', 'Configuration updated', newConfig);
  }
}

// Export singleton instance
export const dualExecutionStrategy = new DualExecutionStrategy();

export default dualExecutionStrategy;
