// test/portfolioRiskManager.test.ts
// Unit tests for portfolio-level risk management

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Connection, PublicKey } from '@solana/web3.js';
import { portfolioRiskManager } from '../src/core/portfolioRiskManager.js';

// Mock dependencies
jest.mock('../src/config/index.js', () => ({
    loadBotConfig: jest.fn(() => ({
        maxDeployerExposure: 0.1,
        maxTokenConcentration: 0.25,
        maxDeployerTokens: 3,
        deployerCooldownMs: 300000, // 5 minutes
        concentrationThreshold: 0.15
    }))
}));

jest.mock('../src/utils/logger.js', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

describe('PortfolioRiskManager', () => {
    const mockConnection = {} as Connection;
    const mockWalletPubkey = new PublicKey('11111111111111111111111111111111');
    const mockDeployer = 'DEPLOYERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const mockMint1 = 'MINTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const mockMint2 = 'MINT2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

    beforeEach(() => {
        // Reset the portfolio state before each test
        (portfolioRiskManager as any).state = {
            totalPortfolioValue: 0,
            deployerExposures: new Map(),
            tokenPositions: new Map(),
            lastUpdate: 0
        };
    });

    describe('checkPortfolioRisk', () => {
        it('should allow first position from deployer', async () => {
            const result = await portfolioRiskManager.checkPortfolioRisk({
                mint: mockMint1,
                deployer: mockDeployer,
                requestedAmount: 0.05,
                connection: mockConnection,
                walletPubkey: mockWalletPubkey
            });

            expect(result.allowed).toBe(true);
            expect(result.reason).toBeUndefined();
        });

        it('should reject position exceeding deployer exposure limit', async () => {
            // Add existing exposure near limit
            portfolioRiskManager.recordPosition(mockMint1, mockDeployer, 0.08);

            const result = await portfolioRiskManager.checkPortfolioRisk({
                mint: mockMint2,
                deployer: mockDeployer,
                requestedAmount: 0.05, // Would exceed 0.1 limit
                connection: mockConnection,
                walletPubkey: mockWalletPubkey
            });

            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Deployer exposure limit exceeded');
            expect(result.currentDeployerExposure).toBe(0.08);
            expect(result.maxAllowedAmount).toBe(0.02);
        });

        it('should reject position exceeding deployer token count limit', async () => {
            // Add 3 tokens from same deployer (at limit)
            portfolioRiskManager.recordPosition('MINT1', mockDeployer, 0.02);
            portfolioRiskManager.recordPosition('MINT2', mockDeployer, 0.02);
            portfolioRiskManager.recordPosition('MINT3', mockDeployer, 0.02);

            const result = await portfolioRiskManager.checkPortfolioRisk({
                mint: 'MINT4',
                deployer: mockDeployer,
                requestedAmount: 0.02,
                connection: mockConnection,
                walletPubkey: mockWalletPubkey
            });

            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Deployer token limit reached');
            expect(result.deployerTokenCount).toBe(3);
        });

        it('should allow additional purchase of existing token from deployer', async () => {
            // Record initial position
            portfolioRiskManager.recordPosition(mockMint1, mockDeployer, 0.05);

            // Should allow buying more of the same token
            const result = await portfolioRiskManager.checkPortfolioRisk({
                mint: mockMint1, // Same token
                deployer: mockDeployer,
                requestedAmount: 0.02,
                connection: mockConnection,
                walletPubkey: mockWalletPubkey
            });

            expect(result.allowed).toBe(true);
        });

        it('should reject position during deployer cooldown', async () => {
            // Record recent position
            portfolioRiskManager.recordPosition(mockMint1, mockDeployer, 0.05);

            const result = await portfolioRiskManager.checkPortfolioRisk({
                mint: mockMint2,
                deployer: mockDeployer,
                requestedAmount: 0.02,
                connection: mockConnection,
                walletPubkey: mockWalletPubkey
            });

            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Deployer cooldown active');
            expect(result.cooldownRemaining).toBeGreaterThan(0);
        });

        it('should reject position exceeding token concentration limit', async () => {
            // Build portfolio to test concentration
            portfolioRiskManager.recordPosition('OTHER1', 'OTHER_DEPLOYER1', 0.1);
            portfolioRiskManager.recordPosition('OTHER2', 'OTHER_DEPLOYER2', 0.1);
            // Total portfolio: 0.2, requesting 0.08 more = 0.28 total
            // New token would be 0.08/0.28 = 28.6% > 25% limit

            const result = await portfolioRiskManager.checkPortfolioRisk({
                mint: mockMint1,
                deployer: mockDeployer,
                requestedAmount: 0.08,
                connection: mockConnection,
                walletPubkey: mockWalletPubkey
            });

            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Token concentration limit exceeded');
            expect(result.currentTokenConcentration).toBeGreaterThan(0.25);
        });

        it('should allow position within concentration limits', async () => {
            // Build portfolio
            portfolioRiskManager.recordPosition('OTHER1', 'OTHER_DEPLOYER1', 0.1);
            portfolioRiskManager.recordPosition('OTHER2', 'OTHER_DEPLOYER2', 0.1);
            // Total portfolio: 0.2, requesting 0.04 more = 0.24 total
            // New token would be 0.04/0.24 = 16.7% < 25% limit

            const result = await portfolioRiskManager.checkPortfolioRisk({
                mint: mockMint1,
                deployer: mockDeployer,
                requestedAmount: 0.04,
                connection: mockConnection,
                walletPubkey: mockWalletPubkey
            });

            expect(result.allowed).toBe(true);
        });

        it('should handle missing deployer gracefully', async () => {
            const result = await portfolioRiskManager.checkPortfolioRisk({
                mint: mockMint1,
                deployer: undefined,
                requestedAmount: 0.05,
                connection: mockConnection,
                walletPubkey: mockWalletPubkey
            });

            expect(result.allowed).toBe(true);
        });
    });

    describe('recordPosition', () => {
        it('should record new position correctly', () => {
            portfolioRiskManager.recordPosition(mockMint1, mockDeployer, 0.05);

            const summary = portfolioRiskManager.getPortfolioSummary() as any;
            expect(summary.totalPortfolioValue).toBe('0.0500');
            expect(summary.deployerCount).toBe(1);
            expect(summary.positionCount).toBe(1);
        });

        it('should update deployer exposure with multiple positions', () => {
            portfolioRiskManager.recordPosition(mockMint1, mockDeployer, 0.03);
            portfolioRiskManager.recordPosition(mockMint2, mockDeployer, 0.04);

            const deployerAnalysis = portfolioRiskManager.getDeployerAnalysis(mockDeployer);
            expect(deployerAnalysis).toBeTruthy();
            expect((deployerAnalysis as any).totalExposure).toBe('0.0700');
            expect((deployerAnalysis as any).tokenCount).toBe(2);
        });

        it('should handle position without deployer', () => {
            portfolioRiskManager.recordPosition(mockMint1, undefined, 0.05);

            const summary = portfolioRiskManager.getPortfolioSummary() as any;
            expect(summary.totalPortfolioValue).toBe('0.0500');
            expect(summary.deployerCount).toBe(0);
            expect(summary.positionCount).toBe(1);
        });
    });

    describe('removePosition', () => {
        beforeEach(() => {
            portfolioRiskManager.recordPosition(mockMint1, mockDeployer, 0.05);
            portfolioRiskManager.recordPosition(mockMint2, mockDeployer, 0.03);
        });

        it('should remove position and update deployer exposure', () => {
            portfolioRiskManager.removePosition(mockMint1, mockDeployer);

            const summary = portfolioRiskManager.getPortfolioSummary() as any;
            expect(summary.totalPortfolioValue).toBe('0.0300');
            expect(summary.positionCount).toBe(1);

            const deployerAnalysis = portfolioRiskManager.getDeployerAnalysis(mockDeployer);
            expect((deployerAnalysis as any).totalExposure).toBe('0.0300');
            expect((deployerAnalysis as any).tokenCount).toBe(1);
        });

        it('should remove deployer when all positions sold', () => {
            portfolioRiskManager.removePosition(mockMint1, mockDeployer);
            portfolioRiskManager.removePosition(mockMint2, mockDeployer);

            const summary = portfolioRiskManager.getPortfolioSummary() as any;
            expect(summary.deployerCount).toBe(0);
            expect(summary.positionCount).toBe(0);
            
            const deployerAnalysis = portfolioRiskManager.getDeployerAnalysis(mockDeployer);
            expect(deployerAnalysis).toBeNull();
        });

        it('should handle removing non-existent position', () => {
            expect(() => {
                portfolioRiskManager.removePosition('NON_EXISTENT', mockDeployer);
            }).not.toThrow();
        });
    });

    describe('updatePositionExposure', () => {
        beforeEach(() => {
            portfolioRiskManager.recordPosition(mockMint1, mockDeployer, 0.05);
        });

        it('should update position exposure correctly', () => {
            portfolioRiskManager.updatePositionExposure(mockMint1, 0.08);

            const summary = portfolioRiskManager.getPortfolioSummary() as any;
            expect(summary.totalPortfolioValue).toBe('0.0800');

            const deployerAnalysis = portfolioRiskManager.getDeployerAnalysis(mockDeployer);
            expect((deployerAnalysis as any).totalExposure).toBe('0.0800');
        });

        it('should handle reducing position exposure', () => {
            portfolioRiskManager.updatePositionExposure(mockMint1, 0.02);

            const summary = portfolioRiskManager.getPortfolioSummary() as any;
            expect(summary.totalPortfolioValue).toBe('0.0200');

            const deployerAnalysis = portfolioRiskManager.getDeployerAnalysis(mockDeployer);
            expect((deployerAnalysis as any).totalExposure).toBe('0.0200');
        });
    });

    describe('getConcentrationWarnings', () => {
        it('should return warnings for high concentration positions', () => {
            // Create portfolio with high concentration
            portfolioRiskManager.recordPosition(mockMint1, mockDeployer, 0.2);  // Will be 80% of 0.25
            portfolioRiskManager.recordPosition(mockMint2, 'OTHER', 0.05);

            const warnings = portfolioRiskManager.getConcentrationWarnings();
            expect(warnings.length).toBe(1);
            expect(warnings[0].token).toBe(mockMint1);
            expect(warnings[0].concentration).toBeCloseTo(0.8);
            expect(warnings[0].warning).toContain('Near concentration limit');
        });

        it('should return threshold warnings', () => {
            // Create portfolio with above-threshold concentration
            portfolioRiskManager.recordPosition(mockMint1, mockDeployer, 0.18);  // 18% > 15% threshold
            portfolioRiskManager.recordPosition(mockMint2, 'OTHER', 0.82);

            const warnings = portfolioRiskManager.getConcentrationWarnings();
            expect(warnings.length).toBeGreaterThan(0);
            
            const mint1Warning = warnings.find(w => w.token === mockMint1);
            expect(mint1Warning?.warning).toContain('Above concentration threshold');
        });

        it('should return empty array for balanced portfolio', () => {
            // Create well-balanced portfolio
            portfolioRiskManager.recordPosition('TOKEN1', 'DEP1', 0.05);  // 10%
            portfolioRiskManager.recordPosition('TOKEN2', 'DEP2', 0.05);  // 10%
            portfolioRiskManager.recordPosition('TOKEN3', 'DEP3', 0.05);  // 10%
            portfolioRiskManager.recordPosition('TOKEN4', 'DEP4', 0.35);  // 70%

            const warnings = portfolioRiskManager.getConcentrationWarnings();
            expect(warnings.length).toBe(0);
        });
    });

    describe('cleanupStalePositions', () => {
        it('should remove stale positions', () => {
            // Record position and artificially age it
            portfolioRiskManager.recordPosition(mockMint1, mockDeployer, 0.05);
            
            // Access internal state to age the position
            const state = (portfolioRiskManager as any).state;
            const position = state.tokenPositions.get(mockMint1);
            position.lastUpdateTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago

            const removedCount = portfolioRiskManager.cleanupStalePositions(24 * 60 * 60 * 1000);
            
            expect(removedCount).toBe(1);
            const summary = portfolioRiskManager.getPortfolioSummary() as any;
            expect(summary.positionCount).toBe(0);
        });

        it('should keep fresh positions', () => {
            portfolioRiskManager.recordPosition(mockMint1, mockDeployer, 0.05);
            
            const removedCount = portfolioRiskManager.cleanupStalePositions(24 * 60 * 60 * 1000);
            
            expect(removedCount).toBe(0);
            const summary = portfolioRiskManager.getPortfolioSummary() as any;
            expect(summary.positionCount).toBe(1);
        });
    });

    describe('getPortfolioSummary', () => {
        it('should provide comprehensive portfolio summary', () => {
            portfolioRiskManager.recordPosition(mockMint1, mockDeployer, 0.05);
            portfolioRiskManager.recordPosition(mockMint2, 'DEPLOYER2', 0.03);

            const summary = portfolioRiskManager.getPortfolioSummary() as any;
            
            expect(summary.totalPortfolioValue).toBe('0.0800');
            expect(summary.deployerCount).toBe(2);
            expect(summary.positionCount).toBe(2);
            expect(summary.limits).toBeDefined();
            expect(summary.deployers).toHaveLength(2);
            expect(summary.tokens).toHaveLength(2);
        });
    });
});