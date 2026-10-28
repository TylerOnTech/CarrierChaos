# `src/resilience`: reusable reliability primitives

Framework-agnostic building blocks with no dependency on Express, BullMQ or Prisma
(`redis-token-bucket.ts` needs an `ioredis` client). They are written to be lifted into another
integration engine, such as CarrierBridge, unchanged.

| Module | What it provides |
|---|---|
| `errors.ts` | `ErrorKind` taxonomy, the retryable / breaker-outcome policy table, `CarrierError`, HTTP status mapping |
| `backoff.ts` | Exponential backoff with `none` / `full` / `equal` jitter and an injectable random source |
| `retry-after.ts` | RFC 9110 `Retry-After` parsing (delta-seconds and HTTP-date) |
| `retry-policy.ts` | `decideRetry()`: a pure function from (attempt, error, policy, deadline) to retry-with-delay or a terminal reason |
| `circuit-breaker.ts` | CLOSED/OPEN/HALF_OPEN breaker with a rolling failure-rate window, bounded probes, generation-fenced permits and an injectable clock |
| `rate-limiter.ts` | Pure token-bucket step, an in-memory bucket, and `acquireWithinBudget()` (wait briefly, or tell the caller to defer) |
| `redis-token-bucket.ts` | The same bucket as an atomic Lua script on the Redis server clock, shared across processes |
| `timeout.ts` | `withTimeout()`: hard time limit plus an `AbortSignal`, so cancelled work actually releases its socket |

## Typical composition

```ts
import {
  CircuitBreaker, RedisTokenBucket, acquireWithinBudget, decideRetry, toCarrierError, withTimeout,
} from './resilience/index.js';

const breaker = new CircuitBreaker({
  failureRateThreshold: 0.5, minimumRequests: 10, windowMs: 10_000,
  openDurationMs: 5_000, halfOpenMaxProbes: 2, halfOpenSuccessThreshold: 2,
});
const limiter = new RedisTokenBucket(redis, 'ratelimit:acme', { capacity: 20, refillPerSecond: 50 });

async function callCarrier(attemptsMade: number) {
  const permit = breaker.tryAcquire();
  if (!permit.allowed) return { defer: permit.retryAfterMs };          // no attempt consumed

  const token = await acquireWithinBudget(limiter, 1000, sleep);
  if (!token.acquired) { breaker.release(permit.permit); return { defer: token.retryAfterMs }; }

  try {
    const result = await withTimeout((signal) => fetchFromCarrier(signal), 2000);
    breaker.record(permit.permit, 'success');
    return { result };
  } catch (raw) {
    const error = toCarrierError(raw);                                 // classify once
    breaker.record(permit.permit, error.breakerOutcome);
    return { decision: decideRetry({ attemptsMade, error, policy, now: Date.now() }) };
  }
}
```

`src/worker/processor.ts` is the full version of this pattern, wired to durable job state.
