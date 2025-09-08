// tests/unit/marketCap.test.ts
// Unit tests for the fixed market cap calculation functionality

import { jest } from '@jest/globals';

// Mock all external dependencies before imports
const mockConnection = {
  getAccountInfo: jest.fn() as jest.MockedFunction<any>,
  getTokenLargestAccounts: jest.fn() as jest.MockedFunction<any>,
};

const mockWallet = {
  publicKey: { toBase58: () => 'testWallet123' },
};

// Mock the trading module
const mockGetCurrentPriceViaJupiter = jest.fn() as jest.MockedFunction<any>;

// Mock logger
const mockLogger = {
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
};

// Set up mocks before imports
jest.mock('@solana/web3.js', () => ({
  PublicKey: jest.fn((key: any) => ({
    toBase58: () => key,
    toBuffer: () => Buffer.from(String(key), 'utf8'),
  })),
  Connection: jest.fn(() => mockConnection),
}));

jest.mock('../../src/utils/solana.ts', () => ({
  connection: mockConnection,
  loadWallet: jest.fn(() => mockWallet),
}));

jest.mock('../../src/core/trading.ts', () => ({
  getCurrentPriceViaJupiter: mockGetCurrentPriceViaJupiter,
}));

jest.mock('../../src/utils/logger.ts', () => ({
  default: mockLogger,
}));

jest.mock('@solana/spl-token', () => ({
  MintLayout: {
    decode: jest.fn(),
  },
  TOKEN_PROGRAM_ID: { toBuffer: () => Buffer.from('token_program') },
  ASSOCIATED_TOKEN_PROGRAM_ID: { toBuffer: () => Buffer.from('associated_token_program') },
}));

// Import modules normally
import { scoreToken } from '../../src/core/scoring';
import { MintLayout } from '@solana/spl-token';

