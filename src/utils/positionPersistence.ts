// src/utils/positionPersistence.ts
// Position persistence system for maintaining state across bot restarts

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { getTokenBalance } from './solana.js';

// Comprehensive position data structure for persistence
export interface PersistedPosition {
    // Basic position info
    mint: string;
    deployer?: string;
    
    // Trading data
    entryPrice: number;
    amountTokens: number;
    exposureSOL: number;
    acquisitionTime: number;
    
    // Auto-sell state
    peakRoi: number;
    scaleOutIndex: number;
    lastSellAt?: number;
    
    // Portfolio risk tracking
    lastUpdateTime: number;
    
    // Position status
    isActive: boolean;
    createdAt: number;
    updatedAt: number;
}

export interface DeployerExposureData {
    deployerAddress: string;
    totalExposure: number;
    tokenCount: number;
    tokens: string[];
    lastTradeTime: number;
}

export interface PortfolioRiskState {
    totalPortfolioValue: number;
    lastUpdate: number;
}

export interface PersistedState {
    version: string;
    lastSaved: number;
    positions: PersistedPosition[];
    deployerExposures: DeployerExposureData[];
    portfolioRiskState: PortfolioRiskState;
    metadata: {
        botVersion?: string;
        walletAddress?: string;
        totalPositionsCreated: number;
        lastCleanup: number;
    };
}

export interface PositionReconciliationResult {
    totalReconciled: number;
    positionsRestored: number;
    positionsRemoved: number;
    exposureAdjustments: number;
    warnings: string[];
    errors: string[];
}

class PositionPersistenceManager {
    private dataDir: string;
    private positionsFile: string;
    private backupDir: string;
    private isInitialized = false;
    private autoSaveInterval: NodeJS.Timeout | null = null;
    private currentState: PersistedState;

    constructor() {
        // Get project root directory
        const moduleDir = path.dirname(fileURLToPath(import.meta.url));
        const projectRoot = path.resolve(moduleDir, '../..');
        
        this.dataDir = path.join(projectRoot, 'data');
        this.positionsFile = path.join(this.dataDir, 'positions.json');
        this.backupDir = path.join(this.dataDir, 'backups');
        
        // Initialize empty state
        this.currentState = this.createEmptyState();
    }

    /**
     * Initialize the persistence manager
     */
    async initialize(): Promise<void> {
        try {
            // Ensure data directories exist
            if (!fs.existsSync(this.dataDir)) {
                fs.mkdirSync(this.dataDir, { recursive: true });
            }
            if (!fs.existsSync(this.backupDir)) {
                fs.mkdirSync(this.backupDir, { recursive: true });
            }

            // Load existing state if available
            await this.loadState();

            // Start auto-save timer (every 30 seconds)
            this.startAutoSave();

            this.isInitialized = true;
            logger.info('PERSISTENCE', '✅ Position persistence manager initialized', {
                positionsFile: this.positionsFile,
                activePositions: this.currentState.positions.filter(p => p.isActive).length,
                totalPositions: this.currentState.positions.length
            });

        } catch (error) {
            logger.error('PERSISTENCE', 'Failed to initialize position persistence', {
                error: (error as Error).message,
                stack: (error as Error).stack
            });
            throw error;
        }
    }

    /**
     * Save a new position
     */
    async savePosition(position: Omit<PersistedPosition, 'createdAt' | 'updatedAt' | 'isActive'>): Promise<void> {
        this.ensureInitialized();

        const now = Date.now();
        const persistedPosition: PersistedPosition = {
            ...position,
            isActive: true,
            createdAt: now,
            updatedAt: now
        };

        // Remove any existing position for this mint
        this.currentState.positions = this.currentState.positions.filter(p => p.mint !== position.mint);
        
        // Add new position
        this.currentState.positions.push(persistedPosition);
        this.currentState.metadata.totalPositionsCreated += 1;
        this.currentState.lastSaved = now;

        logger.info('PERSISTENCE', '💾 Position saved', {
            mint: position.mint.substring(0, 8) + '...',
            exposureSOL: position.exposureSOL,
            entryPrice: position.entryPrice,
            totalActivePositions: this.currentState.positions.filter(p => p.isActive).length
        });

        // Save immediately for critical position data
        await this.saveState();
    }

