describe('Simple Test Suite', () => {
  test('should run basic arithmetic', () => {
    expect(2 + 2).toBe(4);
  });

  test('should handle string operations', () => {
    const str = 'hello';
    expect(str.toUpperCase()).toBe('HELLO');
  });

  test('should work with arrays', () => {
    const arr = [1, 2, 3];
    expect(arr).toHaveLength(3);
    expect(arr).toContain(2);
  });
});
