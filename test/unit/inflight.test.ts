import { begin, end, isInflight } from '../../src/state/inflight';

describe('inflight state management', () => {
  const testMint = 'So11111111111111111111111111111111111111112';
  const anotherMint = '11111111111111111111111111111111';

  beforeEach(() => {
    // Clean up any existing inflight operations before each test
    // Since the module uses a Set, we need to clear operations we might have started
    end(testMint, 'buy');
    end(testMint, 'sell');
    end(anotherMint, 'buy');
    end(anotherMint, 'sell');
  });

  describe('begin operation', () => {
    test('should allow starting a new operation', () => {
      expect(begin(testMint, 'buy')).toBe(true);
      expect(isInflight(testMint, 'buy')).toBe(true);
    });

    test('should prevent duplicate operations for same mint/side', () => {
      expect(begin(testMint, 'buy')).toBe(true);
      expect(begin(testMint, 'buy')).toBe(false); // Second attempt should fail
    });

    test('should allow different sides for same mint', () => {
      expect(begin(testMint, 'buy')).toBe(true);
      expect(begin(testMint, 'sell')).toBe(true);

      expect(isInflight(testMint, 'buy')).toBe(true);
      expect(isInflight(testMint, 'sell')).toBe(true);
    });

    test('should allow same side for different mints', () => {
      expect(begin(testMint, 'buy')).toBe(true);
      expect(begin(anotherMint, 'buy')).toBe(true);

      expect(isInflight(testMint, 'buy')).toBe(true);
      expect(isInflight(anotherMint, 'buy')).toBe(true);
    });
  });

  describe('end operation', () => {
    test('should end an active operation', () => {
      begin(testMint, 'buy');
      expect(isInflight(testMint, 'buy')).toBe(true);

      end(testMint, 'buy');
      expect(isInflight(testMint, 'buy')).toBe(false);
    });

    test('should handle ending non-existent operation gracefully', () => {
      expect(isInflight(testMint, 'buy')).toBe(false);

      // Should not throw
      expect(() => end(testMint, 'buy')).not.toThrow();
      expect(isInflight(testMint, 'buy')).toBe(false);
    });

    test('should only end the specific mint/side combination', () => {
      begin(testMint, 'buy');
      begin(testMint, 'sell');
      begin(anotherMint, 'buy');

      end(testMint, 'buy');

      expect(isInflight(testMint, 'buy')).toBe(false);
      expect(isInflight(testMint, 'sell')).toBe(true);
      expect(isInflight(anotherMint, 'buy')).toBe(true);
    });

    test('should allow restarting after ending', () => {
      begin(testMint, 'buy');
      end(testMint, 'buy');

      expect(begin(testMint, 'buy')).toBe(true);
      expect(isInflight(testMint, 'buy')).toBe(true);
    });
  });

  describe('isInflight query', () => {
    test('should return false for non-existent operations', () => {
      expect(isInflight(testMint, 'buy')).toBe(false);
      expect(isInflight(testMint, 'sell')).toBe(false);
    });

    test('should return true for active operations', () => {
      begin(testMint, 'buy');
      expect(isInflight(testMint, 'buy')).toBe(true);
    });

    test('should be side-specific', () => {
      begin(testMint, 'buy');

      expect(isInflight(testMint, 'buy')).toBe(true);
      expect(isInflight(testMint, 'sell')).toBe(false);
    });

    test('should be mint-specific', () => {
      begin(testMint, 'buy');

      expect(isInflight(testMint, 'buy')).toBe(true);
      expect(isInflight(anotherMint, 'buy')).toBe(false);
    });
  });

  describe('concurrent operations', () => {
    test('should handle multiple simultaneous operations', () => {
      // Start multiple operations
      expect(begin(testMint, 'buy')).toBe(true);
      expect(begin(testMint, 'sell')).toBe(true);
      expect(begin(anotherMint, 'buy')).toBe(true);
      expect(begin(anotherMint, 'sell')).toBe(true);

      // All should be active
      expect(isInflight(testMint, 'buy')).toBe(true);
      expect(isInflight(testMint, 'sell')).toBe(true);
      expect(isInflight(anotherMint, 'buy')).toBe(true);
      expect(isInflight(anotherMint, 'sell')).toBe(true);

      // End some operations
      end(testMint, 'buy');
      end(anotherMint, 'sell');

      // Check final state
      expect(isInflight(testMint, 'buy')).toBe(false);
      expect(isInflight(testMint, 'sell')).toBe(true);
      expect(isInflight(anotherMint, 'buy')).toBe(true);
      expect(isInflight(anotherMint, 'sell')).toBe(false);
    });
  });

  describe('edge cases', () => {
    test('should handle empty mint addresses', () => {
      expect(begin('', 'buy')).toBe(true);
      expect(isInflight('', 'buy')).toBe(true);
      end('', 'buy');
      expect(isInflight('', 'buy')).toBe(false);
    });

    test('should handle special characters in mint', () => {
      const specialMint = 'test:mint|with:special:chars';
      expect(begin(specialMint, 'buy')).toBe(true);
      expect(isInflight(specialMint, 'buy')).toBe(true);
    });

    test('should ensure key uniqueness', () => {
      // Test that the internal key function creates unique keys
      const mint1 = 'mint1:buy';
      const mint2 = 'mint1';

      expect(begin(mint1, 'sell')).toBe(true);
      expect(begin(mint2, 'buy')).toBe(true); // Should not conflict

      expect(isInflight(mint1, 'sell')).toBe(true);
      expect(isInflight(mint2, 'buy')).toBe(true);
    });
  });
});