    /**
     * Update an existing position
     */
    async updatePosition(mint: string, updates: Partial<PersistedPosition>): Promise<void> {
        this.ensureInitialized();

        const positionIndex = this.currentState.positions.findIndex(p => p.mint === mint && p.isActive);
        if (positionIndex === -1) {
            logger.warn('PERSISTENCE', 'Attempted to update non-existent position', { mint });
            return;
        }

        // Update position with new data
        this.currentState.positions[positionIndex] = {
            ...this.currentState.positions[positionIndex],
            ...updates,
            updatedAt: Date.now()
        };

        this.currentState.lastSaved = Date.now();

        logger.debug('PERSISTENCE', '🔄 Position updated', {
            mint: mint.substring(0, 8) + '...',
            updates: Object.keys(updates)
        });
    }

    /**
     * Remove/close a position
     */
    async closePosition(mint: string): Promise<void> {
        this.ensureInitialized();

        const positionIndex = this.currentState.positions.findIndex(p => p.mint === mint && p.isActive);
        if (positionIndex === -1) {
            logger.warn('PERSISTENCE', 'Attempted to close non-existent position', { mint });
            return;
        }

        // Mark as inactive instead of deleting (for audit trail)
        this.currentState.positions[positionIndex].isActive = false;
        this.currentState.positions[positionIndex].updatedAt = Date.now();
        this.currentState.lastSaved = Date.now();

        logger.info('PERSISTENCE', '❌ Position closed', {
            mint: mint.substring(0, 8) + '...',
            remainingActivePositions: this.currentState.positions.filter(p => p.isActive).length
        });

        await this.saveState();
    }

    /**
     * Save deployer exposure state
     */
    async saveDeployerExposures(exposures: Map<string, any>): Promise<void> {
        this.ensureInitialized();

        this.currentState.deployerExposures = Array.from(exposures.entries()).map(([address, data]) => ({
            deployerAddress: address,
            totalExposure: data.totalExposure,
            tokenCount: data.tokenCount,
            tokens: data.tokens,
            lastTradeTime: data.lastTradeTime
        }));

        this.currentState.lastSaved = Date.now();
        logger.debug('PERSISTENCE', '💾 Deployer exposures saved', {
            deployerCount: this.currentState.deployerExposures.length
        });
    }

    /**
     * Save portfolio risk state
     */
    async savePortfolioRiskState(portfolioState: { totalPortfolioValue: number }): Promise<void> {
        this.ensureInitialized();

        this.currentState.portfolioRiskState = {
            totalPortfolioValue: portfolioState.totalPortfolioValue,
            lastUpdate: Date.now()
        };

        this.currentState.lastSaved = Date.now();
        logger.debug('PERSISTENCE', '💾 Portfolio risk state saved', {
            totalValue: portfolioState.totalPortfolioValue.toFixed(4)
        });
    }

    /**
     * Get all active positions
     */
    getActivePositions(): PersistedPosition[] {
        this.ensureInitialized();
        return this.currentState.positions.filter(p => p.isActive);
    }

    /**
     * Get position by mint
     */
    getPosition(mint: string): PersistedPosition | null {
        this.ensureInitialized();
        return this.currentState.positions.find(p => p.mint === mint && p.isActive) || null;
    }

    /**
     * Get all deployer exposures
     */
    getDeployerExposures(): DeployerExposureData[] {
        this.ensureInitialized();
        return this.currentState.deployerExposures;
    }

    /**
     * Get portfolio risk state
     */
    getPortfolioRiskState(): PortfolioRiskState {
        this.ensureInitialized();
        return this.currentState.portfolioRiskState;
    }

