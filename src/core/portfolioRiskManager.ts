// src/core/portfolioRiskManager.ts
// Enhanced portfolio-level risk management with deployer and token concentration controls

import { Connection, PublicKey } from "@solana/web3.js";
import { loadBotConfig, BotConfig } from "../config/index.js";
import logger from "../utils/logger.js";
import positionPersistence from "../utils/positionPersistence.js";

export interface DeployerExposure {
    deployerAddress: string;
    totalExposure: number;
    tokenCount: number;
    tokens: string[];
    lastTradeTime: number;
}

export interface TokenPosition {
    mint: string;
    deployer?: string;
    exposure: number;
    acquisitionTime: number;
    lastUpdateTime: number;
}

export interface PortfolioRiskResult {
    allowed: boolean;
    reason?: string;
    maxAllowedAmount?: number;
    currentDeployerExposure?: number;
    currentTokenConcentration?: number;
    deployerTokenCount?: number;
    cooldownRemaining?: number;
}

export interface PortfolioRiskState {
    totalPortfolioValue: number;
    deployerExposures: Map<string, DeployerExposure>;
    tokenPositions: Map<string, TokenPosition>;
    lastUpdate: number;
}

class PortfolioRiskManager {
    private config: BotConfig;
    private state: PortfolioRiskState = {
        totalPortfolioValue: 0,
        deployerExposures: new Map(),
        tokenPositions: new Map(),
        lastUpdate: 0
    };

    constructor() {
        this.config = loadBotConfig();
    }

    /**
     * Check if a new position is allowed based on portfolio-level risk controls
     */
    async checkPortfolioRisk({
        mint,
        deployer,
        requestedAmount,
        connection,
        walletPubkey
    }: {
        mint: string;
        deployer?: string;
        requestedAmount: number;
        connection: Connection;
        walletPubkey: PublicKey;
    }): Promise<PortfolioRiskResult> {
        try {
            // Update portfolio state
            await this.updatePortfolioState(connection, walletPubkey);

            // Skip checks if deployer not provided
            if (!deployer) {
                logger.warn('PORTFOLIO', 'No deployer provided for risk check', { mint });
                return { allowed: true };
            }

            // Check deployer exposure limits
            const deployerCheck = this.checkDeployerExposure(deployer, requestedAmount);
            if (!deployerCheck.allowed) {
                return deployerCheck;
            }

            // Check deployer token count limits
            const deployerTokenCheck = this.checkDeployerTokenCount(deployer, mint);
            if (!deployerTokenCheck.allowed) {
                return deployerTokenCheck;
            }

            // Check deployer cooldown
            const deployerCooldownCheck = this.checkDeployerCooldown(deployer);
            if (!deployerCooldownCheck.allowed) {
                return deployerCooldownCheck;
            }

            // Check token concentration limits
            const concentrationCheck = this.checkTokenConcentration(mint, requestedAmount);
            if (!concentrationCheck.allowed) {
                return concentrationCheck;
            }

            // Log successful risk check
            logger.info('PORTFOLIO', `✅ Portfolio risk check passed`, {
                mint,
                deployer,
                requestedAmount,
                deployerExposure: this.state.deployerExposures.get(deployer)?.totalExposure || 0,
                deployerTokenCount: this.state.deployerExposures.get(deployer)?.tokenCount || 0
            });

            return { allowed: true };

        } catch (error) {
            logger.error('PORTFOLIO', 'Portfolio risk check failed', {
                mint,
                deployer,
                requestedAmount,
                error: (error as Error).message
            });
            return {
                allowed: false,
                reason: `Portfolio risk check error: ${(error as Error).message}`
            };
        }
    }

    /**
     * Restore portfolio state from persistence
     */
    async restoreFromPersistence(): Promise<void> {
        try {
            // Restore positions
            const persistedPositions = positionPersistence.getActivePositions();
            this.state.tokenPositions.clear();
            this.state.totalPortfolioValue = 0;
            
            for (const pos of persistedPositions) {
                this.state.tokenPositions.set(pos.mint, {
                    mint: pos.mint,
                    deployer: pos.deployer,
                    exposure: pos.exposureSOL,
                    acquisitionTime: pos.acquisitionTime,
                    lastUpdateTime: pos.lastUpdateTime
                });
                this.state.totalPortfolioValue += pos.exposureSOL;
            }
            
            // Restore deployer exposures
            const deployerExposures = positionPersistence.getDeployerExposures();
            this.state.deployerExposures.clear();
            
            for (const exp of deployerExposures) {
                this.state.deployerExposures.set(exp.deployerAddress, {
                    deployerAddress: exp.deployerAddress,
                    totalExposure: exp.totalExposure,
                    tokenCount: exp.tokenCount,
                    tokens: exp.tokens,
                    lastTradeTime: exp.lastTradeTime
                });
            }
            
            // Restore portfolio risk state
            const portfolioState = positionPersistence.getPortfolioRiskState();
            this.state.totalPortfolioValue = portfolioState.totalPortfolioValue;
            this.state.lastUpdate = portfolioState.lastUpdate;
            
            logger.info('PORTFOLIO', '🔄 Portfolio state restored from persistence', {
                tokenPositions: this.state.tokenPositions.size,
                deployerExposures: this.state.deployerExposures.size,
                totalValue: this.state.totalPortfolioValue.toFixed(4)
            });
            
        } catch (error) {
            logger.error('PORTFOLIO', 'Failed to restore portfolio state from persistence', {
                error: (error as Error).message
            });
            throw error;
        }
    }

