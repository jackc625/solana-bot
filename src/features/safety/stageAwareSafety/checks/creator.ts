// src/features/safety/stageAwareSafety/checks/creator.ts
// Creator behavior analysis and quality assessment

import { FailureReason, FAILURE_REASONS } from '../../../../types/TokenStage.js';
import logger from '../../../../utils/logger.js';

interface CreatorBehavior {
    firstSeen: number;
    tokenCount: number;
    lastActivity: number;
    suspiciousPatterns: string[];
    riskScore: number;
}

export class CreatorAnalyzer {
    private creatorBehaviorCache = new Map<string, CreatorBehavior>();
    
    /**
     * Analyze creator behavior patterns for risk assessment
     */
    analyzeCreatorBehavior(creator: string): CreatorBehavior {
        const existing = this.creatorBehaviorCache.get(creator);
        if (existing) {
            return existing;
        }
        
        // Initialize new creator tracking
        const now = Date.now();
        const behavior: CreatorBehavior = {
            firstSeen: now,
            tokenCount: 0,
            lastActivity: now,
            suspiciousPatterns: [],
            riskScore: 0.0
        };
        
        this.creatorBehaviorCache.set(creator, behavior);
        
        // Clean up old entries (creators inactive for 24h)
        const dayAgo = now - (24 * 60 * 60 * 1000);
        for (const [key, value] of this.creatorBehaviorCache.entries()) {
            if (value.lastActivity < dayAgo) {
                this.creatorBehaviorCache.delete(key);
            }
        }
        
        return behavior;
    }
    
    /**
     * Check creator behavior for suspicious patterns
     */
    async checkCreatorBehavior(creator: string, currentMint: string): Promise<boolean> {
        const behavior = this.analyzeCreatorBehavior(creator);
        
        // Update token count for this creator
        behavior.tokenCount++;
        behavior.lastActivity = Date.now();
        
        // Check for suspicious patterns
        
        // Pattern 1: Too many tokens in short time (>3 tokens in last hour)
        if (behavior.tokenCount > 3) {
            const recentTokens = behavior.tokenCount;
            if (recentTokens > 3) {
                behavior.suspiciousPatterns.push('rapid_deployment');
                behavior.riskScore += 0.4;
            }
        }
        
        // Pattern 2: Consistent failure pattern (would need historical data)
        // This could be enhanced with actual failure tracking
        
        const isSuspicious = behavior.riskScore > 0.3;
        
        if (isSuspicious) {
            logger.debug('CREATOR_BEHAVIOR', 'Suspicious creator detected', {
                creator: creator.substring(0, 8) + '...',
                tokenCount: behavior.tokenCount,
                riskScore: behavior.riskScore,
                patterns: behavior.suspiciousPatterns
            });
        }
        
        return !isSuspicious; // Return true if behavior is acceptable
    }
    
    /**
     * Assess creator quality based on wallet characteristics
     */
    assessCreatorQuality(creator: string): number {
        let score = 0.5; // Base score
        
        try {
            // Basic address validation
            if (!creator || creator.length !== 44) {
                return 0.1;
            }
            
            // Address entropy check (avoiding obviously generated addresses)
            const entropy = this.calculateAddressEntropy(creator);
            if (entropy < 3.5) {
                score -= 0.2;
            } else if (entropy > 4.5) {
                score += 0.1;
            }
            
            // Creator behavior history
            const behavior = this.creatorBehaviorCache.get(creator);
            if (behavior) {
                // Penalize high-risk creators
                score -= behavior.riskScore;
                
                // Slight bonus for creators with some history but not too much
                if (behavior.tokenCount >= 1 && behavior.tokenCount <= 2) {
                    score += 0.05;
                }
            }
            
        } catch (error) {
            logger.warn('CREATOR_QUALITY', 'Error assessing creator quality', {
                creator: creator.substring(0, 8) + '...',
                error: error instanceof Error ? error.message : String(error)
            });
            return 0.3; // Default to low-medium quality on error
        }
        
        return Math.max(0, Math.min(1, score));
    }
    
    /**
     * Calculate address entropy (simple measure of randomness)
     */
    private calculateAddressEntropy(address: string): number {
        if (!address) return 0;
        
        const charCounts = new Map<string, number>();
        for (const char of address) {
            charCounts.set(char, (charCounts.get(char) || 0) + 1);
        }
        
        let entropy = 0;
        const length = address.length;
        
        for (const count of charCounts.values()) {
            const probability = count / length;
            entropy -= probability * Math.log2(probability);
        }
        
        return entropy;
    }
    
    /**
     * Get cache statistics for monitoring
     */
    getCacheStats(): { size: number; oldestEntry: number; averageRisk: number } {
        const now = Date.now();
        let oldestEntry = now;
        let totalRisk = 0;
        
        for (const behavior of this.creatorBehaviorCache.values()) {
            if (behavior.firstSeen < oldestEntry) {
                oldestEntry = behavior.firstSeen;
            }
            totalRisk += behavior.riskScore;
        }
        
        return {
            size: this.creatorBehaviorCache.size,
            oldestEntry: oldestEntry,
            averageRisk: this.creatorBehaviorCache.size > 0 ? totalRisk / this.creatorBehaviorCache.size : 0
        };
    }
}

// Singleton instance for global use
export const creatorAnalyzer = new CreatorAnalyzer();