    /**
     * Reconcile positions with actual wallet balances
     */
    async reconcilePositions(connection: Connection, walletPubkey: PublicKey): Promise<PositionReconciliationResult> {
        this.ensureInitialized();
        
        const result: PositionReconciliationResult = {
            totalReconciled: 0,
            positionsRestored: 0,
            positionsRemoved: 0,
            exposureAdjustments: 0,
            warnings: [],
            errors: []
        };

        logger.info('PERSISTENCE', '🔍 Starting position reconciliation with wallet state');

        const activePositions = this.getActivePositions();
        
        for (const position of activePositions) {
            try {
                result.totalReconciled++;
                
                // Get actual token balance from wallet
                const mintPubkey = new PublicKey(position.mint);
                const actualBalance = await getTokenBalance(mintPubkey, walletPubkey);
                
                logger.debug('PERSISTENCE', `Reconciling ${position.mint.substring(0, 8)}...`, {
                    storedBalance: position.amountTokens,
                    actualBalance,
                    exposureSOL: position.exposureSOL
                });

                // Handle different reconciliation scenarios
                if (actualBalance === 0) {
                    // Position was sold while bot was offline
                    await this.closePosition(position.mint);
                    result.positionsRemoved++;
                    result.warnings.push(`Position ${position.mint.substring(0, 8)}... was sold while offline`);
                    
                } else if (Math.abs(actualBalance - position.amountTokens) > 0.000001) {
                    // Balance mismatch - adjust stored amount
                    const oldAmount = position.amountTokens;
                    await this.updatePosition(position.mint, {
                        amountTokens: actualBalance,
                        exposureSOL: position.exposureSOL * (actualBalance / oldAmount), // Proportional adjustment
                        lastUpdateTime: Date.now()
                    });
                    result.exposureAdjustments++;
                    result.warnings.push(`Adjusted ${position.mint.substring(0, 8)}... balance: ${oldAmount} → ${actualBalance}`);
                    
                } else {
                    // Position matches - mark as restored
                    result.positionsRestored++;
                }

            } catch (error) {
                result.errors.push(`Failed to reconcile ${position.mint}: ${(error as Error).message}`);
                logger.error('PERSISTENCE', 'Position reconciliation error', {
                    mint: position.mint,
                    error: (error as Error).message
                });
            }
        }

        logger.info('PERSISTENCE', '✅ Position reconciliation completed', {
            totalChecked: result.totalReconciled,
            restored: result.positionsRestored,
            removed: result.positionsRemoved,
            adjusted: result.exposureAdjustments,
            warnings: result.warnings.length,
            errors: result.errors.length
        });

        return result;
    }

    /**
     * Create backup of current state
     */
    async createBackup(): Promise<string> {
        this.ensureInitialized();
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = path.join(this.backupDir, `positions-backup-${timestamp}.json`);
        
        try {
            await fs.promises.writeFile(backupFile, JSON.stringify(this.currentState, null, 2));
            logger.info('PERSISTENCE', '💾 Position backup created', { backupFile });
            return backupFile;
        } catch (error) {
            logger.error('PERSISTENCE', 'Failed to create backup', {
                error: (error as Error).message,
                backupFile
            });
            throw error;
        }
    }

    /**
     * Clean up old inactive positions and backups
     */
    async cleanup(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
        this.ensureInitialized();
        
        const cutoffTime = Date.now() - maxAgeMs;
        const initialCount = this.currentState.positions.length;
        
        // Remove old inactive positions
        this.currentState.positions = this.currentState.positions.filter(p => {
            if (!p.isActive && p.updatedAt < cutoffTime) {
                return false; // Remove old inactive position
            }
            return true; // Keep position
        });
        
        const removedCount = initialCount - this.currentState.positions.length;
        
        // Clean up old backup files
        try {
            const backupFiles = await fs.promises.readdir(this.backupDir);
            let backupsRemoved = 0;
            
            for (const file of backupFiles) {
                const filePath = path.join(this.backupDir, file);
                const stats = await fs.promises.stat(filePath);
                
                if (stats.mtime.getTime() < cutoffTime) {
                    await fs.promises.unlink(filePath);
                    backupsRemoved++;
                }
            }
            
            logger.info('PERSISTENCE', '🧹 Cleanup completed', {
                positionsRemoved: removedCount,
                backupsRemoved,
                remainingPositions: this.currentState.positions.length
            });
            
        } catch (error) {
            logger.warn('PERSISTENCE', 'Backup cleanup failed', {
                error: (error as Error).message
            });
        }
        
        this.currentState.metadata.lastCleanup = Date.now();
        await this.saveState();
        
        return removedCount;
    }

    /**
     * Get persistence statistics for monitoring
     */
    getStatistics(): object {
        this.ensureInitialized();
        
        const activePositions = this.currentState.positions.filter(p => p.isActive);
        const totalExposure = activePositions.reduce((sum, p) => sum + p.exposureSOL, 0);
        
        return {
            totalPositions: this.currentState.positions.length,
            activePositions: activePositions.length,
            inactivePositions: this.currentState.positions.length - activePositions.length,
            totalExposureSOL: totalExposure.toFixed(4),
            deployerCount: this.currentState.deployerExposures.length,
            portfolioValue: this.currentState.portfolioRiskState.totalPortfolioValue.toFixed(4),
            lastSaved: new Date(this.currentState.lastSaved).toISOString(),
            dataFile: this.positionsFile,
            totalCreated: this.currentState.metadata.totalPositionsCreated
        };
    }

