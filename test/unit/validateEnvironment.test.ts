import { validateEnvironment } from '../../src/utils/validateEnvironment';

describe('validateEnvironment', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment before each test
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('required environment variables', () => {
    test('should pass validation when all required vars are present', () => {
      process.env.PRIVATE_KEY = 'So11111111111111111111111111111111111111112'; // Valid base58
      process.env.RPC_URL = 'https://api.mainnet-beta.solana.com';

      const result = validateEnvironment();

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('should fail when PRIVATE_KEY is missing', () => {
      delete process.env.PRIVATE_KEY;
      process.env.RPC_URL = 'https://api.mainnet-beta.solana.com';

      const result = validateEnvironment();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        expect.stringContaining('Missing required environment variable: PRIVATE_KEY'),
      );
    });

    test('should fail when RPC_URL is missing', () => {
      process.env.PRIVATE_KEY = 'So11111111111111111111111111111111111111112';
      delete process.env.RPC_URL;

      const result = validateEnvironment();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        expect.stringContaining('Missing required environment variable: RPC_URL'),
      );
    });

    test('should fail when both required vars are missing', () => {
      delete process.env.PRIVATE_KEY;
      delete process.env.RPC_URL;

      const result = validateEnvironment();

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
      expect(result.errors).toContain(expect.stringContaining('PRIVATE_KEY'));
      expect(result.errors).toContain(expect.stringContaining('RPC_URL'));
    });
  });

  describe('PRIVATE_KEY validation', () => {
    beforeEach(() => {
      process.env.RPC_URL = 'https://api.mainnet-beta.solana.com';
    });

    test('should reject non-base58 private keys', () => {
      process.env.PRIVATE_KEY = 'invalid_base58_!@#$%^&*()';

      const result = validateEnvironment();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        expect.stringContaining('PRIVATE_KEY is not valid base58 encoding'),
      );
    });

    test('should reject private keys with wrong length', () => {
      // Valid base58 but wrong length (too short)
      process.env.PRIVATE_KEY = 'So111111111111111111111111111111111111111';

      const result = validateEnvironment();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        expect.stringContaining('PRIVATE_KEY must be 64 bytes when decoded'),
      );
    });

    test('should accept valid 64-byte base58 private key', () => {
      // Generate a valid 64-byte base58 string for testing
      const validKey =
        'So11111111111111111111111111111111111111112So11111111111111111111111111111111111111112'; // 88 chars base58 = ~64 bytes
      process.env.PRIVATE_KEY = validKey;

      const result = validateEnvironment();

      // May still have errors but not for private key format
      const privateKeyErrors = result.errors.filter((err) => err.includes('PRIVATE_KEY'));
      expect(privateKeyErrors).toHaveLength(0);
    });
  });

  describe('RPC_URL validation', () => {
    beforeEach(() => {
      process.env.PRIVATE_KEY =
        'So11111111111111111111111111111111111111112So11111111111111111111111111111111111111112';
    });

    test('should accept valid HTTPS URLs', () => {
      process.env.RPC_URL = 'https://api.mainnet-beta.solana.com';

      const result = validateEnvironment();

      const rpcErrors = result.errors.filter((err) => err.includes('RPC_URL'));
      expect(rpcErrors).toHaveLength(0);
    });

    test('should accept valid HTTP URLs', () => {
      process.env.RPC_URL = 'http://localhost:8899';

      const result = validateEnvironment();

      const rpcErrors = result.errors.filter((err) => err.includes('RPC_URL'));
      expect(rpcErrors).toHaveLength(0);
    });

    test('should reject invalid URL format', () => {
      process.env.RPC_URL = 'not-a-valid-url';

      const result = validateEnvironment();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(expect.stringContaining('RPC_URL is not a valid URL'));
    });

    test('should reject unsupported protocols', () => {
      process.env.RPC_URL = 'ftp://example.com';

      const result = validateEnvironment();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        expect.stringContaining('RPC_URL must use http or https protocol'),
      );
    });

    test('should reject websocket URLs', () => {
      process.env.RPC_URL = 'ws://api.mainnet-beta.solana.com';

      const result = validateEnvironment();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        expect.stringContaining('RPC_URL must use http or https protocol'),
      );
    });
  });

  describe('optional environment variables', () => {
    beforeEach(() => {
      process.env.PRIVATE_KEY =
        'So11111111111111111111111111111111111111112So11111111111111111111111111111111111111112';
      process.env.RPC_URL = 'https://api.mainnet-beta.solana.com';
    });

    test('should not error when optional vars are missing', () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;

      const result = validateEnvironment();

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('should warn about partial Telegram configuration', () => {
      process.env.TELEGRAM_BOT_TOKEN = 'bot_token';
      delete process.env.TELEGRAM_CHAT_ID;

      const result = validateEnvironment();

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain(
        expect.stringContaining('Partial Telegram configuration detected'),
      );
    });

    test('should warn about partial Telegram configuration (other way)', () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      process.env.TELEGRAM_CHAT_ID = '12345';

      const result = validateEnvironment();

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain(
        expect.stringContaining('Partial Telegram configuration detected'),
      );
    });

    test('should not warn when both Telegram vars are present', () => {
      process.env.TELEGRAM_BOT_TOKEN = 'bot_token';
      process.env.TELEGRAM_CHAT_ID = '12345';

      const result = validateEnvironment();

      expect(result.valid).toBe(true);
      const telegramWarnings = result.warnings.filter((w) => w.includes('Telegram'));
      expect(telegramWarnings).toHaveLength(0);
    });

    test('should warn when NODE_ENV is not set', () => {
      delete process.env.NODE_ENV;

      const result = validateEnvironment();

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain(expect.stringContaining('NODE_ENV not set'));
    });

    test('should not warn when NODE_ENV is set', () => {
      process.env.NODE_ENV = 'production';

      const result = validateEnvironment();

      const nodeEnvWarnings = result.warnings.filter((w) => w.includes('NODE_ENV'));
      expect(nodeEnvWarnings).toHaveLength(0);
    });
  });

  describe('validation result structure', () => {
    test('should return proper structure with valid config', () => {
      process.env.PRIVATE_KEY =
        'So11111111111111111111111111111111111111112So11111111111111111111111111111111111111112';
      process.env.RPC_URL = 'https://api.mainnet-beta.solana.com';
      process.env.NODE_ENV = 'production';

      const result = validateEnvironment();

      expect(result).toHaveProperty('valid');
      expect(result).toHaveProperty('errors');
      expect(result).toHaveProperty('warnings');
      expect(Array.isArray(result.errors)).toBe(true);
      expect(Array.isArray(result.warnings)).toBe(true);
    });

    test('should set valid to false when there are errors', () => {
      delete process.env.PRIVATE_KEY;
      process.env.RPC_URL = 'https://api.mainnet-beta.solana.com';

      const result = validateEnvironment();

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test('should set valid to true when there are only warnings', () => {
      process.env.PRIVATE_KEY =
        'So11111111111111111111111111111111111111112So11111111111111111111111111111111111111112';
      process.env.RPC_URL = 'https://api.mainnet-beta.solana.com';
      delete process.env.NODE_ENV;

      const result = validateEnvironment();

      expect(result.valid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });
});
