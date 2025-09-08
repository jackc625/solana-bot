// src/utils/stageAwareMetrics.ts
// Enhanced metrics collection for stage-aware token processing pipeline

import { FailureReason, TokenStage, FAILURE_REASONS } from "../types/TokenStage.js";
import metricsCollector from "./metricsCollector.js";
import logger from "./logger.js";

export interface StageMetrics {
    stage: TokenStage;
    tokensEntered: number;
    tokensExited: number;
    avgStageTime: number;
    successRate: number;
    topFailureReasons: Array<{ reason: FailureReason; count: number; percentage: number }>;
}

export interface PipelineMetrics {
    totalTokensProcessed: number;
    overallSuccessRate: number;
    avgTokenLifetime: number;
    stageMetrics: Record<TokenStage, StageMetrics>;
    failureReasons: Record<FailureReason, number>;
    hourlyStats: Array<{ hour: number; processed: number; success: number }>;
}

class StageAwareMetricsCollector {
    private stageEntries = new Map<TokenStage, number>();
    private stageExits = new Map<TokenStage, number>();
    private stageTimes = new Map<TokenStage, number[]>();
    private failureCounts = new Map<FailureReason, number>();
    private hourlyData = new Map<number, { processed: number; success: number }>();
    
    private totalTokensProcessed = 0;
    private totalSuccessful = 0;
    private tokenLifetimes: number[] = [];

    /**
     * Record when a token enters a stage
     */
    recordStageEntry(stage: TokenStage, mint: string): void {
        this.stageEntries.set(stage, (this.stageEntries.get(stage) || 0) + 1);
        
        logger.debug('STAGE_METRICS', 'Token entered stage', {
            mint: mint.substring(0, 8) + '...',
            stage,
            totalEntered: this.stageEntries.get(stage)
        });

        // Record in Prometheus metrics (using compatible types)
        // metricsCollector.recordTokenValidation(`stage_${stage.toLowerCase()}_entry`, 'success');
    }

    /**
     * Record when a token exits a stage (success or failure)
     */
    recordStageExit(
        stage: TokenStage, 
        mint: string, 
        success: boolean, 
        timeInStageMs: number,
        failureReason?: FailureReason
    ): void {
        this.stageExits.set(stage, (this.stageExits.get(stage) || 0) + 1);
        
        // Track time spent in this stage
        const times = this.stageTimes.get(stage) || [];
        times.push(timeInStageMs);
        this.stageTimes.set(stage, times);

        // Track failure reasons
        if (!success && failureReason) {
            this.failureCounts.set(failureReason, (this.failureCounts.get(failureReason) || 0) + 1);
        }

        logger.debug('STAGE_METRICS', 'Token exited stage', {
            mint: mint.substring(0, 8) + '...',
            stage,
            success,
            timeInStageMs,
            failureReason,
            totalExited: this.stageExits.get(stage)
        });

        // Record in Prometheus metrics (using compatible types)
        // metricsCollector.recordTokenValidation(
        //     `stage_${stage.toLowerCase()}_exit`, 
        //     success ? 'success' : 'fail'
        // );
        
        // if (failureReason) {
        //     metricsCollector.recordSafetyCheck(failureReason, 'fail');
        // }
    }

    /**
     * Record completion of entire token pipeline
     */
    recordTokenComplete(mint: string, success: boolean, totalLifetimeMs: number): void {
        this.totalTokensProcessed++;
        if (success) this.totalSuccessful++;
        
        this.tokenLifetimes.push(totalLifetimeMs);
        
        // Record hourly statistics
        const hour = new Date().getUTCHours();
        const hourlyStats = this.hourlyData.get(hour) || { processed: 0, success: 0 };
        hourlyStats.processed++;
        if (success) hourlyStats.success++;
        this.hourlyData.set(hour, hourlyStats);

        logger.info('STAGE_METRICS', 'Token pipeline complete', {
            mint: mint.substring(0, 8) + '...',
            success,
            lifetimeMs: totalLifetimeMs,
            totalProcessed: this.totalTokensProcessed,
            overallSuccessRate: (this.totalSuccessful / this.totalTokensProcessed * 100).toFixed(1) + '%'
        });

        // Record in Prometheus metrics (using compatible types)
        // metricsCollector.recordTradingOperation('token_pipeline', success ? 'success' : 'failure', totalLifetimeMs);
    }

    /**
     * Record specific failure reasons with context
     */
    recordFailureReason(
        reason: FailureReason, 
        stage: TokenStage, 
        mint: string, 
        additionalContext?: Record<string, any>
    ): void {
        this.failureCounts.set(reason, (this.failureCounts.get(reason) || 0) + 1);

        logger.info('STAGE_METRICS', 'Token failure recorded', {
            mint: mint.substring(0, 8) + '...',
            stage,
            reason,
            totalFailures: this.failureCounts.get(reason),
            ...additionalContext
        });

        // Record detailed failure metrics (using compatible types)
        // metricsCollector.recordSafetyCheck(`${stage.toLowerCase()}_${reason}`, 'fail');
    }