describe('Market Cap Calculation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createMockToken = (overrides = {}) => ({
    mint: 'testMint123',
    pool: 'raydium',
    signature: 'testSig',
    creator: 'testCreator123',
    launchedAt: Date.now(),
    simulatedLp: 5,
    hasJupiterRoute: true,
    lpTokenAddress: 'testLpAddress',
    metadata: {
      name: 'Test Token',
      symbol: 'TEST',
      decimals: 9,
    },
    earlyHolders: 100,
    launchSpeedSeconds: 60,
    ...overrides,
  });

  test('should calculate market cap correctly with valid data', async () => {
    const token = createMockToken();

    // Mock mint account info (1 billion tokens with 9 decimals)
    const mockMintData = Buffer.alloc(82);
    mockConnection.getAccountInfo.mockResolvedValue({
      data: mockMintData,
    });

    // Mock MintLayout decode to return 1 billion raw supply
    (MintLayout.decode as jest.Mock).mockReturnValue({
      supply: BigInt('1000000000000000000'), // 1 billion tokens with 9 decimals
      decimals: 9,
    });

    // Mock price data: 0.000001 SOL per token
    mockGetCurrentPriceViaJupiter.mockResolvedValue({
      price: 0.000001, // SOL per token
      liquidity: 0.01,
    });

    // Mock metadata check
    mockConnection.getAccountInfo
      .mockResolvedValueOnce({ data: mockMintData }) // For supply check
      .mockResolvedValueOnce(null) // For metadata check
      .mockResolvedValueOnce({ data: mockMintData }) // For whale check
      .mockResolvedValue(null);

    // Mock largest accounts
    mockConnection.getTokenLargestAccounts = jest.fn().mockResolvedValue({
      value: [{ address: 'testAddress', uiAmount: 100000000 }], // 100M tokens
    });

    const result = await scoreToken(token);

    expect(result.details.marketCapSol).toBe(1000); // 1B tokens × 0.000001 SOL = 1000 SOL
    expect(result.details.largeCap).toBe(true); // 1000 SOL > 10 SOL minimum
  });

  test('should handle invalid token supply gracefully', async () => {
    const token = createMockToken();

    // Mock no mint account
    mockConnection.getAccountInfo.mockResolvedValue(null);

    const result = await scoreToken(token);

    expect(result.details.marketCapSol).toBeNull();
    expect(result.details.largeCap).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'SCORING',
      'Mint account not found for supply calculation',
      expect.any(Object),
    );
  });

  test('should reject unreasonably large supplies', async () => {
    const token = createMockToken();

    const mockMintData = Buffer.alloc(82);
    mockConnection.getAccountInfo.mockResolvedValue({
      data: mockMintData,
    });

    // Mock unreasonably large supply (more than 1 quadrillion)
    (MintLayout.decode as jest.Mock).mockReturnValue({
      supply: BigInt('2000000000000000000000000000000000'), // 2 quadrillion
      decimals: 9,
    });

    mockGetCurrentPriceViaJupiter.mockResolvedValue({
      price: 0.000001,
      liquidity: 0.01,
    });

    // Mock metadata and whale checks
    mockConnection.getAccountInfo
      .mockResolvedValueOnce({ data: mockMintData })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ data: mockMintData });

    mockConnection.getTokenLargestAccounts = jest.fn().mockResolvedValue({
      value: [{ address: 'testAddress', uiAmount: 100000000 }],
    });

    const result = await scoreToken(token);

    expect(result.details.marketCapSol).toBeNull();
    expect(result.details.largeCap).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'SCORING',
      'Token supply too large - possible calculation error',
      expect.objectContaining({
        supply: expect.any(Number),
        maxReasonable: 1e15,
      }),
    );
  });

  test('should reject unreasonable prices', async () => {
    const token = createMockToken();

    const mockMintData = Buffer.alloc(82);
    mockConnection.getAccountInfo.mockResolvedValue({
      data: mockMintData,
    });

    (MintLayout.decode as jest.Mock).mockReturnValue({
      supply: BigInt('1000000000000000000'), // 1 billion tokens
      decimals: 9,
    });

    // Mock unreasonably high price
    mockGetCurrentPriceViaJupiter.mockResolvedValue({
      price: 2000000, // 2M SOL per token (unrealistic)
      liquidity: 0.01,
    });

    // Mock metadata and whale checks
    mockConnection.getAccountInfo
      .mockResolvedValueOnce({ data: mockMintData })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ data: mockMintData });

    mockConnection.getTokenLargestAccounts = jest.fn().mockResolvedValue({
      value: [{ address: 'testAddress', uiAmount: 100000000 }],
    });

    const result = await scoreToken(token);

    expect(result.details.marketCapSol).toBeNull();
    expect(result.details.largeCap).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'SCORING',
      'Token price outside reasonable bounds',
      expect.objectContaining({
        price: 2000000,
        maxReasonable: 1e6,
      }),
    );
  });

  test('should handle missing price data gracefully', async () => {
    const token = createMockToken();

    const mockMintData = Buffer.alloc(82);
    mockConnection.getAccountInfo.mockResolvedValue({
      data: mockMintData,
    });

    (MintLayout.decode as jest.Mock).mockReturnValue({
      supply: BigInt('1000000000000000000'),
      decimals: 9,
    });

    // Mock no price data available
    mockGetCurrentPriceViaJupiter.mockResolvedValue(null);

    // Mock metadata and whale checks
    mockConnection.getAccountInfo
      .mockResolvedValueOnce({ data: mockMintData })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ data: mockMintData });

    mockConnection.getTokenLargestAccounts = jest.fn().mockResolvedValue({
      value: [{ address: 'testAddress', uiAmount: 100000000 }],
    });

    const result = await scoreToken(token);

    expect(result.details.marketCapSol).toBeNull();
    expect(result.details.largeCap).toBe(false);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'SCORING',
      'No valid price data for market cap calculation',
      expect.any(Object),
    );
  });

  test('should validate decimal bounds', async () => {
    const token = createMockToken({
      metadata: { name: 'Test', symbol: 'TEST', decimals: 25 }, // Invalid decimals
    });

    const result = await scoreToken(token);

    expect(result.details.marketCapSol).toBeNull();
    expect(result.details.largeCap).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'SCORING',
      'Invalid token decimals for market cap calculation',
      expect.objectContaining({
        decimals: 25,
      }),
    );
  });

  test('should reject unreasonably large market caps', async () => {
    const token = createMockToken();

    const mockMintData = Buffer.alloc(82);
    mockConnection.getAccountInfo.mockResolvedValue({
      data: mockMintData,
    });

    // Large but reasonable supply
    (MintLayout.decode as jest.Mock).mockReturnValue({
      supply: BigInt('1000000000000000000'), // 1 billion tokens
      decimals: 9,
    });

    // High price that would create unreasonable market cap
    mockGetCurrentPriceViaJupiter.mockResolvedValue({
      price: 200000, // 200K SOL per token
      liquidity: 0.01,
    });

    // Mock metadata and whale checks
    mockConnection.getAccountInfo
      .mockResolvedValueOnce({ data: mockMintData })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ data: mockMintData });

    mockConnection.getTokenLargestAccounts = jest.fn().mockResolvedValue({
      value: [{ address: 'testAddress', uiAmount: 100000000 }],
    });

    const result = await scoreToken(token);

    expect(result.details.marketCapSol).toBeNull();
    expect(result.details.largeCap).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'SCORING',
      'Calculated market cap unreasonably large',
      expect.objectContaining({
        marketCapSol: expect.any(Number),
        maxReasonable: 1e8,
      }),
    );
  });
});
