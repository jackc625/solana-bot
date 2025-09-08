// src/core/stageAwarePipeline.ts
// Integration layer for stage-aware token processing pipeline

import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { PumpToken } from "../types/PumpToken.js";
import { tokenWatchlist } from "./tokenWatchlist.js";
import { stageAwareMetrics } from "@features/telemetry/stageAwareMetrics.js";
import logger from "../utils/logger.js";
import { loadBotConfig } from "../config/index.js";

export interface StageAwarePipelineConfig {
    enabled: boolean;
    metricsLoggingIntervalMs: number;
    watchlistStatsIntervalMs: number;
    maxConcurrentTokens: number;
    debugMode: boolean;
}

export const DEFAULT_PIPELINE_CONFIG: StageAwarePipelineConfig = {
    enabled: true,
    metricsLoggingIntervalMs: 60_000, // Log metrics every minute
    watchlistStatsIntervalMs: 30_000, // Log watchlist stats every 30 seconds
    maxConcurrentTokens: 50,
    debugMode: false
};

export class StageAwarePipeline {
    private config: StageAwarePipelineConfig;
    private isRunning = false;
    private metricsTimer: NodeJS.Timeout | null = null;
    private statsTimer: NodeJS.Timeout | null = null;

    constructor(config?: Partial<StageAwarePipelineConfig>) {
        this.config = { ...DEFAULT_PIPELINE_CONFIG, ...config };
        this.loadConfigFromBotConfig();
    }

