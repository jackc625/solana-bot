// src/core/riskManager.ts
// Risk management system for position sizing, exposure limits, and portfolio controls

import { Connection, PublicKey } from '@solana/web3.js';
import { loadBotConfig, type BotConfig } from '../config/index.js';
import type { IRiskManager, RiskAssessmentResult, PositionUpdate } from '../features/execution/types.js';
import { on, emit } from './events/bus.js';
import logger from '../utils/logger.js';

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  maxAllowedAmount?: number;
  currentExposure?: number;
  positionCount?: number;
}

export interface PortfolioState {
  walletBalance: number;
  totalExposure: number;
  activePositions: number;
  dailyPnL: number;
  dailyLossTotal: number;
}

class RiskManager implements IRiskManager {
  private config: BotConfig;
  private portfolioState: PortfolioState = {
    walletBalance: 0,
    totalExposure: 0,
    activePositions: 0,
    dailyPnL: 0,
    dailyLossTotal: 0,
  };
  private lastDailyReset: number = 0;

  constructor() {
    this.config = loadBotConfig();
    this.resetDailyTracking();
  }

  /**
   * Check if a new position is allowed based on risk management rules
   */
  async checkPositionRisk({
    mint,
    requestedAmount,
    connection,
    walletPubkey,
  }: {
    mint: string;
    requestedAmount: number;
    connection: Connection;
    walletPubkey: PublicKey;
  }): Promise<RiskCheckResult> {
    try {
      // Update portfolio state
      await this.updatePortfolioState(connection, walletPubkey);

      // Reset daily tracking if needed
      this.checkDailyReset();

      // Check individual position size limit
      const positionSizeCheck = this.checkPositionSizeLimit(requestedAmount);
      if (!positionSizeCheck.allowed) {
        return positionSizeCheck;
      }

      // Check maximum concurrent positions
      const positionCountCheck = this.checkPositionCountLimit();
      if (!positionCountCheck.allowed) {
        return positionCountCheck;
      }

      // Check portfolio exposure limits
      const exposureCheck = this.checkPortfolioExposureLimit(requestedAmount);
      if (!exposureCheck.allowed) {
        return exposureCheck;
      }

      // Check wallet balance percentage limits
      const walletPercentCheck = this.checkWalletPercentageLimit(requestedAmount);
      if (!walletPercentCheck.allowed) {
        return walletPercentCheck;
      }

      // Check daily loss limits
      const dailyLossCheck = this.checkDailyLossLimit();
      if (!dailyLossCheck.allowed) {
        return dailyLossCheck;
      }

      logger.info('RISK', `✅ Position approved: ${requestedAmount} SOL for ${mint}`, {
        requestedAmount,
        walletBalance: this.portfolioState.walletBalance,
        totalExposure: this.portfolioState.totalExposure,
        activePositions: this.portfolioState.activePositions,
      });

      return { allowed: true };
    } catch (error) {
      logger.error('RISK', 'Risk check failed', {
        mint,
        requestedAmount,
        error: (error as Error).message,
      });
      return {
        allowed: false,
        reason: `Risk check error: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Update portfolio state with current wallet balance and position data
   */
  private async updatePortfolioState(
    connection: Connection,
    walletPubkey: PublicKey,
  ): Promise<void> {
    try {
      // Get current wallet balance
      const balance = await connection.getBalance(walletPubkey);
      this.portfolioState.walletBalance = balance / 1e9; // Convert lamports to SOL

      // Active positions will be updated via position update events
      // this.portfolioState.activePositions is maintained via onPositionUpdate calls

      // Calculate total exposure (simplified - would need position value tracking in real implementation)
      // For now, estimate based on position count and average buy amounts
      const avgPositionSize = this.calculateAveragePositionSize();
      this.portfolioState.totalExposure = this.portfolioState.activePositions * avgPositionSize;
    } catch (error) {
      logger.warn('RISK', 'Failed to update portfolio state', { error: (error as Error).message });
    }
  }

  /**
   * Calculate average position size from buy amounts configuration
   */
  private calculateAveragePositionSize(): number {
    const buyAmounts = Object.values(this.config.buyAmounts);
    if (buyAmounts.length === 0) return 0.01; // fallback
    return buyAmounts.reduce((sum, amount) => sum + amount, 0) / buyAmounts.length;
  }

  /**
   * Check if requested position size exceeds maximum allowed
   */
  private checkPositionSizeLimit(requestedAmount: number): RiskCheckResult {
    const maxSize = this.config.maxPositionSize || Infinity;

    if (requestedAmount > maxSize) {
      return {
        allowed: false,
        reason: `Position size ${requestedAmount} SOL exceeds maximum allowed ${maxSize} SOL`,
        maxAllowedAmount: maxSize,
      };
    }

    return { allowed: true };
  }

  /**
   * Check if adding another position would exceed maximum position count
   */
  private checkPositionCountLimit(): RiskCheckResult {
    const maxPositions = this.config.maxPositionsCount || Infinity;

    if (this.portfolioState.activePositions >= maxPositions) {
      return {
        allowed: false,
        reason: `Maximum positions limit reached (${this.portfolioState.activePositions}/${maxPositions})`,
        positionCount: this.portfolioState.activePositions,
      };
    }

    return { allowed: true };
  }

  /**
   * Check if total portfolio exposure would exceed limits
   */
  private checkPortfolioExposureLimit(requestedAmount: number): RiskCheckResult {
    const maxExposure = this.config.maxWalletExposure || Infinity;
    const newTotalExposure = this.portfolioState.totalExposure + requestedAmount;

    if (newTotalExposure > maxExposure) {
      const availableExposure = Math.max(0, maxExposure - this.portfolioState.totalExposure);
      return {
        allowed: false,
        reason: `Total exposure would exceed limit (${newTotalExposure.toFixed(4)}/${maxExposure} SOL)`,
        maxAllowedAmount: availableExposure,
        currentExposure: this.portfolioState.totalExposure,
      };
    }

    return { allowed: true };
  }

  /**
   * Check if requested amount exceeds wallet balance percentage limits
   */
  private checkWalletPercentageLimit(requestedAmount: number): RiskCheckResult {
    const maxPercent = this.config.maxPortfolioPercent || 1.0;
    const maxAllowedByPercent = this.portfolioState.walletBalance * maxPercent;
    const newTotalExposure = this.portfolioState.totalExposure + requestedAmount;

    if (newTotalExposure > maxAllowedByPercent) {
      const availableAmount = Math.max(0, maxAllowedByPercent - this.portfolioState.totalExposure);
      return {
        allowed: false,
        reason: `Would exceed ${(maxPercent * 100).toFixed(1)}% of wallet balance (${newTotalExposure.toFixed(4)}/${maxAllowedByPercent.toFixed(4)} SOL)`,
        maxAllowedAmount: availableAmount,
      };
    }

    return { allowed: true };
  }

  /**
   * Check daily loss limits
   */
  private checkDailyLossLimit(): RiskCheckResult {
    const dailyLossLimit = this.config.dailyLossLimit || Infinity;

    if (this.portfolioState.dailyLossTotal >= dailyLossLimit) {
      return {
        allowed: false,
        reason: `Daily loss limit reached (${this.portfolioState.dailyLossTotal.toFixed(4)}/${dailyLossLimit} SOL)`,
      };
    }

    const maxLossPercent = this.config.maxLossPercent || 1.0;
    const maxLossAmount = this.portfolioState.walletBalance * maxLossPercent;

    if (this.portfolioState.dailyLossTotal >= maxLossAmount) {
      return {
        allowed: false,
        reason: `Daily loss percentage limit reached (${((this.portfolioState.dailyLossTotal / this.portfolioState.walletBalance) * 100).toFixed(1)}%)`,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a trade loss for daily tracking
   */
  recordLoss(lossAmount: number): void {
    this.portfolioState.dailyLossTotal += lossAmount;
    this.portfolioState.dailyPnL -= lossAmount;

    logger.info('RISK', `📉 Loss recorded: ${lossAmount.toFixed(4)} SOL`, {
      dailyLossTotal: this.portfolioState.dailyLossTotal,
      dailyPnL: this.portfolioState.dailyPnL,
    });
  }

  /**
   * Record a trade profit for daily tracking
   */
  recordProfit(profitAmount: number): void {
    this.portfolioState.dailyPnL += profitAmount;

    logger.info('RISK', `📈 Profit recorded: ${profitAmount.toFixed(4)} SOL`, {
      dailyPnL: this.portfolioState.dailyPnL,
    });
  }

  /**
   * Get current portfolio state for monitoring
   */
  getPortfolioState(): PortfolioState {
    return { ...this.portfolioState };
  }

  /**
   * Check if daily tracking should be reset
   */
  private checkDailyReset(): void {
    const now = Date.now();
    const todayStart = new Date().setHours(0, 0, 0, 0);

    if (this.lastDailyReset < todayStart) {
      this.resetDailyTracking();
    }
  }

  /**
   * Reset daily P&L tracking
   */
  private resetDailyTracking(): void {
    this.portfolioState.dailyPnL = 0;
    this.portfolioState.dailyLossTotal = 0;
    this.lastDailyReset = Date.now();

    logger.info('RISK', '🔄 Daily tracking reset', {
      date: new Date().toDateString(),
    });
  }

  /**
   * Emergency shutdown check - returns true if trading should be halted
   */
  shouldHaltTrading(): boolean {
    this.checkDailyReset();

    // Check daily loss limits
    const dailyLossLimit = this.config.dailyLossLimit || Infinity;
    if (this.portfolioState.dailyLossTotal >= dailyLossLimit) {
      logger.error('RISK', '🚨 EMERGENCY HALT: Daily loss limit exceeded', {
        dailyLossTotal: this.portfolioState.dailyLossTotal,
        dailyLossLimit,
      });
      return true;
    }

    // Check wallet percentage loss limit
    const maxLossPercent = this.config.maxLossPercent || 1.0;
    const maxLossAmount = this.portfolioState.walletBalance * maxLossPercent;
    if (this.portfolioState.dailyLossTotal >= maxLossAmount) {
      logger.error('RISK', '🚨 EMERGENCY HALT: Daily loss percentage limit exceeded', {
        dailyLossPercent: (
          (this.portfolioState.dailyLossTotal / this.portfolioState.walletBalance) *
          100
        ).toFixed(1),
        maxLossPercent: (maxLossPercent * 100).toFixed(1),
      });
      return true;
    }

    return false;
  }

  /**
   * Get risk management summary for logging/monitoring
   */
  getRiskSummary(): object {
    return {
      walletBalance: this.portfolioState.walletBalance.toFixed(4),
      totalExposure: this.portfolioState.totalExposure.toFixed(4),
      exposurePercent: (
        (this.portfolioState.totalExposure / this.portfolioState.walletBalance) *
        100
      ).toFixed(1),
      activePositions: this.portfolioState.activePositions,
      dailyPnL: this.portfolioState.dailyPnL.toFixed(4),
      dailyLossTotal: this.portfolioState.dailyLossTotal.toFixed(4),
      limits: {
        maxPositionSize: this.config.maxPositionSize || 'unlimited',
        maxPositions: this.config.maxPositionsCount || 'unlimited',
        maxPortfolioPercent: ((this.config.maxPortfolioPercent || 1.0) * 100).toFixed(1) + '%',
        dailyLossLimit: this.config.dailyLossLimit || 'unlimited',
      },
    };
  }

  // IRiskManager interface implementation
  async assessBeforeBuy(tokenMint: string, amount: number, context?: any): Promise<RiskAssessmentResult> {
    const risk = await this.checkPositionRisk({
      tokenMint,
      amount,
      action: 'buy' as const,
      portfolioValue: this.portfolioState.walletBalance,
      currentPositions: this.portfolioState.activePositions,
    });

    if (!risk.allowed) {
      return {
        decision: 'deny',
        reason: risk.reason,
        riskScore: 100,
      };
    }

    return {
      decision: 'allow',
      riskScore: 20, // Low risk for approved trades
    };
  }

  async assessBeforeSell(tokenMint: string, amount: number, context?: any): Promise<RiskAssessmentResult> {
    // Selling is generally allowed to reduce risk
    return {
      decision: 'allow',
      reason: 'Sell operations reduce portfolio risk',
      riskScore: 10,
    };
  }

  onPositionUpdate(update: PositionUpdate): void {
    // Update portfolio state based on position changes
    if (update.pnl !== undefined) {
      if (update.pnl > 0) {
        this.recordProfit(update.pnl);
      } else {
        this.recordLoss(Math.abs(update.pnl));
      }
    }

    // Emit risk update event
    emit({
      type: 'RiskUpdated',
      payload: {
        tokenMint: update.tokenMint,
        riskLevel: this.getCurrentRiskLevel(),
        reason: 'Position updated',
      },
    });
  }

  getCurrentRiskLevel(): string {
    if (this.shouldHaltTrading()) {
      return 'CRITICAL';
    }

    const portfolioRisk = (this.portfolioState.totalExposure / this.portfolioState.walletBalance) * 100;
    if (portfolioRisk > 80) return 'HIGH';
    if (portfolioRisk > 50) return 'MEDIUM';
    return 'LOW';
  }
}

// Singleton instance
export const riskManager = new RiskManager();

export default riskManager;
