// Test setup file - runs before each test file
import * as dotenv from 'dotenv';

// Load test environment variables
dotenv.config({ path: '.env.test' });

// Set NODE_ENV to test
process.env.NODE_ENV = 'test';

// Mock environment variables for testing
process.env.PRIVATE_KEY = process.env.PRIVATE_KEY || 'test_private_key_base58_encoded_64_bytes_long_for_testing_only';
process.env.RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
process.env.LOG_LEVEL = 'ERROR'; // Reduce noise in tests

// Global test utilities
global.console = {
  ...console,
  // Silence console.log during tests unless explicitly needed
  log: process.env.TEST_VERBOSE === 'true' ? console.log : jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: console.error, // Keep errors visible
};

// Mock external dependencies that aren't needed for unit tests
jest.mock('@jup-ag/core', () => ({
  Jupiter: {
    load: jest.fn().mockResolvedValue({
      computeRoutes: jest.fn().mockResolvedValue({ routesInfos: [] }),
      exchange: jest.fn().mockResolvedValue({ swapTransaction: 'mock_transaction' })
    })
  }
}));

// Mock Solana web3.js for unit tests
jest.mock('@solana/web3.js', () => {
  const actual = jest.requireActual('@solana/web3.js');
  return {
    ...actual,
    Connection: jest.fn().mockImplementation(() => ({
      getVersion: jest.fn().mockResolvedValue({ 'solana-core': '1.18.0' }),
      getAccountInfo: jest.fn().mockResolvedValue(null),
      getTokenLargestAccounts: jest.fn().mockResolvedValue({ value: [] }),
      simulateTransaction: jest.fn().mockResolvedValue({ value: { err: null } })
    }))
  };
});

// Helper function to create mock PumpToken
export const createMockPumpToken = (overrides: any = {}) => ({
  mint: 'So11111111111111111111111111111111111111112',
  creator: 'Creator1111111111111111111111111111111111',
  pool: 'pump',
  simulatedLp: 1.5,
  hasJupiterRoute: true,
  lpTokenAddress: 'LP111111111111111111111111111111111111111',
  earlyHolders: 100,
  launchSpeedSeconds: 60,
  metadata: {
    name: 'Test Token',
    symbol: 'TEST',
    decimals: 9
  },
  ...overrides
});

// Helper function to create mock wallet
export const createMockWallet = () => ({
  publicKey: {
    toBase58: () => 'MockWallet1111111111111111111111111111',
    equals: jest.fn().mockReturnValue(false)
  },
  secretKey: new Uint8Array(64)
});

// Clean up after each test
afterEach(() => {
  jest.clearAllMocks();
});