    /**
     * Record a new position in the portfolio tracking system
     */
    recordPosition(mint: string, deployer: string | undefined, exposure: number): void {
        const now = Date.now();

        // Update token position
        this.state.tokenPositions.set(mint, {
            mint,
            deployer,
            exposure,
            acquisitionTime: now,
            lastUpdateTime: now
        });

        // Update deployer exposure if deployer provided
        if (deployer) {
            const existing = this.state.deployerExposures.get(deployer) || {
                deployerAddress: deployer,
                totalExposure: 0,
                tokenCount: 0,
                tokens: [],
                lastTradeTime: 0
            };

            existing.totalExposure += exposure;
            existing.tokenCount += 1;
            existing.tokens.push(mint);
            existing.lastTradeTime = now;

            this.state.deployerExposures.set(deployer, existing);

            logger.info('PORTFOLIO', `📊 Position recorded`, {
                mint,
                deployer,
                exposure,
                deployerTotalExposure: existing.totalExposure,
                deployerTokenCount: existing.tokenCount
            });
        }

        this.state.totalPortfolioValue += exposure;
        
        // Save to persistence
        positionPersistence.saveDeployerExposures(this.state.deployerExposures);
        positionPersistence.savePortfolioRiskState({ totalPortfolioValue: this.state.totalPortfolioValue });
    }

    /**
     * Remove a position from portfolio tracking (on sell)
     */
    removePosition(mint: string, deployer?: string): void {
        const position = this.state.tokenPositions.get(mint);
        if (!position) {
            logger.warn('PORTFOLIO', 'Attempted to remove non-existent position', { mint });
            return;
        }

        // Remove from token positions
        this.state.tokenPositions.delete(mint);
        this.state.totalPortfolioValue -= position.exposure;

        // Update deployer exposure
        if (deployer && this.state.deployerExposures.has(deployer)) {
            const deployerExp = this.state.deployerExposures.get(deployer)!;
            deployerExp.totalExposure -= position.exposure;
            deployerExp.tokenCount -= 1;
            deployerExp.tokens = deployerExp.tokens.filter(token => token !== mint);

            // Remove deployer entry if no tokens left
            if (deployerExp.tokenCount <= 0) {
                this.state.deployerExposures.delete(deployer);
                logger.info('PORTFOLIO', '🗑️ Deployer removed from tracking', { deployer });
            } else {
                this.state.deployerExposures.set(deployer, deployerExp);
            }
        }

        logger.info('PORTFOLIO', `📉 Position removed`, {
            mint,
            deployer,
            exposure: position.exposure,
            remainingPositions: this.state.tokenPositions.size
        });
        
        // Save to persistence
        positionPersistence.saveDeployerExposures(this.state.deployerExposures);
        positionPersistence.savePortfolioRiskState({ totalPortfolioValue: this.state.totalPortfolioValue });
    }

    /**
     * Update position exposure (on partial sells or value changes)
     */
    updatePositionExposure(mint: string, newExposure: number): void {
        const position = this.state.tokenPositions.get(mint);
        if (!position) {
            logger.warn('PORTFOLIO', 'Attempted to update non-existent position', { mint });
            return;
        }

        const exposureDelta = newExposure - position.exposure;
        position.exposure = newExposure;
        position.lastUpdateTime = Date.now();

        // Update portfolio total
        this.state.totalPortfolioValue += exposureDelta;

        // Update deployer exposure if applicable
        if (position.deployer && this.state.deployerExposures.has(position.deployer)) {
            const deployerExp = this.state.deployerExposures.get(position.deployer)!;
            deployerExp.totalExposure += exposureDelta;
            this.state.deployerExposures.set(position.deployer, deployerExp);
        }

        logger.debug('PORTFOLIO', `📊 Position exposure updated`, {
            mint,
            oldExposure: position.exposure - exposureDelta,
            newExposure,
            exposureDelta
        });
    }

