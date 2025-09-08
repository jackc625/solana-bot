// tests/lpLockVerification.test.ts

import { PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import {
  verifyLpLockStatus,
  verifyTokenLpLock,
  LpLockStatus,
  LpLockConfig,
} from '../../src/utils/lpLockVerification';

// Get the mocked function
const mockGetMint = getMint as jest.MockedFunction<typeof getMint>;

// Mock dependencies
jest.mock('@solana/spl-token', () => ({
  MintLayout: {
    decode: jest.fn(),
  },
  TOKEN_PROGRAM_ID: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  getMint: jest.fn(),
}));

jest.mock('../../src/utils/logger.ts', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { MintLayout } = require('@solana/spl-token');

describe('LP Lock Verification', () => {
  const testLpMint = new PublicKey('11111111111111111111111111111112');
  const testTokenMint = new PublicKey('11111111111111111111111111111113');
  const burnAddress = new PublicKey('1nc1nerator11111111111111111111111111111111');

  const mockConnection = {
    getTokenLargestAccounts: jest.fn(),
    getAccountInfo: jest.fn(),
    getParsedAccountInfo: jest.fn(),
  };

  const defaultConfig: LpLockConfig = {
    minLockPercentage: 80,
    minLockDurationHours: 24,
    acceptBurnedLp: true,
    acceptVestingLock: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('verifyLpLockStatus', () => {
    it('should detect completely burned LP tokens (supply = 0)', async () => {
      // Mock LP mint account with zero supply
      mockConnection.getAccountInfo.mockResolvedValue({
        data: Buffer.alloc(82), // Mint account size
      });

      MintLayout.decode.mockReturnValue({
        supply: BigInt(0),
        decimals: 9,
      });

      const result = await verifyLpLockStatus(mockConnection as any, testLpMint, defaultConfig);

      expect(result.isLocked).toBe(true);
      expect(result.lockType).toBe('burned');
      expect(result.lockPercentage).toBe(100);
      expect(result.totalSupply).toBe(0);
      expect(result.details).toContain('All LP tokens have been burned');
    });

    it('should detect LP tokens burned to burn address', async () => {
      const totalSupply = 1000;
      const burnedAmount = 900; // 90% burned

      // Mock LP mint account
      mockConnection.getAccountInfo
        .mockResolvedValueOnce({
          // First call for mint account
          data: Buffer.alloc(82),
        })
        .mockResolvedValue(null); // Subsequent calls for token accounts

      MintLayout.decode.mockReturnValue({
        supply: BigInt(totalSupply * 1e9),
        decimals: 9,
      });

      mockConnection.getTokenLargestAccounts.mockResolvedValue({
        value: [
          {
            address: burnAddress,
            uiAmount: burnedAmount,
          },
          {
            address: new PublicKey('22222222222222222222222222222222'),
            uiAmount: 100,
          },
        ],
      });

      const result = await verifyLpLockStatus(mockConnection as any, testLpMint, defaultConfig);

      expect(result.isLocked).toBe(true);
      expect(result.lockType).toBe('burned');
      expect(result.lockPercentage).toBe(90);
      expect(result.burnedAmount).toBe(900);
      expect(result.totalSupply).toBe(1000);
    });

    it('should detect insufficient LP lock percentage', async () => {
      const totalSupply = 1000;
      const burnedAmount = 50; // Only 5% burned, below 80% threshold

      mockGetMint.mockResolvedValue({
        supply: BigInt(totalSupply * 1e9),
        decimals: 9,
      });

      mockConnection.getTokenLargestAccounts.mockResolvedValue({
        value: [
          {
            address: burnAddress,
            uiAmount: burnedAmount,
          },
          {
            address: new PublicKey('22222222222222222222222222222222'),
            uiAmount: 950,
          },
        ],
      });

      mockConnection.getAccountInfo.mockResolvedValue(null);

      const result = await verifyLpLockStatus(mockConnection as any, testLpMint, defaultConfig);

      expect(result.isLocked).toBe(false);
      expect(result.lockType).toBe('burned');
      expect(result.lockPercentage).toBe(5);
      expect(result.details).toContain('INSUFFICIENT');
    });

    it('should handle locked LP tokens in vesting contracts', async () => {
      const totalSupply = 1000;
      const lockedAmount = 850; // 85% locked

      mockGetMint.mockResolvedValue({
        supply: BigInt(totalSupply * 1e9),
        decimals: 9,
      });

      const lockAccount = new PublicKey('33333333333333333333333333333333');
      const lockProgram = new PublicKey('11111111111111111111111111111111');

      mockConnection.getTokenLargestAccounts.mockResolvedValue({
        value: [
          {
            address: lockAccount,
            uiAmount: lockedAmount,
          },
          {
            address: new PublicKey('22222222222222222222222222222222'),
            uiAmount: 150,
          },
        ],
      });

      // Mock lock account data
      mockConnection.getAccountInfo.mockResolvedValue({
        owner: lockProgram,
        data: Buffer.alloc(0),
      });

      const result = await verifyLpLockStatus(mockConnection as any, testLpMint, defaultConfig);

      expect(result.isLocked).toBe(true);
      expect(result.lockType).toBe('vesting_locked');
      expect(result.lockPercentage).toBe(85);
      expect(result.lockedAmount).toBe(850);
      expect(result.lockProgram).toBe(lockProgram.toBase58());
    });

    it('should handle combination of burned and locked LP tokens', async () => {
      const totalSupply = 1000;
      const burnedAmount = 400; // 40% burned
      const lockedAmount = 500; // 50% locked = 90% total

      mockGetMint.mockResolvedValue({
        supply: BigInt(totalSupply * 1e9),
        decimals: 9,
      });

      const lockAccount = new PublicKey('33333333333333333333333333333333');
      const lockProgram = new PublicKey('11111111111111111111111111111111');

      mockConnection.getTokenLargestAccounts.mockResolvedValue({
        value: [
          {
            address: burnAddress,
            uiAmount: burnedAmount,
          },
          {
            address: lockAccount,
            uiAmount: lockedAmount,
          },
          {
            address: new PublicKey('22222222222222222222222222222222'),
            uiAmount: 100,
          },
        ],
      });

      mockConnection.getAccountInfo
        .mockResolvedValueOnce(null) // burn address
        .mockResolvedValueOnce({
          // lock account
          owner: lockProgram,
          data: Buffer.alloc(0),
        });

      const result = await verifyLpLockStatus(mockConnection as any, testLpMint, defaultConfig);

      expect(result.isLocked).toBe(true);
      expect(result.lockType).toBe('burned'); // Prefers burned classification
      expect(result.lockPercentage).toBe(90);
      expect(result.burnedAmount).toBe(400);
      expect(result.lockedAmount).toBe(500);
    });

    it('should handle configuration with different thresholds', async () => {
      const strictConfig: LpLockConfig = {
        minLockPercentage: 95, // Require 95% instead of 80%
        minLockDurationHours: 48, // Require 48 hours instead of 24
        acceptBurnedLp: true,
        acceptVestingLock: true,
      };

      const totalSupply = 1000;
      const burnedAmount = 900; // 90% burned, below 95% threshold

      mockGetMint.mockResolvedValue({
        supply: BigInt(totalSupply * 1e9),
        decimals: 9,
      });

      mockConnection.getTokenLargestAccounts.mockResolvedValue({
        value: [
          {
            address: burnAddress,
            uiAmount: burnedAmount,
          },
        ],
      });

      mockConnection.getAccountInfo.mockResolvedValue(null);

      const result = await verifyLpLockStatus(mockConnection as any, testLpMint, strictConfig);

      expect(result.isLocked).toBe(false);
      expect(result.lockPercentage).toBe(90);
      expect(result.details).toContain('INSUFFICIENT (requires 95%+)');
    });

    it('should reject burned LP when acceptBurnedLp is false', async () => {
      const configNoBurn: LpLockConfig = {
        minLockPercentage: 80,
        minLockDurationHours: 24,
        acceptBurnedLp: false, // Don't accept burned LP
        acceptVestingLock: true,
      };

      mockGetMint.mockResolvedValue({
        supply: BigInt(0),
        decimals: 9,
      });

      const result = await verifyLpLockStatus(mockConnection as any, testLpMint, configNoBurn);

      expect(result.isLocked).toBe(false);
      expect(result.lockType).toBe('burned');
      expect(result.lockPercentage).toBe(100);
    });

    it('should handle errors gracefully', async () => {
      mockGetMint.mockRejectedValue(new Error('Network error'));

      const result = await verifyLpLockStatus(mockConnection as any, testLpMint, defaultConfig);

      expect(result.isLocked).toBe(false);
      expect(result.lockType).toBe('not_locked');
      expect(result.details).toContain('LP lock verification error: Network error');
    });
  });

  describe('verifyTokenLpLock', () => {
    it('should verify LP lock when LP mint is provided', async () => {
      mockGetMint.mockResolvedValue({
        supply: BigInt(0),
        decimals: 9,
      });

      const result = await verifyTokenLpLock(
        mockConnection as any,
        testTokenMint,
        { lpMint: testLpMint },
        { minLockPercentage: 80 },
      );

      expect(result.isLocked).toBe(true);
      expect(result.lockType).toBe('burned');
    });

    it('should return failure when LP mint is not available', async () => {
      const result = await verifyTokenLpLock(
        mockConnection as any,
        testTokenMint,
        {}, // No LP mint provided
        { minLockPercentage: 80 },
      );

      expect(result.isLocked).toBe(false);
      expect(result.details).toContain('Cannot verify LP lock: LP mint address not available');
    });

    it('should use default configuration values', async () => {
      mockGetMint.mockResolvedValue({
        supply: BigInt(1000 * 1e9),
        decimals: 9,
      });

      mockConnection.getTokenLargestAccounts.mockResolvedValue({
        value: [
          {
            address: burnAddress,
            uiAmount: 850, // 85% burned
          },
        ],
      });

      mockConnection.getAccountInfo.mockResolvedValue(null);

      // Test with minimal config
      const result = await verifyTokenLpLock(
        mockConnection as any,
        testTokenMint,
        { lpMint: testLpMint },
        {}, // Empty config - should use defaults
      );

      expect(result.isLocked).toBe(true); // 85% > 80% default threshold
      expect(result.lockPercentage).toBe(85);
    });
  });

  describe('Edge cases and validation', () => {
    it('should handle LP tokens with zero largest accounts', async () => {
      mockGetMint.mockResolvedValue({
        supply: BigInt(1000 * 1e9),
        decimals: 9,
      });

      mockConnection.getTokenLargestAccounts.mockResolvedValue({
        value: [], // No large accounts
      });

      const result = await verifyLpLockStatus(mockConnection as any, testLpMint, defaultConfig);

      expect(result.isLocked).toBe(false);
      expect(result.lockPercentage).toBe(0);
      expect(result.burnedAmount).toBe(0);
      expect(result.lockedAmount).toBe(0);
    });

    it('should handle malformed account data gracefully', async () => {
      mockGetMint.mockResolvedValue({
        supply: BigInt(1000 * 1e9),
        decimals: 9,
      });

      mockConnection.getTokenLargestAccounts.mockResolvedValue({
        value: [
          {
            address: null, // Invalid address
            uiAmount: 500,
          },
          {
            address: new PublicKey('22222222222222222222222222222222'),
            uiAmount: null, // Invalid amount
          },
        ],
      });

      const result = await verifyLpLockStatus(mockConnection as any, testLpMint, defaultConfig);

      expect(result.isLocked).toBe(false);
      expect(result.lockPercentage).toBe(0);
    });

    it('should calculate percentages correctly with decimals', async () => {
      const totalSupply = 1234567;
      const burnedAmount = 987654.321;

      mockGetMint.mockResolvedValue({
        supply: BigInt(totalSupply * 1e9),
        decimals: 9,
      });

      mockConnection.getTokenLargestAccounts.mockResolvedValue({
        value: [
          {
            address: burnAddress,
            uiAmount: burnedAmount,
          },
        ],
      });

      mockConnection.getAccountInfo.mockResolvedValue(null);

      const result = await verifyLpLockStatus(mockConnection as any, testLpMint, defaultConfig);

      const expectedPercentage = (burnedAmount / totalSupply) * 100;
      expect(result.lockPercentage).toBeCloseTo(expectedPercentage, 2);
      expect(result.isLocked).toBe(expectedPercentage >= 80);
    });
  });
});
