// src/utils/metricsCollector.ts
// Comprehensive Prometheus metrics collection for Solana trading bot

import { register, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { Connection } from '@solana/web3.js';
import logger from './logger.js';
import { loadBotConfig } from '../config/index.js';
import rpcManager from './rpcManager.js';
import positionPersistence from './positionPersistence.js';

/**
 * Trading operation types for metrics labeling
 */
export type TradingOperation = 'buy' | 'sell' | 'quote' | 'route_validation' | 'safety_check' | 'scoring';

/**
 * Trading outcome types for metrics labeling
 */
export type TradingOutcome = 'success' | 'failure' | 'timeout' | 'rejected' | 'error';

/**
 * System component types for health metrics
 */
export type SystemComponent = 'rpc' | 'jupiter' | 'pump_portal' | 'telegram' | 'persistence' | 'websocket';

/**
 * Comprehensive metrics collector for Solana trading bot
 */
class MetricsCollector {
    private isInitialized = false;
    private config = loadBotConfig();
    
    // === TRADING METRICS ===
    
    /**
     * Counter for total trading operations
     */
    public readonly tradingOperationsTotal = new Counter({
        name: 'solana_bot_trading_operations_total',
        help: 'Total number of trading operations by type and outcome',
        labelNames: ['operation', 'outcome', 'token_symbol'] as const,
        registers: [register]
    });

    /**
     * Histogram for trading operation duration
     */
    public readonly tradingOperationDuration = new Histogram({
        name: 'solana_bot_trading_operation_duration_seconds',
        help: 'Duration of trading operations in seconds',
        labelNames: ['operation', 'outcome'] as const,
        buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60], // seconds
        registers: [register]
    });

    /**
     * Counter for trades executed
     */
    public readonly tradesExecuted = new Counter({
        name: 'solana_bot_trades_executed_total',
        help: 'Total number of trades executed',
        labelNames: ['side', 'outcome', 'exit_reason'] as const,
        registers: [register]
    });

    /**
     * Histogram for trade sizes in SOL
     */
    public readonly tradeSizes = new Histogram({
        name: 'solana_bot_trade_size_sol',
        help: 'Trade sizes in SOL',
        labelNames: ['side'] as const,
        buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5], // SOL
        registers: [register]
    });

    /**
     * Histogram for trade profit/loss
     */
    public readonly tradePnl = new Histogram({
        name: 'solana_bot_trade_pnl_sol',
        help: 'Trade profit/loss in SOL',
        labelNames: ['outcome'] as const,
        buckets: [-1, -0.5, -0.1, -0.05, -0.01, 0, 0.01, 0.05, 0.1, 0.5, 1], // SOL
        registers: [register]
    });

    /**
     * Histogram for trade ROI percentage
     */
    public readonly tradeRoi = new Histogram({
        name: 'solana_bot_trade_roi_percent',
        help: 'Trade ROI as percentage',
        labelNames: ['outcome'] as const,
        buckets: [-50, -25, -10, -5, -1, 0, 1, 5, 10, 25, 50, 100, 200], // percent
        registers: [register]
    });

    /**
     * Gauge for current portfolio value
     */
    public readonly portfolioValue = new Gauge({
        name: 'solana_bot_portfolio_value_sol',
        help: 'Current portfolio value in SOL',
        registers: [register]
    });

    /**
     * Gauge for current number of active positions
     */
    public readonly activePositions = new Gauge({
        name: 'solana_bot_active_positions',
        help: 'Number of currently active trading positions',
        registers: [register]
    });

    /**
     * Gauge for wallet SOL balance
     */
    public readonly walletBalance = new Gauge({
        name: 'solana_bot_wallet_balance_sol',
        help: 'Current wallet SOL balance',
        registers: [register]
    });

    // === SYSTEM HEALTH METRICS ===

    /**
     * Counter for system component health checks
     */
    public readonly systemHealthChecks = new Counter({
        name: 'solana_bot_health_checks_total',
        help: 'Total number of system health checks',
        labelNames: ['component', 'status'] as const,
        registers: [register]
    });

    /**
     * Histogram for RPC response times
     */
    public readonly rpcResponseTime = new Histogram({
        name: 'solana_bot_rpc_response_time_seconds',
        help: 'RPC response time in seconds',
        labelNames: ['endpoint', 'method'] as const,
        buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5], // seconds
        registers: [register]
    });

    /**
     * Counter for RPC operations
     */
    public readonly rpcOperations = new Counter({
        name: 'solana_bot_rpc_operations_total',
        help: 'Total number of RPC operations',
        labelNames: ['endpoint', 'method', 'status'] as const,
        registers: [register]
    });

    /**
     * Gauge for RPC health status
     */
    public readonly rpcHealth = new Gauge({
        name: 'solana_bot_rpc_health',
        help: 'RPC endpoint health status (1=healthy, 0=unhealthy)',
        labelNames: ['endpoint'] as const,
        registers: [register]
    });

    /**
     * Histogram for Jupiter quote response times
     */
    public readonly jupiterResponseTime = new Histogram({
        name: 'solana_bot_jupiter_response_time_seconds',
        help: 'Jupiter API response time in seconds',
        labelNames: ['operation'] as const,
        buckets: [0.1, 0.5, 1, 2, 5, 10, 30], // seconds
        registers: [register]
    });

    /**
     * Counter for Jupiter operations
     */
    public readonly jupiterOperations = new Counter({
        name: 'solana_bot_jupiter_operations_total',
        help: 'Total number of Jupiter operations',
        labelNames: ['operation', 'status'] as const,
        registers: [register]
    });

    // === RISK MANAGEMENT METRICS ===

    /**
     * Counter for risk management decisions
     */
    public readonly riskDecisions = new Counter({
        name: 'solana_bot_risk_decisions_total',
        help: 'Total number of risk management decisions',
        labelNames: ['type', 'decision', 'reason'] as const,
        registers: [register]
    });

    /**
     * Gauge for current portfolio risk exposure
     */
    public readonly portfolioRiskExposure = new Gauge({
        name: 'solana_bot_portfolio_risk_exposure_percent',
        help: 'Current portfolio risk exposure as percentage',
        labelNames: ['type'] as const,
        registers: [register]
    });

    /**
     * Counter for safety check results
     */
    public readonly safetyChecks = new Counter({
        name: 'solana_bot_safety_checks_total',
        help: 'Total number of safety checks performed',
        labelNames: ['check_type', 'result'] as const,
        registers: [register]
    });

    // === PERFORMANCE METRICS ===

    /**
     * Histogram for token discovery to trade execution latency
     */
    public readonly discoveryToTrade = new Histogram({
        name: 'solana_bot_discovery_to_trade_seconds',
        help: 'Time from token discovery to trade execution',
        buckets: [1, 2, 5, 10, 30, 60, 120], // seconds
        registers: [register]
    });

    /**
     * Gauge for pending tokens queue size
     */
    public readonly pendingTokensQueue = new Gauge({
        name: 'solana_bot_pending_tokens_queue_size',
        help: 'Number of tokens in pending validation queue',
        registers: [register]
    });

    /**
     * Counter for token validation pipeline
     */
    public readonly tokenValidation = new Counter({
        name: 'solana_bot_token_validation_total',
        help: 'Total number of tokens processed through validation pipeline',
        labelNames: ['stage', 'result'] as const,
        registers: [register]
    });

    // === AUTO-SELL METRICS ===

    /**
     * Counter for auto-sell triggers
     */
    public readonly autoSellTriggers = new Counter({
        name: 'solana_bot_auto_sell_triggers_total',
        help: 'Total number of auto-sell triggers',
        labelNames: ['trigger_type', 'outcome'] as const,
        registers: [register]
    });

    /**
     * Histogram for position hold duration
     */
    public readonly positionHoldDuration = new Histogram({
        name: 'solana_bot_position_hold_duration_seconds',
        help: 'Duration positions are held before selling',
        labelNames: ['exit_reason'] as const,
        buckets: [30, 60, 300, 600, 1800, 3600, 7200, 14400], // seconds
        registers: [register]
    });

    /**
     * Histogram for token scores
     */
    public readonly tokenScores = new Histogram({
        name: 'solana_bot_token_scores',
        help: 'Distribution of token scores from scoring algorithm',
        buckets: [0, 1, 2, 3, 4, 5, 6, 7],
        registers: [register]
    });

    /**
     * Counter for system events
     */
    public readonly systemEvents = new Counter({
        name: 'solana_bot_system_events_total',
        help: 'Total number of system events by level and component',
        labelNames: ['level', 'component', 'event_type'] as const,
        registers: [register]
    });

    constructor() {
        // Initialize default Node.js metrics (memory, CPU, etc.)
        this.initializeDefaultMetrics();
    }

    /**
     * Initialize the metrics collector
     */
    async initialize(): Promise<void> {
        try {
            this.isInitialized = true;
            
            // Start periodic health metrics collection
            this.startPeriodicMetricsCollection();
            
            logger.info('METRICS', '✅ Prometheus metrics collector initialized', {
                metricsCount: register.getMetricsAsArray().length
            });

        } catch (error) {
            logger.error('METRICS', 'Failed to initialize metrics collector', {
                error: (error as Error).message
            });
            throw error;
        }
    }

    /**
     * Record a trading operation
     */
    recordTradingOperation(
        operation: TradingOperation,
        outcome: TradingOutcome,
        durationMs: number,
        tokenSymbol?: string
    ): void {
        this.tradingOperationsTotal.inc({
            operation,
            outcome,
            token_symbol: tokenSymbol || 'unknown'
        });

        this.tradingOperationDuration.observe(
            { operation, outcome },
            durationMs / 1000
        );
    }

    /**
     * Record a completed trade
     */
    recordTrade(
        side: 'buy' | 'sell',
        sizeSOL: number,
        outcome: TradingOutcome,
        exitReason?: string,
        pnlSOL?: number,
        roiPercent?: number
    ): void {
        this.tradesExecuted.inc({
            side,
            outcome,
            exit_reason: exitReason || 'none'
        });

        this.tradeSizes.observe({ side }, sizeSOL);

        if (pnlSOL !== undefined) {
            this.tradePnl.observe({ outcome }, pnlSOL);
        }

        if (roiPercent !== undefined) {
            this.tradeRoi.observe({ outcome }, roiPercent);
        }
    }

    /**
     * Record RPC operation
     */
    recordRpcOperation(
        endpoint: string,
        method: string,
        status: 'success' | 'failure',
        durationMs: number
    ): void {
        this.rpcOperations.inc({ endpoint, method, status });
        this.rpcResponseTime.observe(
            { endpoint, method },
            durationMs / 1000
        );
    }

    /**
     * Record Jupiter operation
     */
    recordJupiterOperation(
        operation: 'quote' | 'route' | 'swap',
        status: 'success' | 'failure',
        durationMs: number
    ): void {
        this.jupiterOperations.inc({ operation, status });
        this.jupiterResponseTime.observe({ operation }, durationMs / 1000);
    }

    /**
     * Record risk management decision
     */
    recordRiskDecision(
        type: 'position_size' | 'exposure' | 'concentration' | 'deployer' | 'emergency',
        decision: 'allow' | 'reject' | 'limit',
        reason?: string
    ): void {
        this.riskDecisions.inc({
            type,
            decision,
            reason: reason || 'none'
        });
    }

    /**
     * Record safety check result
     */
    recordSafetyCheck(
        checkType: 'liquidity' | 'honeypot' | 'authority' | 'holder_distribution' | 'lp_lock' | 'social',
        result: 'pass' | 'fail' | 'warning'
    ): void {
        this.safetyChecks.inc({ check_type: checkType, result });
    }

    /**
     * Record auto-sell trigger
     */
    recordAutoSellTrigger(
        triggerType: 'take_profit' | 'stop_loss' | 'trailing_stop' | 'max_hold' | 'scale_out',
        outcome: 'executed' | 'failed' | 'skipped'
    ): void {
        this.autoSellTriggers.inc({ trigger_type: triggerType, outcome });
    }

    /**
     * Record position hold duration
     */
    recordPositionHoldDuration(durationMs: number, exitReason: string): void {
        this.positionHoldDuration.observe(
            { exit_reason: exitReason },
            durationMs / 1000
        );
    }

    /**
     * Record token validation stage
     */
    recordTokenValidation(
        stage: 'discovery' | 'retry_validation' | 'safety_check' | 'scoring' | 'risk_check' | 'processing',
        result: 'pass' | 'fail' | 'timeout' | 'start' | 'error'
    ): void {
        this.tokenValidation.inc({ stage, result });
    }

    /**
     * Record token scoring results
     */
    recordTokenScore(score: number, threshold: number): void {
        this.tokenScores.observe(score);
        // Also increment trading operations for scoring
        this.tradingOperationsTotal.inc({ 
            operation: 'scoring', 
            outcome: score >= threshold ? 'success' : 'failure',
            token_symbol: 'unknown'
        });
    }

    /**
     * Record system events for monitoring
     */
    recordSystemEvent(level: 'info' | 'warn' | 'error', component: string, message: string): void {
        this.systemEvents.inc({ 
            level, 
            component, 
            event_type: 'general'
        });
    }

    /**
     * Update portfolio metrics
     */
    async updatePortfolioMetrics(): Promise<void> {
        try {
            const stats = positionPersistence.getStatistics() as any;
            
            this.activePositions.set(Number(stats.activePositions));
            this.portfolioValue.set(Number(stats.portfolioValue || 0));
            
            // Update risk exposure metrics
            const totalExposure = Number(stats.totalExposureSOL);
            if (totalExposure > 0) {
                // Calculate exposure percentages based on limits
                const config = this.config;
                const maxExposure = config.maxWalletExposure || 1.0;
                this.portfolioRiskExposure.set(
                    { type: 'total' },
                    (totalExposure / maxExposure) * 100
                );
            }

        } catch (error) {
            logger.debug('METRICS', 'Failed to update portfolio metrics', {
                error: (error as Error).message
            });
        }
    }

    /**
     * Update RPC health metrics
     */
    updateRpcHealthMetrics(): void {
        try {
            const rpcStatuses = rpcManager.getAllRpcStatuses();
            
            for (const status of rpcStatuses) {
                this.rpcHealth.set(
                    { endpoint: status.endpoint.name },
                    status.metrics.isHealthy ? 1 : 0
                );
            }

        } catch (error) {
            logger.debug('METRICS', 'Failed to update RPC health metrics', {
                error: (error as Error).message
            });
        }
    }

    /**
     * Update system health metrics
     */
    recordSystemHealthCheck(component: SystemComponent, status: 'healthy' | 'degraded' | 'unhealthy'): void {
        this.systemHealthChecks.inc({ component, status });
    }

    /**
     * Get metrics for Prometheus scraping
     */
    async getMetrics(): Promise<string> {
        // Update dynamic metrics before scraping
        await this.updatePortfolioMetrics();
        this.updateRpcHealthMetrics();
        
        return register.metrics();
    }

    /**
     * Get metrics registry for custom endpoint setup
     */
    getRegistry() {
        return register;
    }

    /**
     * Clear all metrics (useful for testing)
     */
    clearMetrics(): void {
        register.clear();
        this.initializeDefaultMetrics();
    }

    /**
     * Shutdown metrics collection
     */
    shutdown(): void {
        this.isInitialized = false;
        logger.info('METRICS', '🔄 Metrics collector shutdown completed');
    }

    // Private methods

    private initializeDefaultMetrics(): void {
        // Collect default Node.js metrics (memory, CPU, GC, etc.)
        collectDefaultMetrics({
            register,
            prefix: 'solana_bot_nodejs_',
            gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5] // seconds
        });
    }

    private startPeriodicMetricsCollection(): void {
        // Update metrics every 30 seconds
        setInterval(async () => {
            if (!this.isInitialized) return;
            
            try {
                await this.updatePortfolioMetrics();
                this.updateRpcHealthMetrics();
            } catch (error) {
                logger.debug('METRICS', 'Periodic metrics update failed', {
                    error: (error as Error).message
                });
            }
        }, 30000);

        logger.info('METRICS', '⏰ Periodic metrics collection started (30s interval)');
    }
}

// Singleton instance
export const metricsCollector = new MetricsCollector();

export default metricsCollector;