    /**
     * Check deployer exposure limits
     */
    private checkDeployerExposure(deployer: string, requestedAmount: number): PortfolioRiskResult {
        const maxDeployerExposure = this.config.maxDeployerExposure || Infinity;
        const currentExposure = this.state.deployerExposures.get(deployer)?.totalExposure || 0;
        const newTotalExposure = currentExposure + requestedAmount;

        if (newTotalExposure > maxDeployerExposure) {
            const availableAmount = Math.max(0, maxDeployerExposure - currentExposure);
            return {
                allowed: false,
                reason: `Deployer exposure limit exceeded (${newTotalExposure.toFixed(4)}/${maxDeployerExposure} SOL)`,
                maxAllowedAmount: availableAmount,
                currentDeployerExposure: currentExposure
            };
        }

        return { allowed: true };
    }

    /**
     * Check deployer token count limits
     */
    private checkDeployerTokenCount(deployer: string, mint: string): PortfolioRiskResult {
        const maxDeployerTokens = this.config.maxDeployerTokens || Infinity;
        const deployerExp = this.state.deployerExposures.get(deployer);
        const currentTokenCount = deployerExp?.tokenCount || 0;

        // If we already hold this token from this deployer, allow the trade
        if (deployerExp?.tokens.includes(mint)) {
            return { allowed: true };
        }

        if (currentTokenCount >= maxDeployerTokens) {
            return {
                allowed: false,
                reason: `Deployer token limit reached (${currentTokenCount}/${maxDeployerTokens} tokens)`,
                deployerTokenCount: currentTokenCount
            };
        }

        return { allowed: true };
    }

    /**
     * Check deployer cooldown period
     */
    private checkDeployerCooldown(deployer: string): PortfolioRiskResult {
        const deployerCooldownMs = this.config.deployerCooldownMs || 0;
        const deployerExp = this.state.deployerExposures.get(deployer);

        if (deployerExp && deployerCooldownMs > 0) {
            const timeSinceLastTrade = Date.now() - deployerExp.lastTradeTime;
            
            if (timeSinceLastTrade < deployerCooldownMs) {
                const cooldownRemaining = deployerCooldownMs - timeSinceLastTrade;
                return {
                    allowed: false,
                    reason: `Deployer cooldown active (${Math.round(cooldownRemaining / 1000)}s remaining)`,
                    cooldownRemaining
                };
            }
        }

        return { allowed: true };
    }

    /**
     * Check token concentration limits
     */
    private checkTokenConcentration(mint: string, requestedAmount: number): PortfolioRiskResult {
        const maxTokenConcentration = this.config.maxTokenConcentration || 1.0;
        const currentPosition = this.state.tokenPositions.get(mint);
        const currentExposure = currentPosition?.exposure || 0;
        const newTotalExposure = currentExposure + requestedAmount;
        
        if (this.state.totalPortfolioValue <= 0) {
            return { allowed: true }; // No existing portfolio to check against
        }

        const newConcentration = newTotalExposure / (this.state.totalPortfolioValue + requestedAmount);

        if (newConcentration > maxTokenConcentration) {
            const maxAllowedExposure = (this.state.totalPortfolioValue + requestedAmount) * maxTokenConcentration;
            const availableAmount = Math.max(0, maxAllowedExposure - currentExposure);
            
            return {
                allowed: false,
                reason: `Token concentration limit exceeded (${(newConcentration * 100).toFixed(1)}%/${(maxTokenConcentration * 100).toFixed(1)}%)`,
                maxAllowedAmount: availableAmount,
                currentTokenConcentration: newConcentration
            };
        }

        // Warning for approaching concentration threshold
        const concentrationThreshold = this.config.concentrationThreshold || 0.15;
        if (newConcentration > concentrationThreshold) {
            logger.warn('PORTFOLIO', `⚠️ High token concentration approaching`, {
                mint,
                concentration: `${(newConcentration * 100).toFixed(1)}%`,
                threshold: `${(concentrationThreshold * 100).toFixed(1)}%`,
                limit: `${(maxTokenConcentration * 100).toFixed(1)}%`
            });
        }

        return { allowed: true };
    }

