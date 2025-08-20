// src/utils/networkHealth.ts
// Network health monitoring and validation utilities

import { Connection } from "@solana/web3.js";
import logger from "./logger.js";
import emergencyCircuitBreaker from "../core/emergencyCircuitBreaker.js";

interface NetworkHealthMetrics {
    rpcLatency: number;
    blockHeight: number;
    priorityFeeLevel: number;
    lastUpdate: number;
    isHealthy: boolean;
    consecutiveFailures: number;
}

class NetworkHealthMonitor {
    private metrics: NetworkHealthMetrics = {
        rpcLatency: 0,
        blockHeight: 0,
        priorityFeeLevel: 0,
        lastUpdate: 0,
        isHealthy: true,
        consecutiveFailures: 0
    };

    private readonly MAX_CONSECUTIVE_FAILURES = 3;
    private readonly MAX_RPC_LATENCY_MS = 2000;
    private readonly HEALTH_CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds

    /**
     * Validate RPC endpoint health before critical operations
     */
    async validateRpcHealth(connection: Connection): Promise<boolean> {
        try {
            const startTime = Date.now();
            
            // Test basic RPC functionality
            const [slot, blockHeight, recentPerformance] = await Promise.all([
                connection.getSlot(),
                connection.getBlockHeight(),
                connection.getRecentPerformanceSamples(1)
            ]);

            const latency = Date.now() - startTime;
            
            // Update metrics
            this.metrics.rpcLatency = latency;
            this.metrics.blockHeight = blockHeight;
            this.metrics.lastUpdate = Date.now();

            // Health checks
            if (latency > this.MAX_RPC_LATENCY_MS) {
                this.recordFailure(`High RPC latency: ${latency}ms`);
                return false;
            }

            if (!slot || slot === 0) {
                this.recordFailure('Invalid slot response from RPC');
                return false;
            }

            if (!blockHeight || blockHeight === 0) {
                this.recordFailure('Invalid block height response from RPC');
                return false;
            }

            // Check for stale data
            const now = Date.now();
            if (this.metrics.lastUpdate > 0 && now - this.metrics.lastUpdate > this.HEALTH_CHECK_INTERVAL_MS * 2) {
                this.recordFailure('Stale RPC data detected');
                return false;
            }

            // Reset failure count on success
            this.metrics.consecutiveFailures = 0;
            this.metrics.isHealthy = true;

            logger.debug('NETWORK_HEALTH', 'RPC health check passed', {
                latency,
                blockHeight,
                slot
            });

            return true;

        } catch (error) {
            this.recordFailure(`RPC health check failed: ${(error as Error).message}`);
            return false;
        }
    }

    /**
     * Monitor network congestion and priority fee levels
     */
    async checkNetworkCongestion(connection: Connection): Promise<{ isHealthy: boolean; reason?: string }> {
        try {
            const recentPerformance = await connection.getRecentPerformanceSamples(5);
            
            if (!recentPerformance || recentPerformance.length === 0) {
                return { isHealthy: false, reason: 'No performance data available' };
            }

            // Calculate average transaction per second
            const avgTps = recentPerformance.reduce((sum, sample) => sum + sample.numTransactions, 0) / recentPerformance.length;
            const avgSlotTime = recentPerformance.reduce((sum, sample) => sum + sample.samplePeriodSecs, 0) / recentPerformance.length;

            // Check for network congestion indicators
            const CONGESTION_TPS_THRESHOLD = 2000; // Adjust based on network capacity
            const HIGH_SLOT_TIME_THRESHOLD = 1.0; // Seconds

            if (avgTps > CONGESTION_TPS_THRESHOLD) {
                emergencyCircuitBreaker.recordNetworkAnomaly(`High network congestion: ${avgTps.toFixed(0)} TPS`);
                return { isHealthy: false, reason: `Network congestion detected: ${avgTps.toFixed(0)} TPS` };
            }

            if (avgSlotTime > HIGH_SLOT_TIME_THRESHOLD) {
                emergencyCircuitBreaker.recordNetworkAnomaly(`Slow block times: ${avgSlotTime.toFixed(2)}s per slot`);
                return { isHealthy: false, reason: `Slow block production: ${avgSlotTime.toFixed(2)}s per slot` };
            }

            return { isHealthy: true };

        } catch (error) {
            return { isHealthy: false, reason: `Network congestion check failed: ${(error as Error).message}` };
        }
    }

    /**
     * Validate priority fee levels to detect anomalies
     */
    validatePriorityFee(calculatedFee: number): boolean {
        const NORMAL_PRIORITY_FEE_RANGE = [0.000001, 0.01]; // SOL
        const EXTREME_PRIORITY_FEE_THRESHOLD = 0.1; // SOL

        if (calculatedFee < NORMAL_PRIORITY_FEE_RANGE[0]) {
            logger.warn('NETWORK_HEALTH', 'Unusually low priority fee detected', { fee: calculatedFee });
            return false;
        }

        if (calculatedFee > NORMAL_PRIORITY_FEE_RANGE[1]) {
            emergencyCircuitBreaker.recordNetworkAnomaly(`High priority fee detected: ${calculatedFee} SOL`);
            
            if (calculatedFee > EXTREME_PRIORITY_FEE_THRESHOLD) {
                emergencyCircuitBreaker.recordNetworkAnomaly(`Extreme priority fee detected: ${calculatedFee} SOL`);
                return false;
            }
            
            logger.warn('NETWORK_HEALTH', 'High priority fee detected', { fee: calculatedFee });
        }

        this.metrics.priorityFeeLevel = calculatedFee;
        return true;
    }

    /**
     * Record health check failure
     */
    private recordFailure(reason: string): void {
        this.metrics.consecutiveFailures++;
        
        if (this.metrics.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
            this.metrics.isHealthy = false;
            emergencyCircuitBreaker.recordNetworkAnomaly(`Network health check failed: ${reason}`);
        }

        logger.warn('NETWORK_HEALTH', 'Health check failure', {
            reason,
            consecutiveFailures: this.metrics.consecutiveFailures,
            maxFailures: this.MAX_CONSECUTIVE_FAILURES
        });
    }

    /**
     * Get current network health metrics
     */
    getMetrics(): NetworkHealthMetrics {
        return { ...this.metrics };
    }

    /**
     * Get network health status for monitoring
     */
    getHealthStatus(): object {
        return {
            isHealthy: this.metrics.isHealthy,
            rpcLatency: `${this.metrics.rpcLatency}ms`,
            blockHeight: this.metrics.blockHeight,
            priorityFeeLevel: this.metrics.priorityFeeLevel,
            consecutiveFailures: this.metrics.consecutiveFailures,
            lastUpdate: new Date(this.metrics.lastUpdate).toISOString()
        };
    }

    /**
     * Reset health status (manual intervention)
     */
    resetHealth(): void {
        this.metrics.isHealthy = true;
        this.metrics.consecutiveFailures = 0;
        logger.info('NETWORK_HEALTH', '✅ Network health status reset');
    }
}

// Singleton instance
export const networkHealthMonitor = new NetworkHealthMonitor();

export default networkHealthMonitor;