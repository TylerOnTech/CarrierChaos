import { describe, expect, it } from 'vitest';
import { decideRetry, type RetryPolicy } from '../../src/resilience/retry-policy.js';

const policy: RetryPolicy = {
  maxAttempts: 4,
  backoff: { baseDelayMs: 100, maxDelayMs: 2000, jitter: 'none' },
  maxRetryAfterMs: 10_000,
  retryAfterJitterRatio: 0,
};
const now = 1_000_000;
const transient = { retryable: true };

describe('decideRetry', () => {
  it('never retries a non-retryable error, even on the first attempt', () => {
    expect(decideRetry({ attemptsMade: 1, error: { retryable: false }, policy, now })).toEqual({
      retry: false,
      reason: 'non_retryable',
    });
  });

  it('backs off exponentially for transient errors', () => {
    const delays = [1, 2, 3].map((attemptsMade) => {
      const decision = decideRetry({ attemptsMade, error: transient, policy, now });
      return decision.retry ? decision.delayMs : null;
    });
    expect(delays).toEqual([100, 200, 400]);
  });

  it('stops when the attempt budget is spent', () => {
    expect(decideRetry({ attemptsMade: 4, error: transient, policy, now })).toEqual({
      retry: false,
      reason: 'attempts_exhausted',
    });
  });

  it('honors Retry-After when it is longer than the backoff', () => {
    const decision = decideRetry({
      attemptsMade: 1,
      error: { retryable: true, retryAfterMs: 3000 },
      policy,
      now,
    });
    expect(decision).toEqual({ retry: true, delayMs: 3000, basis: 'retry_after' });
  });

  it('keeps the backoff when Retry-After is shorter', () => {
    const decision = decideRetry({
      attemptsMade: 3,
      error: { retryable: true, retryAfterMs: 50 },
      policy,
      now,
    });
    expect(decision).toEqual({ retry: true, delayMs: 400, basis: 'backoff' });
  });

  it('adds only positive jitter on top of Retry-After', () => {
    const decision = decideRetry({
      attemptsMade: 1,
      error: { retryable: true, retryAfterMs: 1000 },
      policy: { ...policy, retryAfterJitterRatio: 0.1 },
      now,
      random: () => 0.999,
    });
    expect(decision.retry && decision.delayMs).toBe(1099);
  });

  it('gives up when the server asks us to wait longer than we allow', () => {
    expect(
      decideRetry({
        attemptsMade: 1,
        error: { retryable: true, retryAfterMs: 60_000 },
        policy,
        now,
      }),
    ).toEqual({ retry: false, reason: 'retry_after_exceeds_limit' });
  });

  it('stops when the next attempt would land after the job deadline', () => {
    expect(
      decideRetry({ attemptsMade: 2, error: transient, policy, now, deadlineAt: now + 150 }),
    ).toEqual({ retry: false, reason: 'deadline_exceeded' });
    expect(
      decideRetry({ attemptsMade: 2, error: transient, policy, now, deadlineAt: now + 250 }),
    ).toMatchObject({ retry: true, delayMs: 200 });
  });
});
