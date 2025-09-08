// src/features/discovery/tokenWatchlist.ts
// Stage-aware token watchlist with automatic stage transitions and retry management

import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import {
  TokenCandidate,
  TokenStage,
  StageTransitionResult,
  POOL_DETECTION_CONFIG,
} from '../../types/TokenStage.js';
import { PumpToken } from '../../types/PumpToken.js';
import { evaluateToken } from '../safety/stageAwareSafety/index.js';
import { poolDetector } from '../../utils/poolDetection.js';
import logger from '../../utils/logger.js';
import metricsCollector from '../../utils/metricsCollector.js';
import { loadBotConfig } from '../../config/index.js';

export interface WatchlistStats {
  totalTokens: number;
  byStage: Record<TokenStage, number>;
  avgProcessingTime: number;
  successRate: number;
  capacityUsed: number;
}

export class TokenWatchlist {
  private candidates = new Map<string, TokenCandidate>();
  private processingQueue = new Set<string>();
  private readonly maxConcurrentProcessing = 10;
  private readonly cleanupIntervalMs = 60_000; // 1 minute
  private readonly maxTokenAge = 30 * 60 * 1000; // 30 minutes max lifetime

  private stats = {
    totalProcessed: 0,
    totalSuccessful: 0,
    avgProcessingTime: 0,
    stageTransitions: 0,
  };

