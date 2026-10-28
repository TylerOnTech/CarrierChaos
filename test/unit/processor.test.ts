import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CarrierClient } from '../../src/carriers/carrier-client.js';
import { buildSyntheticPolicy } from '../../src/mock-carrier/policy-factory.js';
import { CircuitBreaker } from '../../src/resilience/circuit-breaker.js';
import { CarrierError } from '../../src/resilience/errors.js';
import type { RateLimiter } from '../../src/resilience/rate-limiter.js';
import { silentLogger } from '../../src/shared/logger.js';
import type { Execution, ExecutionStore } from '../../src/worker/execution-store.js';
import { processRetrievalJob, type ProcessorDeps } from '../../src/worker/processor.js';

let now: number;

/** In-memory stand-in for ExecutionStore that records every transition. */
function fakeStore(overrides: Partial<Execution> = {}) {
  const execution: Execution = {
    jobId: 'job-1',
    executionId: 'exec-1',
    carrierId: 'northwind',
    policyId: 'POL-1',
    attempts: 0,
    maxAttempts: 3,
    replayCount: 0,
    deadlineAt: null,
    enqueuedAt: new Date(now),
    lastErrorKind: null,
    firstPickup: true,
    redelivered: false,
    ...overrides,
  };
  const calls: Array<[string, ...unknown[]]> = [];
  const store = {
    claim: vi.fn(async () => ({ type: 'claimed' as const, execution })),
    startAttempt: vi.fn(async () => {
      execution.attempts += 1;
      calls.push(['startAttempt', execution.attempts]);
      return { attemptId: `a${execution.attempts}`, attemptNumber: execution.attempts };
    }),
    complete: vi.fn(async () => {
      calls.push(['complete']);
      return true;
    }),
    scheduleRetry: vi.fn(
      async (_e: Execution, _a: unknown, error: CarrierError, delayMs: number) => {
        calls.push(['scheduleRetry', error.kind, delayMs]);
        return 'ok' as const;
      },
    ),
    defer: vi.fn(async (_e: Execution, reason: string, delayMs: number) => {
      calls.push(['defer', reason, delayMs]);
      return 'ok' as const;
    }),
    finalizeFailure: vi.fn(
      async (_e: Execution, outcome: { status: string; reason: string; errorKind: unknown }) => {
        calls.push(['finalize', outcome.status, outcome.reason, outcome.errorKind]);
        return true;
      },
    ),
  };
  return { store, calls, execution };
}

function setup(
  options: {
    fetchPolicy?: () => Promise<unknown>;
    limiter?: RateLimiter;
    execution?: Partial<Execution>;
  } = {},
) {
  const { store, calls, execution } = fakeStore(options.execution);
  const breaker = new CircuitBreaker({
    failureRateThreshold: 0.5,
    minimumRequests: 2,
    windowMs: 10_000,
    openDurationMs: 1000,
    halfOpenMaxProbes: 1,
    halfOpenSuccessThreshold: 1,
    clock: () => now,
  });
  const client = {
    fetchPolicy: vi.fn(
      options.fetchPolicy ?? (async () => buildSyntheticPolicy('northwind', 'POL-1')),
    ),
  };
  const deps: ProcessorDeps = {
    store: store as unknown as ExecutionStore,
    resources: () => ({
      client: client as unknown as CarrierClient,
      breaker,
      rateLimiter: options.limiter ?? {
        tryAcquire: async () => ({ allowed: true, retryAfterMs: 0, remaining: 1 }),
      },
    }),
    retryPolicy: {
      maxAttempts: 3,
      backoff: { baseDelayMs: 100, maxDelayMs: 1000, jitter: 'none' },
      maxRetryAfterMs: 5000,
      retryAfterJitterRatio: 0,
    },
    rateLimitMaxWaitMs: 50,
    clock: () => now,
    random: () => 0,
    sleep: async (ms) => {
      now += ms;
    },
    logger: silentLogger(),
  };
  return { deps, store, calls, breaker, client, execution };
}

function tripBreaker(breaker: CircuitBreaker) {
  for (let i = 0; i < 2; i += 1) {
    const r = breaker.tryAcquire();
    if (r.allowed) breaker.record(r.permit, 'failure');
  }
  expect(breaker.currentState()).toBe('OPEN');
}

beforeEach(() => {
  now = 1_000_000;
});

