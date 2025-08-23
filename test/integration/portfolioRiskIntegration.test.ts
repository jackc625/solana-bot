// test/integration/portfolioRiskIntegration.test.ts
// Integration tests for portfolio risk management in trading pipeline

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Connection, PublicKey } from '@solana/web3.js';
import { portfolioRiskManager } from '../../src/core/portfolioRiskManager.js';
import type { PumpToken } from '../../src/types/index.js';

// Mock dependencies
jest.mock('../../src/config/index.js', () => ({
    loadBotConfig: jest.fn(() => ({
        maxDeployerExposure: 0.1,
        maxTokenConcentration: 0.25,
        maxDeployerTokens: 3,
        deployerCooldownMs: 300000, // 5 minutes
        concentrationThreshold: 0.15
    }))
}));

jest.mock('../../src/utils/logger.js', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

describe('Portfolio Risk Management Integration', () => {
    const mockConnection = {} as Connection;
    const mockWalletPubkey = new PublicKey('11111111111111111111111111111111');

    beforeEach(() => {
        // Reset portfolio state
        (portfolioRiskManager as any).state = {
            totalPortfolioValue: 0,
            deployerExposures: new Map(),
            tokenPositions: new Map(),
            lastUpdate: 0
        };
    });

    it('should handle complete trading lifecycle with portfolio tracking', async () => {
        const deployer1 = 'DEPLOYERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
        const deployer2 = 'DEPLOYER2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
        const mint1 = 'MINTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
        const mint2 = 'MINT2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
        const mint3 = 'MINT3xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

        // Test 1: First position should be allowed
        let result = await portfolioRiskManager.checkPortfolioRisk({
            mint: mint1,
            deployer: deployer1,
            requestedAmount: 0.05,
            connection: mockConnection,
            walletPubkey: mockWalletPubkey
        });

        expect(result.allowed).toBe(true);

        // Record the position
        portfolioRiskManager.recordPosition(mint1, deployer1, 0.05);

        // Test 2: Second position from same deployer within limits
        result = await portfolioRiskManager.checkPortfolioRisk({
            mint: mint2,
            deployer: deployer1,
            requestedAmount: 0.04,
            connection: mockConnection,
            walletPubkey: mockWalletPubkey
        });

        expect(result.allowed).toBe(true);
        portfolioRiskManager.recordPosition(mint2, deployer1, 0.04);

        // Test 3: Third position should exceed deployer limit
        result = await portfolioRiskManager.checkPortfolioRisk({
            mint: mint3,
            deployer: deployer1,
            requestedAmount: 0.02, // Total would be 0.11 > 0.1 limit
            connection: mockConnection,
            walletPubkey: mockWalletPubkey
        });

        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('Deployer exposure limit exceeded');

        // Test 4: Position from different deployer should be allowed
        result = await portfolioRiskManager.checkPortfolioRisk({
            mint: mint3,
            deployer: deployer2,
            requestedAmount: 0.02,
            connection: mockConnection,
            walletPubkey: mockWalletPubkey
        });

        expect(result.allowed).toBe(true);
        portfolioRiskManager.recordPosition(mint3, deployer2, 0.02);

        // Test 5: Verify portfolio state
        const summary = portfolioRiskManager.getPortfolioSummary() as any;
        expect(summary.totalPortfolioValue).toBe('0.1100'); // 0.05 + 0.04 + 0.02
        expect(summary.deployerCount).toBe(2);
        expect(summary.positionCount).toBe(3);

        // Test 6: Sell a position and verify cleanup
        portfolioRiskManager.removePosition(mint1, deployer1);

        const summaryAfterSell = portfolioRiskManager.getPortfolioSummary() as any;
        expect(summaryAfterSell.totalPortfolioValue).toBe('0.0600'); // 0.04 + 0.02
        expect(summaryAfterSell.positionCount).toBe(2);

        const deployer1Analysis = portfolioRiskManager.getDeployerAnalysis(deployer1);
        expect((deployer1Analysis as any).totalExposure).toBe('0.0400');
        expect((deployer1Analysis as any).tokenCount).toBe(1);

        // Test 7: Now can add new position to deployer1 within limits
        result = await portfolioRiskManager.checkPortfolioRisk({
            mint: 'NEW_MINT',
            deployer: deployer1,
            requestedAmount: 0.05,
            connection: mockConnection,
            walletPubkey: mockWalletPubkey
        });

        expect(result.allowed).toBe(true);
    });

    it('should enforce token concentration limits across deployers', async () => {
        const deployer1 = 'DEPLOYER1';
        const deployer2 = 'DEPLOYER2';
        const deployer3 = 'DEPLOYER3';
        
        // Build a diverse portfolio first
        portfolioRiskManager.recordPosition('TOKEN1', deployer1, 0.08);
        portfolioRiskManager.recordPosition('TOKEN2', deployer2, 0.08);
        portfolioRiskManager.recordPosition('TOKEN3', deployer3, 0.04);
        // Total portfolio: 0.2 SOL

        // Try to add a position that would create >25% concentration
        // New total would be 0.2 + 0.08 = 0.28
        // New token concentration would be 0.08/0.28 = 28.6% > 25%
        const result = await portfolioRiskManager.checkPortfolioRisk({
            mint: 'LARGE_POSITION',
            deployer: 'DEPLOYER4',
            requestedAmount: 0.08,
            connection: mockConnection,
            walletPubkey: mockWalletPubkey
        });

        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('Token concentration limit exceeded');
        expect(result.currentTokenConcentration).toBeGreaterThan(0.25);
    });

    it('should handle cooldown enforcement correctly', async () => {
        const deployer = 'DEPLOYER_COOLDOWN_TEST';
        const mint1 = 'MINT1';
        const mint2 = 'MINT2';

        // First position - should be allowed
        let result = await portfolioRiskManager.checkPortfolioRisk({
            mint: mint1,
            deployer: deployer,
            requestedAmount: 0.03,
            connection: mockConnection,
            walletPubkey: mockWalletPubkey
        });

        expect(result.allowed).toBe(true);
        portfolioRiskManager.recordPosition(mint1, deployer, 0.03);

        // Immediate second position - should be blocked by cooldown
        result = await portfolioRiskManager.checkPortfolioRisk({
            mint: mint2,
            deployer: deployer,
            requestedAmount: 0.03,
            connection: mockConnection,
            walletPubkey: mockWalletPubkey
        });

        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('Deployer cooldown active');
        expect(result.cooldownRemaining).toBeGreaterThan(0);

        // But same token should still be allowed (adding to existing position)
        result = await portfolioRiskManager.checkPortfolioRisk({
            mint: mint1, // Same token
            deployer: deployer,
            requestedAmount: 0.02,
            connection: mockConnection,
            walletPubkey: mockWalletPubkey
        });

        expect(result.allowed).toBe(true);
    });

    it('should provide accurate concentration warnings', async () => {
        // Create portfolio with one high-concentration position
        portfolioRiskManager.recordPosition('HIGH_CONC', 'DEPLOYER1', 0.22); // 88% of 0.25 total
        portfolioRiskManager.recordPosition('SMALL1', 'DEPLOYER2', 0.015);
        portfolioRiskManager.recordPosition('SMALL2', 'DEPLOYER3', 0.015);

        const warnings = portfolioRiskManager.getConcentrationWarnings();
        
        expect(warnings.length).toBe(1);
        expect(warnings[0].token).toBe('HIGH_CONC');
        expect(warnings[0].concentration).toBeCloseTo(0.88);
        expect(warnings[0].warning).toContain('Near concentration limit');
    });

    it('should handle partial position updates correctly', () => {
        const deployer = 'DEPLOYER_UPDATE_TEST';
        const mint = 'MINT_UPDATE';

        // Record initial position
        portfolioRiskManager.recordPosition(mint, deployer, 0.05);

        let summary = portfolioRiskManager.getPortfolioSummary() as any;
        expect(summary.totalPortfolioValue).toBe('0.0500');

        // Update position (e.g., after partial sell)
        portfolioRiskManager.updatePositionExposure(mint, 0.03);

        summary = portfolioRiskManager.getPortfolioSummary() as any;
        expect(summary.totalPortfolioValue).toBe('0.0300');

        const deployerAnalysis = portfolioRiskManager.getDeployerAnalysis(deployer);
        expect((deployerAnalysis as any).totalExposure).toBe('0.0300');
    });
});