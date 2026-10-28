/**
 * Token-bucket rate limiting.
 *
 * A bucket holds up to `capacity` tokens (the permitted burst) and refills continuously at
 * `refillPerSecond`. Each upstream request consumes one token. When the bucket is empty the
 * caller is told exactly how long until the next token exists, so it can wait or defer instead
 * of polling.
 */
export interface TokenBucketConfig {
  capacity: number;
  refillPerSecond: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** 0 when allowed; otherwise milliseconds until a token will be available. */
  retryAfterMs: number;
  remaining: number;
}

export interface RateLimiter {
  tryAcquire(): Promise<RateLimitDecision>;
}

export interface BucketState {
  tokens: number;
  updatedAt: number;
}

/**
 * Pure token-bucket step: refills `state` up to `now`, then tries to take one token.
 * The Redis implementation runs the same arithmetic inside a Lua script.
 */
export function takeToken(
  state: BucketState,
  now: number,
  config: TokenBucketConfig,
): { state: BucketState; decision: RateLimitDecision } {
  validateConfig(config);
  const elapsedMs = Math.max(0, now - state.updatedAt);
  const tokens = Math.min(
    config.capacity,
    state.tokens + (elapsedMs * config.refillPerSecond) / 1000,
  );

  if (tokens >= 1) {
    const remaining = tokens - 1;
    return {
      state: { tokens: remaining, updatedAt: now },
      decision: { allowed: true, retryAfterMs: 0, remaining: Math.floor(remaining) },
    };
  }
  const retryAfterMs = Math.ceil(((1 - tokens) * 1000) / config.refillPerSecond);
  return {
    state: { tokens, updatedAt: now },
    decision: { allowed: false, retryAfterMs, remaining: 0 },
  };
}

export class InMemoryTokenBucket implements RateLimiter {
  private state: BucketState;

  constructor(
    private readonly config: TokenBucketConfig,
    private readonly clock: () => number = Date.now,
  ) {
    validateConfig(config);
    this.state = { tokens: config.capacity, updatedAt: clock() };
  }

  tryAcquire(): Promise<RateLimitDecision> {
    const { state, decision } = takeToken(this.state, this.clock(), this.config);
    this.state = state;
    return Promise.resolve(decision);
  }
}

export type AcquireOutcome =
  | { acquired: true; waitedMs: number }
  | { acquired: false; waitedMs: number; retryAfterMs: number };

/**
 * Acquires a token, sleeping in-process for short waits. If the next token is further away
 * than `maxWaitMs` allows, returns `acquired: false` so the caller can release its worker slot
 * and defer the job instead of holding capacity hostage.
 */
export async function acquireWithinBudget(
  limiter: RateLimiter,
  maxWaitMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<AcquireOutcome> {
  let waitedMs = 0;
  for (;;) {
    const decision = await limiter.tryAcquire();
    if (decision.allowed) return { acquired: true, waitedMs };
    if (waitedMs + decision.retryAfterMs > maxWaitMs) {
      return { acquired: false, waitedMs, retryAfterMs: decision.retryAfterMs };
    }
    await sleep(decision.retryAfterMs);
    waitedMs += decision.retryAfterMs;
  }
}

function validateConfig(config: TokenBucketConfig): void {
  if (!(config.capacity >= 1)) throw new RangeError('capacity must be >= 1');
  if (!(config.refillPerSecond > 0)) throw new RangeError('refillPerSecond must be > 0');
}