    private loadConfigFromBotConfig(): void {
        try {
            const botConfig = loadBotConfig();
            if (botConfig.stageAwarePipeline) {
                // Merge bot config with current config
                this.config = { 
                    ...this.config, 
                    ...botConfig.stageAwarePipeline 
                };
                
                logger.info('STAGE_PIPELINE', 'Loaded stage-aware pipeline config from botConfig.json', {
                    enabled: this.config.enabled,
                    debugMode: this.config.debugMode,
                    maxConcurrentTokens: this.config.maxConcurrentTokens
                });
            }
        } catch (error) {
            logger.warn('STAGE_PIPELINE', 'Failed to load stage-aware config from botConfig.json, using defaults', {
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    /**
     * Start the stage-aware pipeline
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn('STAGE_PIPELINE', 'Pipeline already running');
            return;
        }

        logger.info('STAGE_PIPELINE', 'Starting stage-aware token processing pipeline', {
            enabled: this.config.enabled,
            maxConcurrentTokens: this.config.maxConcurrentTokens,
            debugMode: this.config.debugMode
        });

        this.isRunning = true;

        if (this.config.enabled) {
            this.startMetricsLogging();
            this.startStatsLogging();
        }

        logger.info('STAGE_PIPELINE', 'Stage-aware pipeline started successfully');
    }

    /**
     * Stop the stage-aware pipeline
     */
    async stop(): Promise<void> {
        if (!this.isRunning) return;

        logger.info('STAGE_PIPELINE', 'Stopping stage-aware pipeline');

        this.isRunning = false;

        if (this.metricsTimer) {
            clearInterval(this.metricsTimer);
            this.metricsTimer = null;
        }

        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = null;
        }

        // Shutdown watchlist
        tokenWatchlist.shutdown();

        // Log final metrics
        stageAwareMetrics.logSummary();

        logger.info('STAGE_PIPELINE', 'Stage-aware pipeline stopped');
    }

    /**
     * Add a newly discovered token to the stage-aware pipeline
     */
    addDiscoveredToken(token: PumpToken): boolean {
        if (!this.config.enabled) {
            logger.debug('STAGE_PIPELINE', 'Pipeline disabled, skipping token', {
                mint: token.mint?.substring(0, 8) + '...' || 'unknown'
            });
            return false;
        }

        if (!this.isRunning) {
            logger.warn('STAGE_PIPELINE', 'Pipeline not running, cannot add token', {
                mint: token.mint?.substring(0, 8) + '...' || 'unknown'
            });
            return false;
        }

        const success = tokenWatchlist.addToken(token);
        
        if (success) {
            stageAwareMetrics.recordStageEntry('PRE_BOND', token.mint);
            
            logger.info('STAGE_PIPELINE', 'Token added to stage-aware pipeline', {
                mint: token.mint.substring(0, 8) + '...',
                creator: token.creator?.substring(0, 8) + '...',
                pool: token.pool,
                discoveredAt: token.discoveredAt
            });
        }

        return success;
    }

    /**
     * Get the next token ready for sniping (passed all safety checks)
     */
    async getReadyToken(): Promise<PumpToken | null> {
        if (!this.config.enabled || !this.isRunning) return null;

        const readyToken = await tokenWatchlist.getReadyToken();
        
        if (readyToken) {
            const tokenLifetime = Date.now() - (readyToken.discoveredAt || 0);
            stageAwareMetrics.recordTokenComplete(readyToken.mint, true, tokenLifetime);
            
            logger.info('STAGE_PIPELINE', 'Token ready for sniping', {
                mint: readyToken.mint.substring(0, 8) + '...',
                creator: readyToken.creator?.substring(0, 8) + '...',
                liquidity: readyToken.simulatedLp,
                lifetimeMs: tokenLifetime
            });
        }

        return readyToken;
    }

    /**
     * Get current pipeline statistics
     */
    getStats(): {
        watchlistStats: any;
        pipelineMetrics: any;
        isRunning: boolean;
        config: StageAwarePipelineConfig;
    } {
        return {
            watchlistStats: tokenWatchlist.getStats(),
            pipelineMetrics: stageAwareMetrics.getPipelineMetrics(),
            isRunning: this.isRunning,
            config: this.config
        };
    }

    /**
     * Generate detailed diagnostics report
     */
    generateDiagnosticsReport(): string {
        const lines: string[] = [];
        
        lines.push('=== STAGE-AWARE PIPELINE DIAGNOSTICS ===\n');
        
        // Pipeline status
        lines.push('🔄 PIPELINE STATUS:');
        lines.push(`Running: ${this.isRunning}`);
        lines.push(`Enabled: ${this.config.enabled}`);
        lines.push(`Debug Mode: ${this.config.debugMode}`);
        lines.push(`Max Concurrent Tokens: ${this.config.maxConcurrentTokens}\n`);
        
        // Watchlist stats
        const watchlistStats = tokenWatchlist.getStats();
        lines.push('📋 WATCHLIST STATUS:');
        lines.push(`Total Tokens: ${watchlistStats.totalTokens}`);
        lines.push(`Capacity Used: ${(watchlistStats.capacityUsed * 100).toFixed(1)}%`);
        lines.push(`Success Rate: ${(watchlistStats.successRate * 100).toFixed(1)}%`);
        lines.push(`Avg Processing Time: ${watchlistStats.avgProcessingTime.toFixed(0)}ms\n`);
        
        // Stage breakdown
        lines.push('📊 STAGE BREAKDOWN:');
        for (const [stage, count] of Object.entries(watchlistStats.byStage)) {
            lines.push(`  ${stage}: ${count} tokens`);
        }
        lines.push('');
        
        // Recent tokens by stage (for debugging)
        if (this.config.debugMode) {
            lines.push('🔍 DEBUG INFO:');
            const preBondTokens = tokenWatchlist.getTokensByStage('PRE_BOND');
            const bondedTokens = tokenWatchlist.getTokensByStage('BONDED_ON_PUMP');
            const raydiumTokens = tokenWatchlist.getTokensByStage('RAYDIUM_LISTED');
            
            lines.push(`PRE_BOND tokens (${preBondTokens.length}):`);
            for (const token of preBondTokens.slice(0, 5)) {
                lines.push(`  ${token.mint.substring(0, 12)}... (${token.attempts}/${token.maxAttempts} attempts)`);
            }
            
            lines.push(`BONDED_ON_PUMP tokens (${bondedTokens.length}):`);
            for (const token of bondedTokens.slice(0, 5)) {
                const waitTime = token.firstSeenBondedAt ? Date.now() - token.firstSeenBondedAt : 0;
                lines.push(`  ${token.mint.substring(0, 12)}... (waiting ${Math.floor(waitTime/1000)}s for pool)`);
            }
            
            lines.push(`RAYDIUM_LISTED tokens (${raydiumTokens.length}):`);
            for (const token of raydiumTokens.slice(0, 5)) {
                lines.push(`  ${token.mint.substring(0, 12)}... (liquidity: ${token.simulatedLp?.toFixed(4) || 'unknown'} SOL)`);
            }
        }
        
        // Add detailed metrics report
        lines.push('\n' + stageAwareMetrics.generateReport());
        
        return lines.join('\n');
    }

    /**
     * Update configuration at runtime
     */
    updateConfig(newConfig: Partial<StageAwarePipelineConfig>): void {
        const oldConfig = { ...this.config };
        this.config = { ...this.config, ...newConfig };
        
        logger.info('STAGE_PIPELINE', 'Pipeline configuration updated', {
            oldConfig,
            newConfig: this.config
        });
        
        // Restart timers if intervals changed
        if (newConfig.metricsLoggingIntervalMs && this.metricsTimer) {
            this.startMetricsLogging();
        }
        
        if (newConfig.watchlistStatsIntervalMs && this.statsTimer) {
            this.startStatsLogging();
        }
    }

    /**
     * Force process a specific token (for testing/debugging)
     */
    async forceProcessToken(mint: string): Promise<any> {
        if (!this.config.enabled || !this.isRunning) {
            throw new Error('Pipeline not running');
        }
        
        const result = await tokenWatchlist.forceProcessToken(mint);
        
        logger.info('STAGE_PIPELINE', 'Force processed token', {
            mint: mint.substring(0, 8) + '...',
            result
        });
        
        return result;
    }

    private startMetricsLogging(): void {
        if (this.metricsTimer) {
            clearInterval(this.metricsTimer);
        }
        
        this.metricsTimer = setInterval(() => {
            stageAwareMetrics.logSummary();
        }, this.config.metricsLoggingIntervalMs);
    }

    private startStatsLogging(): void {
        if (this.statsTimer) {
            clearInterval(this.statsTimer);
        }
        
        this.statsTimer = setInterval(() => {
            const stats = tokenWatchlist.getStats();
            
            if (stats.totalTokens > 0) {
                logger.info('STAGE_PIPELINE', 'Watchlist status', {
                    totalTokens: stats.totalTokens,
                    preBond: stats.byStage.PRE_BOND,
                    bonded: stats.byStage.BONDED_ON_PUMP,
                    raydium: stats.byStage.RAYDIUM_LISTED,
                    capacityUsed: `${(stats.capacityUsed * 100).toFixed(1)}%`,
                    successRate: `${(stats.successRate * 100).toFixed(1)}%`,
                    avgProcessingTime: `${stats.avgProcessingTime.toFixed(0)}ms`
                });
            }
        }, this.config.watchlistStatsIntervalMs);
    }
}

// Global instance for the stage-aware pipeline
export const stageAwarePipeline = new StageAwarePipeline();