    /**
     * Update portfolio state periodically
     */
    private async updatePortfolioState(connection: Connection, walletPubkey: PublicKey): Promise<void> {
        const now = Date.now();
        
        // Only update every 30 seconds to avoid excessive RPC calls
        if (now - this.state.lastUpdate < 30000) {
            return;
        }

        try {
            // In a full implementation, this would:
            // 1. Fetch actual token balances from wallet
            // 2. Update position values based on current prices
            // 3. Clean up stale positions
            
            // For now, we just update the timestamp
            this.state.lastUpdate = now;

            logger.debug('PORTFOLIO', '🔄 Portfolio state updated', {
                totalValue: this.state.totalPortfolioValue.toFixed(4),
                deployerCount: this.state.deployerExposures.size,
                positionCount: this.state.tokenPositions.size
            });

        } catch (error) {
            logger.warn('PORTFOLIO', 'Failed to update portfolio state', {
                error: (error as Error).message
            });
        }
    }

    /**
     * Get portfolio risk summary for monitoring
     */
    getPortfolioSummary(): object {
        const deployerSummary = Array.from(this.state.deployerExposures.entries()).map(([address, exp]) => ({
            deployer: address.slice(0, 8) + '...',
            exposure: exp.totalExposure.toFixed(4),
            tokenCount: exp.tokenCount,
            lastTrade: new Date(exp.lastTradeTime).toISOString()
        }));

        const tokenSummary = Array.from(this.state.tokenPositions.entries()).map(([mint, pos]) => ({
            token: mint.slice(0, 8) + '...',
            exposure: pos.exposure.toFixed(4),
            deployer: pos.deployer?.slice(0, 8) + '...' || 'unknown',
            concentration: this.state.totalPortfolioValue > 0 
                ? `${((pos.exposure / this.state.totalPortfolioValue) * 100).toFixed(1)}%` 
                : '0%'
        }));

        return {
            totalPortfolioValue: this.state.totalPortfolioValue.toFixed(4),
            deployerCount: this.state.deployerExposures.size,
            positionCount: this.state.tokenPositions.size,
            limits: {
                maxDeployerExposure: this.config.maxDeployerExposure || 'unlimited',
                maxTokenConcentration: `${((this.config.maxTokenConcentration || 1.0) * 100).toFixed(1)}%`,
                maxDeployerTokens: this.config.maxDeployerTokens || 'unlimited',
                deployerCooldown: `${(this.config.deployerCooldownMs || 0) / 1000}s`
            },
            deployers: deployerSummary.slice(0, 5), // Top 5 deployers
            tokens: tokenSummary.slice(0, 5) // Top 5 positions
        };
    }

    /**
     * Get detailed deployer analysis
     */
    getDeployerAnalysis(deployer: string): object | null {
        const exp = this.state.deployerExposures.get(deployer);
        if (!exp) return null;

        return {
            deployerAddress: deployer,
            totalExposure: exp.totalExposure.toFixed(4),
            tokenCount: exp.tokenCount,
            tokens: exp.tokens,
            lastTradeTime: new Date(exp.lastTradeTime).toISOString(),
            utilizationPercent: ((exp.totalExposure / (this.config.maxDeployerExposure || 1)) * 100).toFixed(1)
        };
    }

    /**
     * Get concentration warnings for monitoring
     */
    getConcentrationWarnings(): Array<{token: string, concentration: number, warning: string}> {
        const warnings: Array<{token: string, concentration: number, warning: string}> = [];
        const concentrationThreshold = this.config.concentrationThreshold || 0.15;
        const maxConcentration = this.config.maxTokenConcentration || 0.25;

        if (this.state.totalPortfolioValue <= 0) return warnings;

        for (const [mint, position] of this.state.tokenPositions) {
            const concentration = position.exposure / this.state.totalPortfolioValue;
            
            if (concentration >= maxConcentration * 0.9) { // 90% of max limit
                warnings.push({
                    token: mint,
                    concentration,
                    warning: `Near concentration limit (${(concentration * 100).toFixed(1)}%)`
                });
            } else if (concentration >= concentrationThreshold) {
                warnings.push({
                    token: mint,
                    concentration,
                    warning: `Above concentration threshold (${(concentration * 100).toFixed(1)}%)`
                });
            }
        }

        return warnings.sort((a, b) => b.concentration - a.concentration);
    }

    /**
     * Clean up stale positions (for maintenance)
     */
    cleanupStalePositions(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
        const now = Date.now();
        let removedCount = 0;

        for (const [mint, position] of this.state.tokenPositions) {
            if (now - position.lastUpdateTime > maxAgeMs) {
                this.removePosition(mint, position.deployer);
                removedCount++;
            }
        }

        if (removedCount > 0) {
            logger.info('PORTFOLIO', `🧹 Cleaned up ${removedCount} stale positions`);
        }

        return removedCount;
    }
}

// Singleton instance
export const portfolioRiskManager = new PortfolioRiskManager();

export default portfolioRiskManager;