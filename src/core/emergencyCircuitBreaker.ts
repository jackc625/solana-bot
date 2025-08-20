// src/core/emergencyCircuitBreaker.ts
// Emergency circuit breaker system to halt trading under anomalous conditions

import logger from "../utils/logger.js";
import { loadBotConfig } from "../config/index.js";

interface CircuitBreakerState {
    dailyTransactionCount: number;
    lastTransactionTime: number;
    rapidTransactionCount: number;
    lastDailyReset: number;
    networkAnomalyCount: number;
    lastNetworkCheck: number;
    emergencyHalt: boolean;
    haltReason?: string;
}

class EmergencyCircuitBreaker {
    private state: CircuitBreakerState = {
        dailyTransactionCount: 0,
        lastTransactionTime: 0,
        rapidTransactionCount: 0,
        lastDailyReset: 0,
        networkAnomalyCount: 0,
        lastNetworkCheck: 0,
        emergencyHalt: false
    };

    private readonly MAX_DAILY_TRANSACTIONS = 100;
    private readonly RAPID_TRANSACTION_WINDOW_MS = 30 * 1000; // 30 seconds
    private readonly MAX_RAPID_TRANSACTIONS = 10;
    private readonly NETWORK_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute
    private readonly MAX_NETWORK_ANOMALIES = 5;

    /**
     * Check if trading should be halted due to circuit breaker conditions
     */
    shouldHaltTrading(): boolean {
        this.checkDailyReset();
        
        // Emergency halt override
        if (this.state.emergencyHalt) {
            return true;
        }

        // Check daily transaction limit
        if (this.state.dailyTransactionCount >= this.MAX_DAILY_TRANSACTIONS) {
            this.triggerEmergencyHalt(`Daily transaction limit exceeded: ${this.state.dailyTransactionCount}/${this.MAX_DAILY_TRANSACTIONS}`);
            return true;
        }

        // Check rapid transaction accumulation
        const now = Date.now();
        const rapidWindow = now - this.RAPID_TRANSACTION_WINDOW_MS;
        if (this.state.lastTransactionTime > rapidWindow && this.state.rapidTransactionCount >= this.MAX_RAPID_TRANSACTIONS) {
            this.triggerEmergencyHalt(`Rapid transaction limit exceeded: ${this.state.rapidTransactionCount} transactions in ${this.RAPID_TRANSACTION_WINDOW_MS/1000}s`);
            return true;
        }

        return false;
    }

    /**
     * Record a new transaction for circuit breaker tracking
     */
    recordTransaction(): void {
        const now = Date.now();
        this.checkDailyReset();

        // Increment daily counter
        this.state.dailyTransactionCount++;

        // Track rapid transactions
        const rapidWindow = now - this.RAPID_TRANSACTION_WINDOW_MS;
        if (this.state.lastTransactionTime > rapidWindow) {
            this.state.rapidTransactionCount++;
        } else {
            this.state.rapidTransactionCount = 1;
        }

        this.state.lastTransactionTime = now;

        logger.info('CIRCUIT_BREAKER', 'Transaction recorded', {
            dailyCount: this.state.dailyTransactionCount,
            rapidCount: this.state.rapidTransactionCount,
            maxDaily: this.MAX_DAILY_TRANSACTIONS,
            maxRapid: this.MAX_RAPID_TRANSACTIONS
        });
    }

    /**
     * Check for network anomalies (e.g., unusual priority fees, failed RPC calls)
     */
    recordNetworkAnomaly(reason: string): void {
        const now = Date.now();
        
        // Reset network anomaly count if enough time has passed
        if (now - this.state.lastNetworkCheck > this.NETWORK_CHECK_INTERVAL_MS) {
            this.state.networkAnomalyCount = 0;
        }

        this.state.networkAnomalyCount++;
        this.state.lastNetworkCheck = now;

        logger.warn('CIRCUIT_BREAKER', 'Network anomaly detected', {
            reason,
            count: this.state.networkAnomalyCount,
            maxAnomalies: this.MAX_NETWORK_ANOMALIES
        });

        // Trigger halt if too many anomalies
        if (this.state.networkAnomalyCount >= this.MAX_NETWORK_ANOMALIES) {
            this.triggerEmergencyHalt(`Network anomaly threshold exceeded: ${this.state.networkAnomalyCount} anomalies detected`);
        }
    }

    /**
     * Check if a potential flash crash is happening (rapid price movements)
     */
    checkFlashCrashProtection(priceChange: number, timeWindowMs: number): boolean {
        const FLASH_CRASH_THRESHOLD = 0.5; // 50% price drop
        const FLASH_CRASH_TIME_WINDOW = 60 * 1000; // 1 minute

        if (priceChange < -FLASH_CRASH_THRESHOLD && timeWindowMs < FLASH_CRASH_TIME_WINDOW) {
            this.triggerEmergencyHalt(`Flash crash detected: ${(priceChange * 100).toFixed(1)}% price drop in ${timeWindowMs/1000}s`);
            return true;
        }

        return false;
    }

    /**
     * Manually trigger emergency halt
     */
    triggerEmergencyHalt(reason: string): void {
        this.state.emergencyHalt = true;
        this.state.haltReason = reason;

        logger.error('CIRCUIT_BREAKER', '🚨 EMERGENCY TRADING HALT TRIGGERED', {
            reason,
            timestamp: new Date().toISOString(),
            state: this.getState()
        });
    }

    /**
     * Reset emergency halt (manual intervention required)
     */
    resetEmergencyHalt(): void {
        this.state.emergencyHalt = false;
        this.state.haltReason = undefined;
        
        logger.info('CIRCUIT_BREAKER', '✅ Emergency halt reset', {
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Get current circuit breaker state
     */
    getState(): CircuitBreakerState {
        return { ...this.state };
    }

    /**
     * Check if daily tracking should be reset
     */
    private checkDailyReset(): void {
        const now = Date.now();
        const todayStart = new Date().setHours(0, 0, 0, 0);
        
        if (this.state.lastDailyReset < todayStart) {
            this.state.dailyTransactionCount = 0;
            this.state.lastDailyReset = now;
            
            logger.info('CIRCUIT_BREAKER', '🔄 Daily transaction count reset', {
                date: new Date().toDateString()
            });
        }
    }

    /**
     * Get circuit breaker status for monitoring
     */
    getStatus(): object {
        return {
            isHalted: this.state.emergencyHalt,
            haltReason: this.state.haltReason,
            dailyTransactions: `${this.state.dailyTransactionCount}/${this.MAX_DAILY_TRANSACTIONS}`,
            rapidTransactions: `${this.state.rapidTransactionCount}/${this.MAX_RAPID_TRANSACTIONS}`,
            networkAnomalies: `${this.state.networkAnomalyCount}/${this.MAX_NETWORK_ANOMALIES}`,
            lastTransactionTime: new Date(this.state.lastTransactionTime).toISOString()
        };
    }
}

// Singleton instance
export const emergencyCircuitBreaker = new EmergencyCircuitBreaker();

export default emergencyCircuitBreaker;