  private cleanupTimer: NodeJS.Timeout | null = null;
  private processingTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.startCleanupTimer();
    this.startProcessingLoop();
  }

  /**
   * Add a new token from discovery (always starts at PRE_BOND stage)
   */
  addToken(discoveredToken: PumpToken): boolean {
    if (this.candidates.has(discoveredToken.mint)) {
      logger.debug('WATCHLIST', 'Token already exists in watchlist', {
        mint: discoveredToken.mint.substring(0, 8) + '...',
      });
      return false;
    }

    const candidate: TokenCandidate = {
      mint: discoveredToken.mint,
      creator: discoveredToken.creator,
      pool: discoveredToken.pool,
      createdAt: discoveredToken.discoveredAt || Date.now(),
      discoveredAt: discoveredToken.discoveredAt || Date.now(),
      stage: 'PRE_BOND',
      attempts: 0,
      maxAttempts: 5,
      retryWindowMs: 10 * 60 * 1000, // 10 minutes
      failureReasons: [],
    };

    this.candidates.set(discoveredToken.mint, candidate);

    logger.info('WATCHLIST', 'Token added to watchlist', {
      mint: discoveredToken.mint.substring(0, 8) + '...',
      stage: candidate.stage,
      totalTokens: this.candidates.size,
    });

    metricsCollector.recordTokenValidation('discovery', 'pass');
    return true;
  }

  /**
   * Remove a token from the watchlist
   */
  removeToken(mint: string, reason: string): boolean {
    const candidate = this.candidates.get(mint);
    if (!candidate) return false;

    this.candidates.delete(mint);
    this.processingQueue.delete(mint);

    logger.info('WATCHLIST', 'Token removed from watchlist', {
      mint: mint.substring(0, 8) + '...',
      reason,
      stage: candidate.stage,
      attempts: candidate.attempts,
      totalTokens: this.candidates.size,
    });

    metricsCollector.recordTokenValidation('discovery', 'pass');
    return true;
  }

  /**
   * Get a token ready for sniping (passed all safety checks)
   */
  async getReadyToken(): Promise<PumpToken | null> {
    for (const [mint, candidate] of this.candidates.entries()) {
      if (
        candidate.stage === 'RAYDIUM_LISTED' &&
        !this.processingQueue.has(mint) &&
        candidate.hasJupiterRoute &&
        candidate.simulatedLp
      ) {
        // Convert back to PumpToken format for legacy compatibility
        const readyToken: PumpToken = {
          mint: candidate.mint,
          creator: candidate.creator,
          pool: candidate.pool,
          discoveredAt: candidate.discoveredAt,
          simulatedLp: candidate.simulatedLp || 0,
          hasJupiterRoute: candidate.hasJupiterRoute || false,
          lpTokenAddress: 'LP_unknown',
          earlyHolders: 0,
          metadata: { name: '', symbol: '', decimals: 0 },
          launchSpeedSeconds: 0,
        };

        // Remove from watchlist as it's being processed
        this.removeToken(mint, 'ready_for_sniping');

        return readyToken;
      }
    }
    return null;
  }

  /**
   * Get watchlist statistics
   */
  getStats(): WatchlistStats {
    const byStage: Record<TokenStage, number> = {
      PRE_BOND: 0,
      BONDED_ON_PUMP: 0,
      RAYDIUM_LISTED: 0,
    };

    for (const candidate of this.candidates.values()) {
      byStage[candidate.stage]++;
    }

    return {
      totalTokens: this.candidates.size,
      byStage,
      avgProcessingTime: this.stats.avgProcessingTime,
      successRate:
        this.stats.totalProcessed > 0 ? this.stats.totalSuccessful / this.stats.totalProcessed : 0,
      capacityUsed: this.processingQueue.size / this.maxConcurrentProcessing,
    };
  }

  /**
   * Get tokens by stage for debugging
   */
  getTokensByStage(stage: TokenStage): TokenCandidate[] {
    return Array.from(this.candidates.values()).filter((c) => c.stage === stage);
  }

  /**
   * Force process a specific token (for testing)
   */
  async forceProcessToken(mint: string): Promise<StageTransitionResult | null> {
    const candidate = this.candidates.get(mint);
    if (!candidate) return null;

    return await this.processCandidate(candidate);
  }

  private startProcessingLoop(): void {
    this.processingTimer = setInterval(async () => {
      await this.processCandidates();
    }, POOL_DETECTION_CONFIG.poolCheckIntervalMs);
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredTokens();
    }, this.cleanupIntervalMs);
  }

  private async processCandidates(): Promise<void> {
    const now = Date.now();
    const candidates = Array.from(this.candidates.values());

    // Process candidates that need attention
    const candidatesToProcess = candidates.filter((candidate) => {
      // Skip if already being processed
      if (this.processingQueue.has(candidate.mint)) return false;

      // Skip if not time for retry yet
      if (candidate.lastCheckedAt && now - candidate.lastCheckedAt < 2000) return false;

      // Skip if exceeded max attempts
      if (candidate.attempts >= candidate.maxAttempts) return false;

      // Skip if too old
      if (now - candidate.discoveredAt > this.maxTokenAge) return false;

      return true;
    });

    // Limit concurrent processing
    const slotsAvailable = this.maxConcurrentProcessing - this.processingQueue.size;
    const toProcess = candidatesToProcess.slice(0, slotsAvailable);

    if (toProcess.length === 0) return;

    logger.debug('WATCHLIST', 'Processing candidates', {
      toProcess: toProcess.length,
      totalCandidates: candidates.length,
      processingSlots: `${this.processingQueue.size}/${this.maxConcurrentProcessing}`,
    });

    // Process candidates in parallel
    const processingPromises = toProcess.map((candidate) =>
      this.processCandidate(candidate).catch((error) => {
        logger.error(
          'WATCHLIST',
          'Candidate processing error',
          {
            mint: candidate.mint?.substring(0, 8) + '...' || 'unknown',
          },
          error,
        );
        return null;
      }),
    );

    await Promise.allSettled(processingPromises);
  }

  private async processCandidate(candidate: TokenCandidate): Promise<StageTransitionResult | null> {
    const startTime = Date.now();

    // Mark as processing
    this.processingQueue.add(candidate.mint);
    candidate.lastCheckedAt = Date.now();
    candidate.attempts++;

    try {
      logger.debug('WATCHLIST', 'Processing candidate', {
        mint: candidate.mint.substring(0, 8) + '...',
        stage: candidate.stage,
        attempt: candidate.attempts,
        maxAttempts: candidate.maxAttempts,
      });

      // Perform stage-appropriate safety checks
      let result: StageTransitionResult;

      if (candidate.stage === 'PRE_BOND') {
        const pumpToken: PumpToken = {
          mint: candidate.mint,
          name: candidate.name,
          symbol: candidate.symbol,
          ...candidate.metadata,
        };
        const report = await evaluateToken(pumpToken, { connection: new Connection('https://api.mainnet-beta.solana.com') });
        result = {
          success: report.passed,
          newStage: report.passed ? 'BONDED_ON_PUMP' : candidate.stage,
          reasons: report.failures,
        };
      } else if (candidate.stage === 'BONDED_ON_PUMP') {
        // Check for pool existence and transition to RAYDIUM_LISTED if found
        const poolResult = await poolDetector.detectPool(candidate.mint);

        if (poolResult.hasPool) {
          // Pool found - transition to RAYDIUM_LISTED
          result = { success: true, newStage: 'RAYDIUM_LISTED' };
          candidate.simulatedLp = poolResult.liquidity;
        } else {
          // Still waiting for pool
          const waitTime = Date.now() - (candidate.firstSeenBondedAt || candidate.discoveredAt);
          const maxWait = loadBotConfig().mevProtection?.timeoutMs || 5 * 60 * 1000;

          if (waitTime > maxWait) {
            result = { success: false, reason: 'pool_timeout', shouldDrop: true };
          } else {
            result = { success: false, reason: 'waiting_for_pool', retryAfter: 3000 };
          }
        }
      } else if (candidate.stage === 'RAYDIUM_LISTED') {
        // Final safety checks with full validation
        const config = loadBotConfig();
        const rpcUrl = config.rpcEndpoints?.[0]?.url || 'https://api.mainnet-beta.solana.com';
        const connection = new Connection(rpcUrl);
        const walletPubkey = new PublicKey('11111111111111111111111111111111'); // Mock for safety checks

        const pumpToken: PumpToken = {
          mint: candidate.mint,
          name: candidate.name,
          symbol: candidate.symbol,
          ...candidate.metadata,
        };
        const report = await evaluateToken(pumpToken, { connection, walletPubkey });
        result = {
          success: report.passed,
          newStage: report.passed ? 'COMPLETE' : candidate.stage,
          reasons: report.failures,
          riskScore: report.riskScore,
        };
      } else {
        throw new Error(`Unknown stage: ${candidate.stage}`);
      }

      // Handle the result
      await this.handleStageTransitionResult(candidate, result);

      const duration = Date.now() - startTime;
      this.updateStats(true, duration);

      return result;
    } catch (error) {
      logger.error(
        'WATCHLIST',
        'Candidate processing failed',
        {
          mint: candidate.mint?.substring(0, 8) + '...' || 'unknown',
          stage: candidate.stage,
          attempt: candidate.attempts,
        },
        error,
      );

      const duration = Date.now() - startTime;
      this.updateStats(false, duration);

      return null;
    } finally {
      // Remove from processing queue
      this.processingQueue.delete(candidate.mint);
    }
  }

  private async handleStageTransitionResult(
    candidate: TokenCandidate,
    result: StageTransitionResult,
  ): Promise<void> {
    if (result.success && result.newStage) {
      // Successful stage transition
      const oldStage = candidate.stage;
      candidate.stage = result.newStage;

      // Update stage-specific timestamps
      if (result.newStage === 'BONDED_ON_PUMP') {
        candidate.firstSeenBondedAt = Date.now();
      }

      logger.info('WATCHLIST', 'Stage transition successful', {
        mint: candidate.mint.substring(0, 8) + '...',
        fromStage: oldStage,
        toStage: result.newStage,
        attempts: candidate.attempts,
      });

      this.stats.stageTransitions++;
      metricsCollector.recordTokenValidation('discovery', 'pass');
    } else if (result.success && !result.newStage) {
      // Success without stage change (e.g., final validation passed)
      logger.info('WATCHLIST', 'Token validation complete', {
        mint: candidate.mint.substring(0, 8) + '...',
        stage: candidate.stage,
        attempts: candidate.attempts,
      });
    } else if (result.shouldDrop) {
      // Failed - remove from watchlist
      this.removeToken(candidate.mint, result.reason || 'safety_failed');
      metricsCollector.recordTokenValidation('discovery', 'fail');
    } else if (result.retryAfter) {
      // Failed but should retry later
      logger.debug('WATCHLIST', 'Token will retry later', {
        mint: candidate.mint.substring(0, 8) + '...',
        stage: candidate.stage,
        reason: result.reason,
        retryAfterMs: result.retryAfter,
        attempts: candidate.attempts,
      });
    }

    // Update failure tracking
    if (!result.success && result.reason) {
      candidate.failureReasons.push(result.reason);
      candidate.lastFailureReason = result.reason;
    }
  }

  private cleanupExpiredTokens(): void {
    const now = Date.now();
    const expiredTokens: string[] = [];

    for (const [mint, candidate] of this.candidates.entries()) {
      const age = now - candidate.discoveredAt;

      // Remove if too old or exceeded max attempts
      if (age > this.maxTokenAge || candidate.attempts >= candidate.maxAttempts) {
        expiredTokens.push(mint);
      }
    }

    for (const mint of expiredTokens) {
      const candidate = this.candidates.get(mint);
      const reason =
        candidate && candidate.attempts >= candidate.maxAttempts
          ? 'max_attempts_exceeded'
          : 'expired';
      this.removeToken(mint, reason);
    }

    if (expiredTokens.length > 0) {
      logger.info('WATCHLIST', 'Cleaned up expired tokens', {
        removed: expiredTokens.length,
        totalRemaining: this.candidates.size,
      });
    }
  }

  private updateStats(success: boolean, duration: number): void {
    this.stats.totalProcessed++;
    if (success) this.stats.totalSuccessful++;

    // Update rolling average processing time
    this.stats.avgProcessingTime =
      (this.stats.avgProcessingTime * (this.stats.totalProcessed - 1) + duration) /
      this.stats.totalProcessed;
  }

  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    if (this.processingTimer) {
      clearInterval(this.processingTimer);
      this.processingTimer = null;
    }

    logger.info('WATCHLIST', 'Token watchlist shut down', {
      totalProcessed: this.stats.totalProcessed,
      successRate: this.stats.totalSuccessful / Math.max(this.stats.totalProcessed, 1),
    });
  }
}

// Global instance
export const tokenWatchlist = new TokenWatchlist();