    /**
     * Get comprehensive pipeline metrics
     */
    getPipelineMetrics(): PipelineMetrics {
        const stageMetrics: Record<TokenStage, StageMetrics> = {
            'PRE_BOND': this.getStageMetrics('PRE_BOND'),
            'BONDED_ON_PUMP': this.getStageMetrics('BONDED_ON_PUMP'),
            'RAYDIUM_LISTED': this.getStageMetrics('RAYDIUM_LISTED')
        };

        // Convert failure counts to sorted array with percentages
        const totalFailures = Array.from(this.failureCounts.values()).reduce((a, b) => a + b, 0);
        const failureReasonsArray = Array.from(this.failureCounts.entries())
            .map(([reason, count]) => ({
                reason,
                count,
                percentage: totalFailures > 0 ? (count / totalFailures) * 100 : 0
            }))
            .sort((a, b) => b.count - a.count);

        // Convert failure counts to record
        const failureReasons: Partial<Record<FailureReason, number>> = {};
        for (const [reason, count] of this.failureCounts.entries()) {
            failureReasons[reason] = count;
        }

        // Get hourly stats
        const hourlyStats = Array.from(this.hourlyData.entries())
            .map(([hour, stats]) => ({ hour, ...stats }))
            .sort((a, b) => a.hour - b.hour);

        return {
            totalTokensProcessed: this.totalTokensProcessed,
            overallSuccessRate: this.totalTokensProcessed > 0 ? 
                               (this.totalSuccessful / this.totalTokensProcessed) : 0,
            avgTokenLifetime: this.calculateAverage(this.tokenLifetimes),
            stageMetrics,
            failureReasons,
            hourlyStats
        };
    }

    /**
     * Get metrics for a specific stage
     */
    private getStageMetrics(stage: TokenStage): StageMetrics {
        const entered = this.stageEntries.get(stage) || 0;
        const exited = this.stageExits.get(stage) || 0;
        const times = this.stageTimes.get(stage) || [];
        
        // Calculate success rate (simplified - may need more sophisticated tracking)
        const successRate = entered > 0 ? ((entered - this.getStageFailures(stage)) / entered) : 0;

        // Get top failure reasons for this stage
        const stageFailures = this.getTopFailureReasonsForStage(stage);

        return {
            stage,
            tokensEntered: entered,
            tokensExited: exited,
            avgStageTime: this.calculateAverage(times),
            successRate,
            topFailureReasons: stageFailures
        };
    }

    private getStageFailures(stage: TokenStage): number {
        // This is a simplified calculation - in reality we'd need more sophisticated tracking
        const stageSpecificReasons = this.getStageSpecificFailureReasons(stage);
        return stageSpecificReasons.reduce((total, reason) => 
            total + (this.failureCounts.get(reason) || 0), 0);
    }

    private getStageSpecificFailureReasons(stage: TokenStage): FailureReason[] {
        switch (stage) {
            case 'PRE_BOND':
                return [
                    FAILURE_REASONS.INVALID_NAME,
                    FAILURE_REASONS.NO_IMAGE,
                    FAILURE_REASONS.CREATOR_TOO_NEW,
                    FAILURE_REASONS.CREATOR_BLACKLISTED,
                    FAILURE_REASONS.DEAD_HOURS,
                    FAILURE_REASONS.LOW_PREBOND_SCORE
                ];
            case 'BONDED_ON_PUMP':
                return [
                    FAILURE_REASONS.NO_POOL_TIMEOUT,
                    FAILURE_REASONS.LOW_VELOCITY,
                    FAILURE_REASONS.SUSPICIOUS_CREATOR
                ];
            case 'RAYDIUM_LISTED':
                return [
                    FAILURE_REASONS.NO_ROUTE,
                    FAILURE_REASONS.LOW_LIQUIDITY,
                    FAILURE_REASONS.HIGH_LIQUIDITY,
                    FAILURE_REASONS.HONEYPOT,
                    FAILURE_REASONS.NO_LP_LOCK,
                    FAILURE_REASONS.LOW_SOCIAL_SCORE,
                    FAILURE_REASONS.BAD_HOLDER_DISTRIBUTION,
                    FAILURE_REASONS.DANGEROUS_AUTHORITIES,
                    FAILURE_REASONS.HIGH_SLIPPAGE
                ];
            default:
                return [];
        }
    }

