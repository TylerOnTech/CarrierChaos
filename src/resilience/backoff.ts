/**
 * Exponential backoff with jitter.
 *
 * `retryNumber` is 1 for the first retry (i.e. after the first failed attempt).
 * The un-jittered delay is `min(maxDelayMs, baseDelayMs * multiplier^(retryNumber - 1))`.
 *
 * Jitter strategies (see the AWS Architecture Blog, "Exponential Backoff And Jitter"):
 * - `full`:  uniform in [0, delay]. Best at de-synchronizing clients, but can retry almost
 *            immediately.
 * - `equal`: delay/2 + uniform in [0, delay/2]. Keeps a guaranteed, growing floor, so
 *            consecutive retries always back off. This is the default.
 * - `none`:  deterministic delay (useful for tests and reasoning).
 */
export type JitterStrategy = 'none' | 'full' | 'equal';

export interface BackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  multiplier?: number;
  jitter?: JitterStrategy;
}

/** Returns a number in [0, 1). Injected so tests can be deterministic. */
export type RandomSource = () => number;

export function exponentialDelay(retryNumber: number, options: BackoffOptions): number {
  validate(retryNumber, options);
  const multiplier = options.multiplier ?? 2;
  const raw = options.baseDelayMs * Math.pow(multiplier, retryNumber - 1);
  // Large retry numbers overflow to Infinity; the cap still applies.
  if (!Number.isFinite(raw)) return options.maxDelayMs;
  return Math.min(options.maxDelayMs, raw);
}

export function computeBackoffDelay(
  retryNumber: number,
  options: BackoffOptions,
  random: RandomSource = Math.random,
): number {
  const ceiling = exponentialDelay(retryNumber, options);
  switch (options.jitter ?? 'equal') {
    case 'none':
      return Math.round(ceiling);
    case 'full':
      return Math.floor(random() * (ceiling + 1));
    case 'equal': {
      const half = ceiling / 2;
      return Math.floor(half + random() * (half + 1));
    }
  }
}

function validate(retryNumber: number, options: BackoffOptions): void {
  if (!Number.isInteger(retryNumber) || retryNumber < 1) {
    throw new RangeError(`retryNumber must be an integer >= 1, got ${retryNumber}`);
  }
  if (options.baseDelayMs < 0 || options.maxDelayMs < 0) {
    throw new RangeError('delays must be non-negative');
  }
  if (options.maxDelayMs < options.baseDelayMs) {
    throw new RangeError('maxDelayMs must be >= baseDelayMs');
  }
  if ((options.multiplier ?? 2) < 1) {
    throw new RangeError('multiplier must be >= 1');
  }
}
