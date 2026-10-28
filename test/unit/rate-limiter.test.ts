import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InMemoryTokenBucket,
  acquireWithinBudget,
  takeToken,
} from '../../src/resilience/rate-limiter.js';

const config = { capacity: 3, refillPerSecond: 10 }; // one token every 100ms

describe('takeToken', () => {
  it('allows bursts up to capacity, then reports when the next token arrives', () => {
    let state = { tokens: 3, updatedAt: 0 };
    const decisions = [];
    for (let i = 0; i < 4; i += 1) {
      const step = takeToken(state, 0, config);
      state = step.state;
      decisions.push(step.decision);
    }
    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false]);
    expect(decisions[3]!.retryAfterMs).toBe(100);
  });

  it('refills continuously and never above capacity', () => {
    const step = takeToken({ tokens: 0, updatedAt: 0 }, 10_000, config);
    expect(step.decision.allowed).toBe(true);
    expect(step.state.tokens).toBe(2);
  });

  it('computes partial-token waits', () => {
    const step = takeToken({ tokens: 0.25, updatedAt: 0 }, 0, config);
    expect(step.decision).toEqual({ allowed: false, retryAfterMs: 75, remaining: 0 });
  });

  it('rejects invalid configuration', () => {
    expect(() =>
      takeToken({ tokens: 0, updatedAt: 0 }, 0, { capacity: 0, refillPerSecond: 1 }),
    ).toThrow();
    expect(() =>
      takeToken({ tokens: 0, updatedAt: 0 }, 0, { capacity: 1, refillPerSecond: 0 }),
    ).toThrow();
  });
});

describe('InMemoryTokenBucket', () => {
  it('enforces the sustained rate over time', async () => {
    let now = 0;
    const bucket = new InMemoryTokenBucket(config, () => now);
    let granted = 0;
    // Try 100 times per simulated second for 2 seconds.
    for (let tick = 0; tick < 200; tick += 1) {
      if ((await bucket.tryAcquire()).allowed) granted += 1;
      now += 10;
    }
    // Burst of 3 plus ~10/s for 2s.
    expect(granted).toBeGreaterThanOrEqual(22);
    expect(granted).toBeLessThanOrEqual(23);
  });
});

describe('acquireWithinBudget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  it('acquires immediately when a token is available', async () => {
    const bucket = new InMemoryTokenBucket(config, () => Date.now());
    await expect(acquireWithinBudget(bucket, 500, sleep)).resolves.toEqual({
      acquired: true,
      waitedMs: 0,
    });
  });

  it('waits in-process for a token that arrives within the budget', async () => {
    const bucket = new InMemoryTokenBucket(config, () => Date.now());
    for (let i = 0; i < 3; i += 1) await bucket.tryAcquire();
    const pending = acquireWithinBudget(bucket, 500, sleep);
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual({ acquired: true, waitedMs: 100 });
  });

  it('gives up (so the job can be deferred) when the wait would exceed the budget', async () => {
    const slow = new InMemoryTokenBucket({ capacity: 1, refillPerSecond: 1 }, () => Date.now());
    await slow.tryAcquire();
    await expect(acquireWithinBudget(slow, 200, sleep)).resolves.toEqual({
      acquired: false,
      waitedMs: 0,
      retryAfterMs: 1000,
    });
  });
});
