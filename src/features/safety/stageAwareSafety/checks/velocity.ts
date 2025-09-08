// src/features/safety/stageAwareSafety/checks/velocity.ts
// Token bonding velocity tracking and analysis

import logger from '../../../../utils/logger.js';

interface VelocityData {
    firstSeen: number;
    buyEvents: Array<{ timestamp: number; wallet: string; amount: number }>;
    uniqueWallets: Set<string>;
    totalVolume: number;
}

export class VelocityTracker {
    private velocityCache = new Map<string, VelocityData>();
    
    /**
     * Calculate bonding velocity metrics for a token
     */
    calculateBondingVelocity(mint: string): VelocityData {
        const cached = this.velocityCache.get(mint);
        if (cached) {
            return cached;
        }
        
        // Initialize velocity tracking for new token
        const now = Date.now();
        const velocity: VelocityData = {
            firstSeen: now,
            buyEvents: [],
            uniqueWallets: new Set<string>(),
            totalVolume: 0
        };
        
        this.velocityCache.set(mint, velocity);
        
        // Clean up old entries (tokens older than 1 hour)
        const oneHourAgo = now - (60 * 60 * 1000);
        for (const [key, value] of this.velocityCache.entries()) {
            if (value.firstSeen < oneHourAgo) {
                this.velocityCache.delete(key);
            }
        }
        
        return velocity;
    }
    
    /**
     * Record a buy event for velocity tracking
     */
    recordBuyEvent(mint: string, wallet: string, amount: number): void {
        const velocity = this.calculateBondingVelocity(mint);
        const timestamp = Date.now();
        
        velocity.buyEvents.push({ timestamp, wallet, amount });
        velocity.uniqueWallets.add(wallet);
        velocity.totalVolume += amount;
        
        // Keep only recent events (last 10 minutes for velocity calculation)
        const tenMinutesAgo = timestamp - (10 * 60 * 1000);
        velocity.buyEvents = velocity.buyEvents.filter(event => event.timestamp >= tenMinutesAgo);
        
        // Update unique wallets set based on recent events
        velocity.uniqueWallets.clear();
        for (const event of velocity.buyEvents) {
            velocity.uniqueWallets.add(event.wallet);
        }
        
        logger.debug('VELOCITY_TRACKING', 'Buy event recorded', {
            mint: mint.substring(0, 8) + '...',
            wallet: wallet.substring(0, 8) + '...',
            amount,
            uniqueWallets: velocity.uniqueWallets.size,
            recentEvents: velocity.buyEvents.length
        });
    }
    
    /**
     * Analyze velocity patterns for suspicious activity
     */
    analyzeVelocityPatterns(mint: string): {
        isHealthy: boolean;
        metrics: {
            eventsPerMinute: number;
            uniqueWalletRatio: number;
            averageAmount: number;
            totalVolume: number;
        };
        warnings: string[];
    } {
        const velocity = this.calculateBondingVelocity(mint);
        const now = Date.now();
        const warnings: string[] = [];
        
        // Recent events (last 10 minutes)
        const tenMinutesAgo = now - (10 * 60 * 1000);
        const recentEvents = velocity.buyEvents.filter(event => event.timestamp >= tenMinutesAgo);
        
        // Calculate metrics
        const eventsPerMinute = recentEvents.length / 10;
        const uniqueWalletRatio = recentEvents.length > 0 ? velocity.uniqueWallets.size / recentEvents.length : 1;
        const averageAmount = recentEvents.length > 0 ? 
            recentEvents.reduce((sum, event) => sum + event.amount, 0) / recentEvents.length : 0;
        
        // Pattern analysis
        let isHealthy = true;
        
        // Warning 1: Too many events from same wallets (potential bot activity)
        if (uniqueWalletRatio < 0.3 && recentEvents.length > 5) {
            warnings.push('low_wallet_diversity');
            isHealthy = false;
        }
        
        // Warning 2: Unusually high velocity (potential pump)
        if (eventsPerMinute > 15) {
            warnings.push('excessive_velocity');
            isHealthy = false;
        }
        
        // Warning 3: Very uniform amounts (potential coordinated buying)
        if (recentEvents.length >= 3) {
            const amounts = recentEvents.map(e => e.amount);
            const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
            const variance = amounts.reduce((sum, amount) => sum + Math.pow(amount - avgAmount, 2), 0) / amounts.length;
            const stdDev = Math.sqrt(variance);
            const coefficientOfVariation = avgAmount > 0 ? stdDev / avgAmount : 0;
            
            if (coefficientOfVariation < 0.1) { // Very low variation
                warnings.push('uniform_amounts');
                isHealthy = false;
            }
        }
        
        // Warning 4: No activity (potential dead token)
        if (recentEvents.length === 0 && (now - velocity.firstSeen) > (5 * 60 * 1000)) {
            warnings.push('no_activity');
            isHealthy = false;
        }
        
        const metrics = {
            eventsPerMinute,
            uniqueWalletRatio,
            averageAmount,
            totalVolume: velocity.totalVolume
        };
        
        logger.debug('VELOCITY_ANALYSIS', 'Velocity pattern analysis', {
            mint: mint.substring(0, 8) + '...',
            isHealthy,
            metrics,
            warnings
        });
        
        return { isHealthy, metrics, warnings };
    }
    
    /**
     * Get cache statistics for monitoring
     */
    getCacheStats(): { size: number; totalEvents: number; oldestToken: number } {
        let totalEvents = 0;
        let oldestToken = Date.now();
        
        for (const velocity of this.velocityCache.values()) {
            totalEvents += velocity.buyEvents.length;
            if (velocity.firstSeen < oldestToken) {
                oldestToken = velocity.firstSeen;
            }
        }
        
        return {
            size: this.velocityCache.size,
            totalEvents,
            oldestToken
        };
    }
    
    /**
     * Clear velocity data for a specific token
     */
    clearToken(mint: string): void {
        this.velocityCache.delete(mint);
    }
    
    /**
     * Clear all velocity data (for testing or memory management)
     */
    clearAll(): void {
        this.velocityCache.clear();
    }
}

// Singleton instance for global use
export const velocityTracker = new VelocityTracker();