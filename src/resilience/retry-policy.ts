import { computeBackoffDelay, type BackoffOptions, type RandomSource } from './backoff.js';

export interface RetryPolicy {
  /** Total upstream attempts allowed, including the first. */
  maxAttempts: number;
  backoff: BackoffOptions;
  /**
   * Largest server-requested `Retry-After` we are willing to wait. A longer request means the
   * carrier will not serve us within this job's budget, so we stop instead of hammering it early.
   */
  maxRetryAfterMs: number;
  /**
   * Extra positive jitter added on top of Retry-After, as a fraction of it. Many jobs that saw
   * the same Retry-After would otherwise retry in lockstep. Retry-After is a minimum, so only
   * positive jitter is safe.
   */
  retryAfterJitterRatio?: number;
}

export type TerminalReason =
  | 'non_retryable'
  | 'attempts_exhausted'
  | 'retry_after_exceeds_limit'
  | 'deadline_exceeded';

export type RetryDecision =
  | { retry: true; delayMs: number; basis: 'backoff' | 'retry_after' }
  | { retry: false; reason: TerminalReason };

export interface RetryInput {
  /** Number of attempts made so far, including the one that just failed (>= 1). */
  attemptsMade: number;
  error: { retryable: boolean; retryAfterMs?: number | undefined };
  policy: RetryPolicy;
  now: number;
  deadlineAt?: number | undefined;
  random?: RandomSource;
}

/**
 * Pure retry decision. Given the failed attempt and the policy, either schedules the next
 * attempt or explains why the job must stop. Ordering matters: permanent errors stop first,
 * then the attempt budget, then server-imposed waits, then the job deadline.
 */
export function decideRetry(input: RetryInput): RetryDecision {
  const { attemptsMade, error, policy, now, deadlineAt } = input;
  const random = input.random ?? Math.random;

  if (!error.retryable) return { retry: false, reason: 'non_retryable' };
  if (attemptsMade >= policy.maxAttempts) return { retry: false, reason: 'attempts_exhausted' };

  const backoffMs = computeBackoffDelay(attemptsMade, policy.backoff, random);
  let delayMs = backoffMs;
  let basis: 'backoff' | 'retry_after' = 'backoff';

  if (error.retryAfterMs !== undefined) {
    if (error.retryAfterMs > policy.maxRetryAfterMs) {
      return { retry: false, reason: 'retry_after_exceeds_limit' };
    }
    const jitter = Math.floor(
      error.retryAfterMs * (policy.retryAfterJitterRatio ?? 0.1) * random(),
    );
    const serverDelay = error.retryAfterMs + jitter;
    if (serverDelay >= backoffMs) {
      delayMs = serverDelay;
      basis = 'retry_after';
    }
  }

  if (deadlineAt !== undefined && now + delayMs > deadlineAt) {
    return { retry: false, reason: 'deadline_exceeded' };
  }
  return { retry: true, delayMs, basis };
}