describe('processRetrievalJob', () => {
  it('completes on success and records the success with the breaker', async () => {
    const { deps, calls, breaker } = setup();
    await expect(processRetrievalJob('job-1', deps)).resolves.toEqual({
      type: 'completed',
      attempts: 1,
    });
    expect(calls).toEqual([['startAttempt', 1], ['complete']]);
    expect(breaker.snapshot().windowRequests).toBe(1);
  });

  it('schedules a retry with exponential backoff for a transient failure', async () => {
    const { deps, calls } = setup({
      fetchPolicy: async () => {
        throw new CarrierError('UPSTREAM_ERROR', 'boom', { status: 500 });
      },
    });
    await expect(processRetrievalJob('job-1', deps)).resolves.toMatchObject({
      type: 'retry_scheduled',
      delayMs: 100,
    });
    expect(calls).toContainEqual(['scheduleRetry', 'UPSTREAM_ERROR', 100]);
  });

  it('honors Retry-After when scheduling the retry', async () => {
    const { deps, calls } = setup({
      fetchPolicy: async () => {
        throw new CarrierError('RATE_LIMITED', 'slow down', { status: 429, retryAfterMs: 2000 });
      },
    });
    await processRetrievalJob('job-1', deps);
    expect(calls).toContainEqual(['scheduleRetry', 'RATE_LIMITED', 2000]);
  });

  it('fails permanently, without retrying, on a non-retryable error', async () => {
    const { deps, calls, client } = setup({
      fetchPolicy: async () => {
        throw new CarrierError('NOT_FOUND', 'missing', { status: 404 });
      },
    });
    await expect(processRetrievalJob('job-1', deps)).resolves.toMatchObject({
      type: 'failed',
      reason: 'non_retryable',
    });
    expect(calls).toContainEqual(['finalize', 'failed', 'non_retryable', 'NOT_FOUND']);
    expect(client.fetchPolicy).toHaveBeenCalledTimes(1);
  });

  it('dead-letters once the attempt budget is exhausted', async () => {
    const { deps, calls } = setup({
      execution: { attempts: 2 },
      fetchPolicy: async () => {
        throw new CarrierError('TIMEOUT', 'slow');
      },
    });
    await expect(processRetrievalJob('job-1', deps)).resolves.toMatchObject({
      type: 'dead_lettered',
      reason: 'attempts_exhausted',
    });
    expect(calls).toContainEqual(['finalize', 'dead_lettered', 'attempts_exhausted', 'TIMEOUT']);
  });

  it('defers without an attempt while the circuit is open', async () => {
    const { deps, calls, breaker, client } = setup();
    tripBreaker(breaker);
    now += 400;
    const outcome = await processRetrievalJob('job-1', deps);
    expect(outcome).toMatchObject({ type: 'deferred', reason: 'circuit_open' });
    expect(outcome.type === 'deferred' && outcome.delayMs).toBeGreaterThanOrEqual(600);
    expect(client.fetchPolicy).not.toHaveBeenCalled();
    expect(calls.map((c) => c[0])).toEqual(['defer']);
  });

  it('dead-letters instead of deferring past the job deadline', async () => {
    const { deps, calls, breaker } = setup({ execution: { deadlineAt: new Date(now + 500) } });
    tripBreaker(breaker);
    await expect(processRetrievalJob('job-1', deps)).resolves.toMatchObject({
      type: 'dead_lettered',
      reason: 'deadline_exceeded',
      errorKind: 'CIRCUIT_OPEN',
    });
    expect(calls).toEqual([['finalize', 'dead_lettered', 'deadline_exceeded', 'CIRCUIT_OPEN']]);
  });

  it('waits briefly for a rate-limit token, then proceeds', async () => {
    let calls = 0;
    const limiter: RateLimiter = {
      tryAcquire: async () =>
        ++calls === 1
          ? { allowed: false, retryAfterMs: 20, remaining: 0 }
          : { allowed: true, retryAfterMs: 0, remaining: 0 },
    };
    const { deps, store } = setup({ limiter });
    await expect(processRetrievalJob('job-1', deps)).resolves.toMatchObject({ type: 'completed' });
    expect(store.startAttempt).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('defers on a long rate-limit wait and returns its half-open probe slot', async () => {
    const limiter: RateLimiter = {
      tryAcquire: async () => ({ allowed: false, retryAfterMs: 500, remaining: 0 }),
    };
    const { deps, breaker, client } = setup({ limiter });
    tripBreaker(breaker);
    now += 1000; // breaker becomes HALF_OPEN with a single probe slot
    await expect(processRetrievalJob('job-1', deps)).resolves.toMatchObject({
      type: 'deferred',
      reason: 'rate_limited',
    });
    expect(client.fetchPolicy).not.toHaveBeenCalled();
    expect(breaker.snapshot()).toMatchObject({ state: 'HALF_OPEN', probesInFlight: 0 });
  });

  it('skips work when the execution has been fenced off', async () => {
    const { deps, store, client, breaker } = setup();
    store.startAttempt.mockResolvedValueOnce(null as never);
    await expect(processRetrievalJob('job-1', deps)).resolves.toEqual({
      type: 'skipped',
      reason: 'fenced',
    });
    expect(client.fetchPolicy).not.toHaveBeenCalled();
    expect(breaker.snapshot().windowRequests).toBe(0);
  });

  it('propagates infrastructure errors instead of treating them as carrier failures', async () => {
    const { deps, store } = setup();
    store.complete.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(processRetrievalJob('job-1', deps)).rejects.toThrow('database unavailable');
    expect(store.scheduleRetry).not.toHaveBeenCalled();
  });

  it('does nothing for terminal or missing jobs', async () => {
    const { deps, store, client } = setup();
    store.claim.mockResolvedValueOnce({ type: 'terminal', status: 'completed' } as never);
    await expect(processRetrievalJob('job-1', deps)).resolves.toEqual({
      type: 'skipped',
      reason: 'terminal',
    });
    store.claim.mockResolvedValueOnce({ type: 'missing' } as never);
    await expect(processRetrievalJob('job-1', deps)).resolves.toEqual({
      type: 'skipped',
      reason: 'missing',
    });
    expect(client.fetchPolicy).not.toHaveBeenCalled();
  });
});
