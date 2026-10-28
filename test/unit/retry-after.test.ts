import { describe, expect, it } from 'vitest';
import { parseRetryAfter } from '../../src/resilience/retry-after.js';

const now = Date.parse('2026-01-15T12:00:00Z');

describe('parseRetryAfter', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfter('0', now)).toBe(0);
    expect(parseRetryAfter('3', now)).toBe(3000);
    expect(parseRetryAfter(' 120 ', now)).toBe(120_000);
  });

  it('tolerates fractional seconds', () => {
    expect(parseRetryAfter('1.5', now)).toBe(1500);
  });

  it('parses an HTTP-date relative to now', () => {
    expect(parseRetryAfter('Thu, 15 Jan 2026 12:00:30 GMT', now)).toBe(30_000);
  });

  it('clamps dates in the past to zero', () => {
    expect(parseRetryAfter('Thu, 15 Jan 2026 11:59:00 GMT', now)).toBe(0);
  });

  it('returns undefined for missing or invalid values', () => {
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter('', now)).toBeUndefined();
    expect(parseRetryAfter('-5', now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter('1e3', now)).toBeUndefined();
  });
});
