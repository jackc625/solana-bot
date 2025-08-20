import { checkTokenSafety } from '../../src/core/safety';
import { createMockPumpToken, createMockWallet } from '../setup';
import { Connection, PublicKey } from '@solana/web3.js';

// Mock the jupiter module
jest.mock('../../src/utils/jupiter', () => ({
  getSharedJupiter: jest.fn().mockResolvedValue({
    computeRoutes: jest.fn().mockResolvedValue({ routesInfos: [] })
  }),
  simulateBuySell: jest.fn().mockResolvedValue({
    passed: true,
    buyPass: true,
    sellPass: true
  })
}));

// Mock the blacklist module
jest.mock('../../src/utils/blacklist', () => ({
  addToBlacklist: jest.fn().mockResolvedValue(void 0)
}));

describe('checkTokenSafety', () => {
  let mockConnection: jest.Mocked<Connection>;
  let mockWallet: any;
  let baseConfig: any;
  let baseToken: any;

  beforeEach(() => {
    mockConnection = {
      getAccountInfo: jest.fn(),
      getTokenLargestAccounts: jest.fn()
    } as any;

    mockWallet = createMockWallet();

    baseConfig = {
      minLiquidity: 1.0,
      maxLiquidity: 100.0,
      maxTaxPercent: 10,
      honeypotCheck: true
    };

    baseToken = createMockPumpToken({
      simulatedLp: 5.0, // Above minimum
      pool: 'pump' // Curve pool
    });
  });

  describe('configuration validation', () => {
    test('should reject invalid configuration schema', async () => {
      const invalidConfig = {
        minLiquidity: -1, // Invalid negative value
        maxLiquidity: 'invalid' // Invalid type
      };

      const result = await checkTokenSafety(baseToken, invalidConfig, mockConnection, mockWallet.publicKey);

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Safety check error');
    });

    test('should accept valid configuration', async () => {
      const result = await checkTokenSafety(baseToken, baseConfig, mockConnection, mockWallet.publicKey);

      expect(result.passed).toBe(true);
    });
  });

  describe('deduplication', () => {
    test('should pass duplicate tokens through (cached)', async () => {
      const token = createMockPumpToken({ mint: 'test_mint_123' });

      // First call
      const result1 = await checkTokenSafety(token, baseConfig, mockConnection, mockWallet.publicKey);
      
      // Second call with same mint should be cached
      const result2 = await checkTokenSafety(token, baseConfig, mockConnection, mockWallet.publicKey);

      expect(result1.passed).toBe(true);
      expect(result2.passed).toBe(true);
    });
  });

  describe('liquidity threshold checks', () => {
    test('should reject tokens below minimum liquidity', async () => {
      const token = createMockPumpToken({
        simulatedLp: 0.5 // Below minimum of 1.0
      });

      const result = await checkTokenSafety(token, baseConfig, mockConnection, mockWallet.publicKey);

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Liquidity < 1 SOL');
    });

    test('should reject tokens above maximum liquidity', async () => {
      const config = { ...baseConfig, maxLiquidity: 50 };
      const token = createMockPumpToken({
        simulatedLp: 75 // Above maximum of 50
      });

      const result = await checkTokenSafety(token, config, mockConnection, mockWallet.publicKey);

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Liquidity > 50 SOL');
    });

    test('should accept tokens within liquidity range', async () => {
      const token = createMockPumpToken({
        simulatedLp: 5.0 // Within range 1-100
      });

      const result = await checkTokenSafety(token, baseConfig, mockConnection, mockWallet.publicKey);

      expect(result.passed).toBe(true);
    });

    test('should handle missing simulatedLp', async () => {
      const token = createMockPumpToken({
        simulatedLp: null
      });

      const result = await checkTokenSafety(token, baseConfig, mockConnection, mockWallet.publicKey);

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Liquidity < 1 SOL');
    });
  });

  describe('curve pool handling', () => {
    test('should accept pump pool tokens without additional checks', async () => {
      const token = createMockPumpToken({
        pool: 'pump',
        simulatedLp: 5.0
      });

      const result = await checkTokenSafety(token, baseConfig, mockConnection, mockWallet.publicKey);

      expect(result.passed).toBe(true);
      // Should not have called on-chain checks
      expect(mockConnection.getAccountInfo).not.toHaveBeenCalled();
    });

    test('should accept bonk pool tokens without additional checks', async () => {
      const token = createMockPumpToken({
        pool: 'bonk',
        simulatedLp: 5.0
      });

      const result = await checkTokenSafety(token, baseConfig, mockConnection, mockWallet.publicKey);

      expect(result.passed).toBe(true);
      // Should not have called on-chain checks
      expect(mockConnection.getAccountInfo).not.toHaveBeenCalled();
    });
  });

  describe('non-curve pool distribution checks', () => {
    beforeEach(() => {
      // Mock mint account info
      const mockMintData = Buffer.alloc(82); // MintLayout size
      // Populate with valid mint data structure
      mockMintData.writeUInt32LE(0, 0); // mintAuthorityOption
      mockMintData.writeUInt32LE(0, 36); // freezeAuthorityOption
      mockMintData.writeUInt8(9, 44); // decimals
      mockMintData.writeBigUInt64LE(BigInt(1000000000000000), 64); // supply (1M tokens with 9 decimals)

      mockConnection.getAccountInfo.mockResolvedValue({
        data: mockMintData,
        executable: false,
        lamports: 1000000,
        owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
      });

      // Mock token largest accounts
      mockConnection.getTokenLargestAccounts.mockResolvedValue({
        context: { slot: 123 },
        value: [
          {
            address: new PublicKey('11111111111111111111111111111111'),
            uiAmount: 50000, // 5% of 1M tokens
            decimals: 9
          }
        ]
      });
    });

    test('should reject tokens with mint authority', async () => {
      const token = createMockPumpToken({
        pool: 'raydium' // Non-curve pool
      });

      // Mock mint data with mint authority
      const mockMintData = Buffer.alloc(82);
      mockMintData.writeUInt32LE(1, 0); // mintAuthorityOption = 1 (has authority)
      mockMintData.writeUInt32LE(0, 36); // freezeAuthorityOption = 0
      mockMintData.writeUInt8(9, 44); // decimals

      mockConnection.getAccountInfo.mockResolvedValue({
        data: mockMintData,
        executable: false,
        lamports: 1000000,
        owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
      });

      const result = await checkTokenSafety(token, baseConfig, mockConnection, mockWallet.publicKey);

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Mint or freeze authority exists');
    });

    test('should reject tokens with freeze authority', async () => {
      const token = createMockPumpToken({
        pool: 'raydium' // Non-curve pool
      });

      // Mock mint data with freeze authority
      const mockMintData = Buffer.alloc(82);
      mockMintData.writeUInt32LE(0, 0); // mintAuthorityOption = 0
      mockMintData.writeUInt32LE(1, 36); // freezeAuthorityOption = 1 (has authority)
      mockMintData.writeUInt8(9, 44); // decimals

      mockConnection.getAccountInfo.mockResolvedValue({
        data: mockMintData,
        executable: false,
        lamports: 1000000,
        owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
      });

      const result = await checkTokenSafety(token, baseConfig, mockConnection, mockWallet.publicKey);

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Mint or freeze authority exists');
    });

    test('should reject tokens with high creator concentration', async () => {
      const token = createMockPumpToken({
        pool: 'raydium', // Non-curve pool
        creator: 'creator_address'
      });

      // Mock large holder being the creator (>10%)
      mockConnection.getTokenLargestAccounts.mockResolvedValue({
        context: { slot: 123 },
        value: [
          {
            address: new PublicKey('11111111111111111111111111111111'),
            uiAmount: 150000, // 15% of 1M tokens
            decimals: 9
          }
        ]
      });

      const result = await checkTokenSafety(token, baseConfig, mockConnection, mockWallet.publicKey);

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Creator holds 15.0%');
    });

    test('should accept tokens with proper distribution', async () => {
      const token = createMockPumpToken({
        pool: 'raydium' // Non-curve pool
      });

      const result = await checkTokenSafety(token, baseConfig, mockConnection, mockWallet.publicKey);

      expect(result.passed).toBe(true);
    });

    test('should handle on-chain check errors gracefully', async () => {
      const token = createMockPumpToken({
        pool: 'raydium' // Non-curve pool
      });

      mockConnection.getAccountInfo.mockRejectedValue(new Error('RPC error'));

      const result = await checkTokenSafety(token, baseConfig, mockConnection, mockWallet.publicKey);

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('On-chain distribution check error');
    });
  });

  describe('honeypot simulation', () => {
    test('should reject tokens that fail sell simulation', async () => {
      const { simulateBuySell } = require('../../src/utils/jupiter');
      simulateBuySell.mockResolvedValue({
        passed: false,
        buyPass: true,
        sellPass: false
      });

      const result = await checkTokenSafety(baseToken, baseConfig, mockConnection, mockWallet.publicKey);

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Honeypot suspected');
    });

    test('should accept tokens that pass sell simulation', async () => {
      const { simulateBuySell } = require('../../src/utils/jupiter');
      simulateBuySell.mockResolvedValue({
        passed: true,
        buyPass: true,
        sellPass: true
      });

      const result = await checkTokenSafety(baseToken, baseConfig, mockConnection, mockWallet.publicKey);

      expect(result.passed).toBe(true);
    });

    test('should skip honeypot check when disabled', async () => {
      const config = { ...baseConfig, honeypotCheck: false };
      const { simulateBuySell } = require('../../src/utils/jupiter');

      const result = await checkTokenSafety(baseToken, config, mockConnection, mockWallet.publicKey);

      expect(result.passed).toBe(true);
      expect(simulateBuySell).not.toHaveBeenCalled();
    });

    test('should handle honeypot simulation errors gracefully', async () => {
      const { simulateBuySell } = require('../../src/utils/jupiter');
      simulateBuySell.mockRejectedValue(new Error('Simulation failed'));

      const result = await checkTokenSafety(baseToken, baseConfig, mockConnection, mockWallet.publicKey);

      // Should pass through even if simulation fails (non-fatal)
      expect(result.passed).toBe(true);
    });
  });

  describe('error handling', () => {
    test('should handle unexpected errors gracefully', async () => {
      // Force an error by passing invalid parameters
      const result = await checkTokenSafety(null as any, baseConfig, mockConnection, mockWallet.publicKey);

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Safety check error');
    });
  });
});