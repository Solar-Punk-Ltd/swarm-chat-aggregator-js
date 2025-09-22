import { describe, expect, it } from 'vitest';

describe('Basic Test Suite', () => {
  it('should validate that Vitest configuration is working', () => {
    expect(1 + 1).toBe(2);
  });

  it('should have access to Node.js environment', () => {
    expect(process.env).toBeDefined();
    expect(typeof process.version).toBe('string');
  });

  it('should support async/await', async () => {
    const result = await Promise.resolve('test');
    expect(result).toBe('test');
  });
});
