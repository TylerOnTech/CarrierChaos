import { describe, expect, it } from 'vitest';
import { computeBackoffDelay, exponentialDelay } from '../../src/resilience/backoff.js';

const options = { baseDelayMs: 100, maxDelayMs: 5000 };

describe('exponentialDelay', () => {
  it('doubles from the base delay for each retry', () => {
    expect([1, 2, 3, 4, 5].map((n) => exponentialDelay(n, options))).toEqual([
      100, 200, 400, 800, 1600,
    ]);
  });

  it('is capped at maxDelayMs', () => {
    expect(exponentialDelay(7, options)).toBe(5000);
    expect(exponentialDelay(50, options)).toBe(5000);
  });

  it('does not overflow for absurd retry numbers', () => {
    expect(exponentialDelay(10_000, options)).toBe(5000);
  });

  it('supports a custom multiplier', () => {
    expect(exponentialDelay(3, { ...options, multiplier: 3 })).toBe(900);
  });

  it('rejects invalid input', () => {
    expect(() => exponentialDelay(0, options)).toThrow(RangeError);
    expect(() => exponentialDelay(1.5, options)).toThrow(RangeError);
    expect(() => exponentialDelay(1, { baseDelayMs: 200, maxDelayMs: 100 })).toThrow(RangeError);
    expect(() => exponentialDelay(1, { ...options, multiplier: 0.5 })).toThrow(RangeError);
  });
});

describe('computeBackoffDelay', () => {
  it('without jitter equals the exponential delay', () => {
    expect(computeBackoffDelay(3, { ...options, jitter: 'none' })).toBe(400);
  });

  it('full jitter stays within [0, ceiling]', () => {
    expect(computeBackoffDelay(3, { ...options, jitter: 'full' }, () => 0)).toBe(0);
    expect(computeBackoffDelay(3, { ...options, jitter: 'full' }, () => 0.999999)).toBe(400);
    for (let i = 0; i < 1000; i += 1) {
      const delay = computeBackoffDelay(4, { ...options, jitter: 'full' });
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(800);
    }
  });

  it('equal jitter keeps a floor of half the ceiling', () => {
    expect(computeBackoffDelay(3, { ...options, jitter: 'equal' }, () => 0)).toBe(200);
    expect(computeBackoffDelay(3, { ...options, jitter: 'equal' }, () => 0.999999)).toBe(400);
    for (let i = 0; i < 1000; i += 1) {
      const delay = computeBackoffDelay(4, { ...options, jitter: 'equal' });
      expect(delay).toBeGreaterThanOrEqual(400);
      expect(delay).toBeLessThanOrEqual(800);
    }
  });

  it('equal jitter grows progressively: every retry waits at least as long as the previous floor', () => {
    const floors = [1, 2, 3, 4, 5].map((n) =>
      computeBackoffDelay(n, { ...options, jitter: 'equal' }, () => 0),
    );
    const ceilings = [1, 2, 3, 4, 5].map((n) =>
      computeBackoffDelay(n, { ...options, jitter: 'equal' }, () => 0.999999),
    );
    for (let i = 1; i < floors.length; i += 1) {
      expect(floors[i]).toBeGreaterThanOrEqual(ceilings[i - 1]!);
    }
  });

  it('defaults to equal jitter', () => {
    expect(computeBackoffDelay(2, options, () => 0)).toBe(100);
  });
});
