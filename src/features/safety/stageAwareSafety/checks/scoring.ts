// src/features/safety/stageAwareSafety/checks/scoring.ts
// Token quality scoring and assessment logic

import { TokenCandidate } from '../../../../types/TokenStage.js';
import { creatorAnalyzer } from './creator.js';
import logger from '../../../../utils/logger.js';

export class TokenScorer {
    
    /**
     * Calculate comprehensive pre-bond score for a token
     */
    calculatePreBondScore(candidate: TokenCandidate): number {
        let totalScore = 0;
        let maxScore = 0;
        
        try {
            // Component 1: Token name quality (weight: 0.3)
            const nameScore = this.assessTokenNameQuality(candidate.mint);
            totalScore += nameScore * 0.3;
            maxScore += 0.3;
            
            // Component 2: Creator quality (weight: 0.4)
            const creatorScore = creatorAnalyzer.assessCreatorQuality(candidate.creator);
            totalScore += creatorScore * 0.4;
            maxScore += 0.4;
            
            // Component 3: Timing factors (weight: 0.2)
            const timingScore = this.assessTimingFactors(candidate);
            totalScore += timingScore * 0.2;
            maxScore += 0.2;
            
            // Component 4: Market conditions (weight: 0.1)
            const marketScore = this.assessMarketConditions();
            totalScore += marketScore * 0.1;
            maxScore += 0.1;
            
            const finalScore = maxScore > 0 ? totalScore / maxScore : 0;
            
            logger.debug('PREBOND_SCORING', 'Pre-bond score calculated', {
                mint: candidate.mint.substring(0, 8) + '...',
                nameScore: (nameScore * 100).toFixed(1) + '%',
                creatorScore: (creatorScore * 100).toFixed(1) + '%',
                timingScore: (timingScore * 100).toFixed(1) + '%',
                marketScore: (marketScore * 100).toFixed(1) + '%',
                finalScore: (finalScore * 100).toFixed(1) + '%'
            });
            
            return Math.max(0, Math.min(1, finalScore));
            
        } catch (error) {
            logger.warn('PREBOND_SCORING', 'Error calculating pre-bond score', {
                mint: candidate.mint.substring(0, 8) + '...',
                error: error instanceof Error ? error.message : String(error)
            });
            return 0.1; // Low default score on error
        }
    }
    
    /**
     * Assess token name quality based on various factors
     */
    assessTokenNameQuality(mintOrName: string): number {
        // For now, using mint address - could be enhanced with actual token name
        let score = 0.5; // Base score
        
        try {
            if (!mintOrName || mintOrName.length < 32) {
                return 0.1;
            }
            
            // Check for common spam patterns (could be enhanced)
            const commonSpamPatterns = [
                /^[0-9]+$/, // All numbers
                /(.)\1{10,}/, // Repeated characters
                /test|fake|scam/i // Common spam words
            ];
            
            for (const pattern of commonSpamPatterns) {
                if (pattern.test(mintOrName)) {
                    score -= 0.3;
                    break;
                }
            }
            
            // Bonus for reasonable complexity
            const hasVariety = /[A-Z]/.test(mintOrName) && /[a-z]/.test(mintOrName) && /[0-9]/.test(mintOrName);
            if (hasVariety) {
                score += 0.1;
            }
            
        } catch (error) {
            logger.warn('TOKEN_NAME_QUALITY', 'Error assessing token name quality', {
                mintOrName: mintOrName.substring(0, 8) + '...',
                error: error instanceof Error ? error.message : String(error)
            });
            return 0.3; // Default on error
        }
        
        return Math.max(0, Math.min(1, score));
    }
    
    /**
     * Assess timing factors (time of day, day of week, etc.)
     */
    private assessTimingFactors(candidate: TokenCandidate): number {
        let score = 0.5; // Base score
        
        try {
            const now = new Date();
            const hour = now.getUTCHours();
            const dayOfWeek = now.getUTCDay(); // 0 = Sunday, 6 = Saturday
            
            // Time of day factors (prefer active trading hours)
            if (hour >= 13 && hour <= 21) { // 1 PM to 9 PM UTC (active US trading hours)
                score += 0.2;
            } else if (hour >= 8 && hour <= 12) { // European hours
                score += 0.1;
            } else if (hour >= 0 && hour <= 6) { // Asian hours
                score += 0.1;
            } else {
                score -= 0.1; // Dead hours
            }
            
            // Day of week factors (prefer weekdays)
            if (dayOfWeek >= 1 && dayOfWeek <= 5) { // Monday to Friday
                score += 0.1;
            } else {
                score -= 0.05; // Weekend
            }
            
            // Token age factor (slight preference for not-too-fresh tokens)
            if (candidate.createdAt) {
                const ageMs = Date.now() - candidate.createdAt;
                const ageMinutes = ageMs / (60 * 1000);
                
                if (ageMinutes >= 5 && ageMinutes <= 60) { // 5-60 minutes old
                    score += 0.05;
                } else if (ageMinutes < 2) { // Very fresh
                    score -= 0.1;
                } else if (ageMinutes > 120) { // Very old
                    score -= 0.05;
                }
            }
            
        } catch (error) {
            logger.warn('TIMING_FACTORS', 'Error assessing timing factors', {
                error: error instanceof Error ? error.message : String(error)
            });
        }
        
        return Math.max(0, Math.min(1, score));
    }
    
    /**
     * Assess current market conditions
     */
    private assessMarketConditions(): number {
        // This is a simplified implementation
        // Could be enhanced with actual market data
        
        let score = 0.5; // Neutral market score
        
        try {
            const hour = new Date().getUTCHours();
            
            // Simple heuristic: prefer high-activity periods
            if (hour >= 14 && hour <= 20) { // Peak US trading hours
                score = 0.7;
            } else if (hour >= 8 && hour <= 13) { // European hours
                score = 0.6;
            } else {
                score = 0.4; // Lower activity hours
            }
            
            // Could add:
            // - SOL price volatility
            // - Overall market sentiment
            // - Recent token success rates
            // - Gas prices / network congestion
            
        } catch (error) {
            logger.warn('MARKET_CONDITIONS', 'Error assessing market conditions', {
                error: error instanceof Error ? error.message : String(error)
            });
        }
        
        return Math.max(0, Math.min(1, score));
    }
    
    /**
     * Generate detailed scoring breakdown for analysis
     */
    getScoreBreakdown(candidate: TokenCandidate): {
        total: number;
        components: {
            nameQuality: number;
            creatorQuality: number;
            timing: number;
            market: number;
        };
    } {
        const nameQuality = this.assessTokenNameQuality(candidate.mint);
        const creatorQuality = creatorAnalyzer.assessCreatorQuality(candidate.creator);
        const timing = this.assessTimingFactors(candidate);
        const market = this.assessMarketConditions();
        
        const total = (nameQuality * 0.3) + (creatorQuality * 0.4) + (timing * 0.2) + (market * 0.1);
        
        return {
            total,
            components: {
                nameQuality,
                creatorQuality,
                timing,
                market
            }
        };
    }
}

// Singleton instance for global use
export const tokenScorer = new TokenScorer();