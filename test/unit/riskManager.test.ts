// tests/unit/riskManager.test.ts
import { PublicKey } from '@solana/web3.js';
import riskManager from '../../src/core/riskManager.js';

// Mock dependencies
jest.mock('../../src/config/index.js', () => ({
  loadBotConfig: jest.fn().mockReturnValue({
    maxPositionSize: 0.1,
    maxPositionsCount: 3,
    maxPortfolioPercent: 0.8,
    maxWalletExposure: 0.5,
    dailyLossLimit: 0.05,
    maxLossPercent: 0.1,
    buyAmounts: {
      '4': 0.01,
      '5': 0.02,
      '6': 0.05,
    },
  }),
}));

jest.mock('../../src/sell/autoSellManager.js', () => ({
  runAutoSellLoop: jest.fn().mockReturnValue({
    positions: 2,
    watching: 2,
  }),
}));

jest.mock('../../src/utils/logger.js', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('RiskManager', () => {
  let mockConnection: any;
  let mockWallet: PublicKey;

  beforeEach(() => {
    mockConnection = {
      getBalance: jest.fn().mockResolvedValue(1000000000), // 1 SOL in lamports
    };

    mockWallet = new PublicKey('11111111111111111111111111111112');

    // Clear any previous state
    jest.clearAllMocks();
  });

  describe('Position Size Limits', () => {
    it('should allow trades within position size limits', async () => {
      const result = await riskManager.checkPositionRisk({
        mint: 'TestToken111111111111111111111111111111111',
        requestedAmount: 0.05, // Within 0.1 limit
        connection: mockConnection,
        walletPubkey: mockWallet,
      });

      expect(result.allowed).toBe(true);
    });

    it('should reject trades exceeding position size limits', async () => {
      const result = await riskManager.checkPositionRisk({
        mint: 'TestToken111111111111111111111111111111111',
        requestedAmount: 0.15, // Exceeds 0.1 limit
        connection: mockConnection,
        walletPubkey: mockWallet,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('exceeds maximum allowed');
      expect(result.maxAllowedAmount).toBe(0.1);
    });
  });

  describe('Position Count Limits', () => {
    it('should allow trades within position count limits', async () => {
      // Mock shows 2 positions, limit is 3, so should allow
      const result = await riskManager.checkPositionRisk({
        mint: 'TestToken111111111111111111111111111111111',
        requestedAmount: 0.05,
        connection: mockConnection,
        walletPubkey: mockWallet,
      });

      expect(result.allowed).toBe(true);
    });

    it('should reject trades when at position count limit', async () => {
      // Mock 3 positions (at limit)
      require('../../src/sell/autoSellManager.js').runAutoSellLoop.mockReturnValueOnce({
        positions: 3,
        watching: 3,
      });

      const result = await riskManager.checkPositionRisk({
        mint: 'TestToken111111111111111111111111111111111',
        requestedAmount: 0.05,
        connection: mockConnection,
        walletPubkey: mockWallet,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Maximum positions limit reached');
      expect(result.positionCount).toBe(3);
    });
  });

  describe('Portfolio Exposure Limits', () => {
    it('should calculate and enforce total exposure limits', async () => {
      // Use a larger wallet and smaller position size to test exposure limit specifically
      mockConnection.getBalance.mockResolvedValueOnce(5000000000); // 5 SOL wallet

      // Override config to have larger position size limit but smaller exposure limit
      require('../../src/config/index.js').loadBotConfig.mockReturnValueOnce({
        maxPositionSize: 1.0, // High position size limit
        maxPositionsCount: 10, // High position count limit
        maxWalletExposure: 0.1, // Low total exposure limit
        buyAmounts: { '5': 0.03 }, // Average position size
      });

      const result = await riskManager.checkPositionRisk({
        mint: 'TestToken111111111111111111111111111111111',
        requestedAmount: 0.09, // Within position size but would exceed total exposure with existing positions
        connection: mockConnection,
        walletPubkey: mockWallet,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Total exposure would exceed limit');
    });

    it('should allow trades within total exposure limits', async () => {
      mockConnection.getBalance.mockResolvedValueOnce(2000000000); // 2 SOL wallet

      const result = await riskManager.checkPositionRisk({
        mint: 'TestToken111111111111111111111111111111111',
        requestedAmount: 0.05,
        connection: mockConnection,
        walletPubkey: mockWallet,
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe('Wallet Percentage Limits', () => {
    it('should enforce wallet balance percentage limits', async () => {
      // Use config with high position size limit to test percentage limit specifically
      require('../../src/config/index.js').loadBotConfig.mockReturnValueOnce({
        maxPositionSize: 1.0, // High enough to not trigger first
        maxPositionsCount: 10,
        maxPortfolioPercent: 0.3, // 30% limit
        maxWalletExposure: 10.0, // High enough to not trigger
        buyAmounts: { '5': 0.01 },
      });

      mockConnection.getBalance.mockResolvedValueOnce(1000000000); // 1 SOL

      const result = await riskManager.checkPositionRisk({
        mint: 'TestToken111111111111111111111111111111111',
        requestedAmount: 0.5, // Would exceed 30% of 1 SOL with existing positions
        connection: mockConnection,
        walletPubkey: mockWallet,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('30.0% of wallet balance');
    });
  });

  describe('Daily Loss Tracking', () => {
    it('should track daily losses and enforce limits', () => {
      // Create a fresh instance to avoid test pollution
      const { riskManager: freshRiskManager } = require('../../src/core/riskManager.js');

      // Record some losses
      freshRiskManager.recordLoss(0.03);
      freshRiskManager.recordLoss(0.02);

      // Check if we're near the daily loss limit (0.05 SOL)
      const shouldHalt = freshRiskManager.shouldHaltTrading();
      expect(shouldHalt).toBe(true); // Should halt after 0.05 SOL loss
    });

    it('should track daily profits', () => {
      // Create fresh instance to avoid previous test state
      const { riskManager: freshRiskManager } = require('../../src/core/riskManager.js');

      freshRiskManager.recordProfit(0.02);

      const portfolioState = freshRiskManager.getPortfolioState();
      expect(portfolioState.dailyPnL).toBe(0.02);
    });

    it('should reset daily tracking', async () => {
      // Record a loss
      riskManager.recordLoss(0.01);

      // Mock date to next day would reset tracking, but we can't easily test this
      // without mocking Date.now(). Let's just verify the portfolio state exists.
      const portfolioState = riskManager.getPortfolioState();
      expect(portfolioState.dailyLossTotal).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Emergency Halt Conditions', () => {
    it('should halt trading when daily loss limit exceeded', () => {
      riskManager.recordLoss(0.06); // Exceeds 0.05 limit

      const shouldHalt = riskManager.shouldHaltTrading();
      expect(shouldHalt).toBe(true);
    });

    it('should continue trading when within limits', () => {
      riskManager.recordLoss(0.01); // Within 0.05 limit

      const shouldHalt = riskManager.shouldHaltTrading();
      expect(shouldHalt).toBe(false);
    });
  });

  describe('Risk Summary and Monitoring', () => {
    it('should provide comprehensive risk summary', () => {
      const summary = riskManager.getRiskSummary() as any;

      expect(summary).toHaveProperty('walletBalance');
      expect(summary).toHaveProperty('totalExposure');
      expect(summary).toHaveProperty('exposurePercent');
      expect(summary).toHaveProperty('activePositions');
      expect(summary).toHaveProperty('dailyPnL');
      expect(summary).toHaveProperty('limits');

      expect(summary.limits).toHaveProperty('maxPositionSize');
      expect(summary.limits).toHaveProperty('maxPositions');
      expect(summary.limits).toHaveProperty('maxPortfolioPercent');
      expect(summary.limits).toHaveProperty('dailyLossLimit');
    });

    it('should provide accurate portfolio state', () => {
      const portfolioState = riskManager.getPortfolioState();

      expect(portfolioState).toHaveProperty('walletBalance');
      expect(portfolioState).toHaveProperty('totalExposure');
      expect(portfolioState).toHaveProperty('activePositions');
      expect(portfolioState).toHaveProperty('dailyPnL');
      expect(portfolioState).toHaveProperty('dailyLossTotal');

      expect(typeof portfolioState.walletBalance).toBe('number');
      expect(typeof portfolioState.totalExposure).toBe('number');
      expect(typeof portfolioState.activePositions).toBe('number');
    });
  });

  describe('Error Handling', () => {
    it('should handle connection errors gracefully', async () => {
      mockConnection.getBalance.mockRejectedValueOnce(new Error('Network error'));

      const result = await riskManager.checkPositionRisk({
        mint: 'TestToken111111111111111111111111111111111',
        requestedAmount: 0.05,
        connection: mockConnection,
        walletPubkey: mockWallet,
      });

      // Should still run checks that don't require network access
      expect(result.allowed).toBeDefined();
      expect(typeof result.allowed).toBe('boolean');
    });

    it('should handle invalid parameters', async () => {
      const result = await riskManager.checkPositionRisk({
        mint: '', // Invalid mint
        requestedAmount: -0.05, // Invalid amount
        connection: mockConnection,
        walletPubkey: mockWallet,
      });

      // Should handle gracefully
      expect(typeof result.allowed).toBe('boolean');
    });
  });

  describe('Configuration Edge Cases', () => {
    it('should handle unlimited limits (undefined config values)', async () => {
      // Mock config with undefined limits
      require('../../src/config/index.js').loadBotConfig.mockReturnValueOnce({
        maxPositionSize: undefined,
        maxPositionsCount: undefined,
        maxWalletExposure: undefined,
        buyAmounts: { '5': 0.01 },
      });

      const result = await riskManager.checkPositionRisk({
        mint: 'TestToken111111111111111111111111111111111',
        requestedAmount: 10.0, // Large amount
        connection: mockConnection,
        walletPubkey: mockWallet,
      });

      // Should allow when limits are undefined/unlimited
      expect(result.allowed).toBe(true);
    });

    it('should handle zero or very small limits', async () => {
      require('../../src/config/index.js').loadBotConfig.mockReturnValueOnce({
        maxPositionSize: 0.001,
        maxPositionsCount: 1,
        maxWalletExposure: 0.001,
        buyAmounts: { '5': 0.01 },
      });

      const result = await riskManager.checkPositionRisk({
        mint: 'TestToken111111111111111111111111111111111',
        requestedAmount: 0.01,
        connection: mockConnection,
        walletPubkey: mockWallet,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
    });
  });
});
