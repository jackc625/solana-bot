import { normalizeMint } from '../../src/utils/normalizeMint';

describe('normalizeMint', () => {
  const validMint = 'So11111111111111111111111111111111111111112'; // SOL mint
  const anotherValidMint = '11111111111111111111111111111111';

  describe('basic functionality', () => {
    test('should return null for empty or invalid inputs', () => {
      expect(normalizeMint('', 'pump')).toBeNull();
      expect(normalizeMint('   ', 'pump')).toBeNull();
      expect(normalizeMint('invalid_mint', 'pump')).toBeNull();
    });

    test('should return valid mint address as-is when no delimiter present', () => {
      expect(normalizeMint(validMint, 'pump')).toBe(validMint);
      expect(normalizeMint(anotherValidMint, 'raydium')).toBe(anotherValidMint);
    });

    test('should handle null/undefined inputs gracefully', () => {
      expect(normalizeMint(null as any, 'pump')).toBeNull();
      expect(normalizeMint(undefined as any, 'pump')).toBeNull();
    });
  });

  describe('delimiter handling', () => {
    test('should split on pipe delimiter when pool suffix matches', () => {
      const input = `${validMint}|pump`;
      expect(normalizeMint(input, 'pump')).toBe(validMint);
    });

    test('should split on colon delimiter when pool suffix matches', () => {
      const input = `${validMint}:raydium`;
      expect(normalizeMint(input, 'raydium')).toBe(validMint);
    });

    test('should not split when pool suffix does not match', () => {
      const input = `${validMint}|pump`;
      expect(normalizeMint(input, 'raydium')).toBe(input); // Returns original if it's a valid mint
    });

    test('should prefer pipe delimiter over colon', () => {
      const input = `${validMint}|pump:other`;
      expect(normalizeMint(input, 'pump')).toBe(validMint);
    });

    test('should handle multiple delimiters correctly', () => {
      const input = `${validMint}|pump|extra`;
      expect(normalizeMint(input, 'pump')).toBe(validMint);
    });
  });

  describe('validation', () => {
    test('should validate mint address format', () => {
      // Valid base58 but invalid length
      expect(normalizeMint('abc123', 'pump')).toBeNull();

      // Invalid characters
      expect(normalizeMint('So111111111111111111111111111111111111111O', 'pump')).toBeNull();
    });

    test('should return normalized base58 representation', () => {
      // This tests that the PublicKey constructor normalizes the format
      const result = normalizeMint(validMint, 'pump');
      expect(result).toBe(validMint);
      expect(typeof result).toBe('string');
    });
  });

  describe('edge cases', () => {
    test('should handle whitespace correctly', () => {
      const input = `  ${validMint}|pump  `;
      expect(normalizeMint(input, 'pump')).toBe(validMint);
    });

    test('should handle empty pool parameter', () => {
      const input = `${validMint}|`;
      expect(normalizeMint(input, '')).toBe(validMint);
    });

    test('should handle case sensitivity in pool names', () => {
      const input = `${validMint}|pump`;
      expect(normalizeMint(input, 'PUMP')).toBe(input); // Should not match
      expect(normalizeMint(input, 'pump')).toBe(validMint); // Should match
    });

    test('should handle delimiters without suffixes', () => {
      const input = `${validMint}|`;
      expect(normalizeMint(input, 'pump')).toBe(input); // No matching suffix
    });
  });

  describe('real-world scenarios', () => {
    test('should handle pump.fun token format', () => {
      const pumpToken = `${validMint}|pump`;
      expect(normalizeMint(pumpToken, 'pump')).toBe(validMint);
    });

    test('should handle raydium token format', () => {
      const raydiumToken = `${validMint}:raydium`;
      expect(normalizeMint(raydiumToken, 'raydium')).toBe(validMint);
    });

    test('should handle bonk curve tokens', () => {
      // For curve pools, normalization should be skipped, but if called it should work
      const bonkToken = `${validMint}|bonk`;
      expect(normalizeMint(bonkToken, 'bonk')).toBe(validMint);
    });

    test('should handle tokens without pool suffixes', () => {
      // Direct mint addresses should pass through
      expect(normalizeMint(validMint, 'pump')).toBe(validMint);
    });
  });
});