    private getTopFailureReasonsForStage(stage: TokenStage, limit: number = 5): Array<{ reason: FailureReason; count: number; percentage: number }> {
        const stageReasons = this.getStageSpecificFailureReasons(stage);
        const totalStageFailures = stageReasons.reduce((total, reason) => 
            total + (this.failureCounts.get(reason) || 0), 0);

        return stageReasons
            .map(reason => ({
                reason,
                count: this.failureCounts.get(reason) || 0,
                percentage: totalStageFailures > 0 ? 
                           ((this.failureCounts.get(reason) || 0) / totalStageFailures) * 100 : 0
            }))
            .filter(item => item.count > 0)
            .sort((a, b) => b.count - a.count)
            .slice(0, limit);
    }

    private calculateAverage(numbers: number[]): number {
        if (numbers.length === 0) return 0;
        return numbers.reduce((a, b) => a + b, 0) / numbers.length;
    }

    /**
     * Generate a detailed metrics report
     */
    generateReport(): string {
        const metrics = this.getPipelineMetrics();
        const lines: string[] = [];

        lines.push('=== STAGE-AWARE PIPELINE METRICS REPORT ===\n');
        
        // Overall stats
        lines.push('📊 OVERALL PIPELINE PERFORMANCE:');
        lines.push(`Total Tokens Processed: ${metrics.totalTokensProcessed}`);
        lines.push(`Overall Success Rate: ${(metrics.overallSuccessRate * 100).toFixed(1)}%`);
        lines.push(`Average Token Lifetime: ${(metrics.avgTokenLifetime / 1000).toFixed(1)}s\n`);

        // Stage breakdown
        lines.push('📈 STAGE BREAKDOWN:');
        for (const [stageName, stageData] of Object.entries(metrics.stageMetrics)) {
            lines.push(`\n  ${stageName}:`);
            lines.push(`    Entered: ${stageData.tokensEntered}`);
            lines.push(`    Exited: ${stageData.tokensExited}`);
            lines.push(`    Avg Time: ${(stageData.avgStageTime / 1000).toFixed(1)}s`);
            lines.push(`    Success Rate: ${(stageData.successRate * 100).toFixed(1)}%`);
            
            if (stageData.topFailureReasons.length > 0) {
                lines.push(`    Top Failures:`);
                for (const failure of stageData.topFailureReasons.slice(0, 3)) {
                    lines.push(`      ${failure.reason}: ${failure.count} (${failure.percentage.toFixed(1)}%)`);
                }
            }
        }

        // Failure analysis
        lines.push('\n🚨 FAILURE ANALYSIS:');
        const sortedFailures = Object.entries(metrics.failureReasons)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 10);
            
        for (const [reason, count] of sortedFailures) {
            const percentage = (count / metrics.totalTokensProcessed * 100).toFixed(1);
            lines.push(`  ${reason}: ${count} (${percentage}%)`);
        }

        // Hourly distribution
        if (metrics.hourlyStats.length > 0) {
            lines.push('\n⏰ HOURLY DISTRIBUTION (UTC):');
            for (const hourStat of metrics.hourlyStats) {
                const successRate = hourStat.processed > 0 ? 
                                   (hourStat.success / hourStat.processed * 100).toFixed(1) : '0.0';
                lines.push(`  ${hourStat.hour.toString().padStart(2, '0')}:00 - Processed: ${hourStat.processed}, Success: ${successRate}%`);
            }
        }

        return lines.join('\n');
    }

    /**
     * Log current metrics summary
     */
    logSummary(): void {
        const metrics = this.getPipelineMetrics();
        
        logger.info('STAGE_METRICS', 'Pipeline metrics summary', {
            totalTokens: metrics.totalTokensProcessed,
            successRate: (metrics.overallSuccessRate * 100).toFixed(1) + '%',
            avgLifetime: (metrics.avgTokenLifetime / 1000).toFixed(1) + 's',
            preBondEntered: metrics.stageMetrics.PRE_BOND.tokensEntered,
            bondedEntered: metrics.stageMetrics.BONDED_ON_PUMP.tokensEntered,
            raydiumEntered: metrics.stageMetrics.RAYDIUM_LISTED.tokensEntered,
            topFailures: Object.entries(metrics.failureReasons)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 3)
                .map(([reason, count]) => `${reason}:${count}`)
        });
    }

    /**
     * Reset all metrics (for testing or periodic reset)
     */
    reset(): void {
        this.stageEntries.clear();
        this.stageExits.clear();
        this.stageTimes.clear();
        this.failureCounts.clear();
        this.hourlyData.clear();
        this.totalTokensProcessed = 0;
        this.totalSuccessful = 0;
        this.tokenLifetimes = [];
        
        logger.info('STAGE_METRICS', 'Metrics reset completed');
    }
}

// Global instance
export const stageAwareMetrics = new StageAwareMetricsCollector();