    /**
     * Shutdown and cleanup
     */
    async shutdown(): Promise<void> {
        if (this.autoSaveInterval) {
            clearInterval(this.autoSaveInterval);
            this.autoSaveInterval = null;
        }
        
        if (this.isInitialized) {
            await this.saveState();
            logger.info('PERSISTENCE', '🔄 Position persistence manager shutdown completed');
        }
    }

    // Private methods

    private createEmptyState(): PersistedState {
        return {
            version: '1.0.0',
            lastSaved: Date.now(),
            positions: [],
            deployerExposures: [],
            portfolioRiskState: {
                totalPortfolioValue: 0,
                lastUpdate: Date.now()
            },
            metadata: {
                totalPositionsCreated: 0,
                lastCleanup: Date.now()
            }
        };
    }

    private async loadState(): Promise<void> {
        try {
            if (!fs.existsSync(this.positionsFile)) {
                logger.info('PERSISTENCE', 'No existing positions file found, starting with empty state');
                this.currentState = this.createEmptyState();
                return;
            }

            const data = await fs.promises.readFile(this.positionsFile, 'utf-8');
            const parsed = JSON.parse(data) as PersistedState;
            
            // Validate and migrate if necessary
            this.currentState = this.validateAndMigrateState(parsed);
            
            logger.info('PERSISTENCE', '📖 Position state loaded', {
                totalPositions: this.currentState.positions.length,
                activePositions: this.currentState.positions.filter(p => p.isActive).length,
                version: this.currentState.version,
                lastSaved: new Date(this.currentState.lastSaved).toISOString()
            });

        } catch (error) {
            logger.error('PERSISTENCE', 'Failed to load position state', {
                error: (error as Error).message,
                file: this.positionsFile
            });
            
            // Create backup of corrupted file and start fresh
            if (fs.existsSync(this.positionsFile)) {
                const corruptedBackup = this.positionsFile + `.corrupted.${Date.now()}`;
                fs.renameSync(this.positionsFile, corruptedBackup);
                logger.warn('PERSISTENCE', 'Corrupted file backed up, starting fresh', { corruptedBackup });
            }
            
            this.currentState = this.createEmptyState();
        }
    }

    private async saveState(): Promise<void> {
        try {
            this.currentState.lastSaved = Date.now();
            const data = JSON.stringify(this.currentState, null, 2);
            
            // Atomic write using temporary file
            const tempFile = this.positionsFile + '.tmp';
            await fs.promises.writeFile(tempFile, data);
            await fs.promises.rename(tempFile, this.positionsFile);
            
            logger.debug('PERSISTENCE', '💾 State saved to disk', {
                activePositions: this.currentState.positions.filter(p => p.isActive).length,
                file: this.positionsFile
            });

        } catch (error) {
            logger.error('PERSISTENCE', 'Failed to save position state', {
                error: (error as Error).message,
                file: this.positionsFile
            });
            throw error;
        }
    }

    private validateAndMigrateState(state: any): PersistedState {
        // Basic validation and migration logic
        if (!state.version) {
            logger.warn('PERSISTENCE', 'Missing version in state file, applying migration');
            state.version = '1.0.0';
        }

        if (!state.metadata) {
            state.metadata = {
                totalPositionsCreated: state.positions?.length || 0,
                lastCleanup: Date.now()
            };
        }

        if (!state.portfolioRiskState) {
            state.portfolioRiskState = {
                totalPortfolioValue: 0,
                lastUpdate: Date.now()
            };
        }

        if (!Array.isArray(state.positions)) {
            state.positions = [];
        }

        if (!Array.isArray(state.deployerExposures)) {
            state.deployerExposures = [];
        }

        return state as PersistedState;
    }

    private startAutoSave(): void {
        // Auto-save every 30 seconds
        this.autoSaveInterval = setInterval(async () => {
            try {
                await this.saveState();
            } catch (error) {
                logger.error('PERSISTENCE', 'Auto-save failed', {
                    error: (error as Error).message
                });
            }
        }, 30000);

        logger.info('PERSISTENCE', '⏰ Auto-save started (30s interval)');
    }

    private ensureInitialized(): void {
        if (!this.isInitialized) {
            throw new Error('Position persistence manager not initialized. Call initialize() first.');
        }
    }
}

// Singleton instance
export const positionPersistence = new PositionPersistenceManager();

export default positionPersistence;