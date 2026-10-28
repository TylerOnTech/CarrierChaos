import type { CarrierClient } from '../carriers/carrier-client.js';
import type { CircuitBreaker } from '../resilience/circuit-breaker.js';
import { toCarrierError, type ErrorKind } from '../resilience/errors.js';
import { acquireWithinBudget, type RateLimiter } from '../resilience/rate-limiter.js';
import { decideRetry, type RetryPolicy } from '../resilience/retry-policy.js';
import type { Logger } from '../shared/logger.js';
import type { WorkerMetrics } from '../shared/metrics.js';
import type {
  DeferReason,
  Execution,
  ExecutionStore,
  TransitionResult,
} from './execution-store.js';

export interface CarrierResources {
  client: CarrierClient;
  breaker: CircuitBreaker;
  rateLimiter: RateLimiter;
}

export interface ProcessorDeps {
  store: ExecutionStore;
  resources(carrierId: string): CarrierResources;
  retryPolicy: RetryPolicy;
  /** Longest in-process wait for a rate-limit token before deferring the job instead. */
  rateLimitMaxWaitMs: number;
  clock: () => number;
  random: () => number;
  sleep: (ms: number) => Promise<void>;
  logger: Logger;
  metrics?: WorkerMetrics | undefined;
}

export type ProcessOutcome =
  | { type: 'completed'; attempts: number }
  | { type: 'retry_scheduled'; delayMs: number; errorKind: ErrorKind }
  | { type: 'deferred'; delayMs: number; reason: DeferReason | 'not_before' }
  | { type: 'failed'; reason: string; errorKind: ErrorKind }
  | { type: 'dead_lettered'; reason: string; errorKind: string | null }
  | { type: 'cancelled' }
  | { type: 'skipped'; reason: 'missing' | 'terminal' | 'fenced' };

/**
 * Executes one delivery of a retrieval job.
 *
 * The function is independent of BullMQ: it returns what should happen next and the queue
 * adapter (worker-runtime.ts) translates that into queue operations. Order of checks:
 *
 *   claim -> deadline -> circuit breaker -> rate limiter -> attempt -> classify -> retry policy
 *
 * The breaker is consulted before the rate limiter so a dead carrier never consumes tokens.
 * Breaker and rate-limit deferrals do not consume the job's attempt budget; only real upstream
 * calls do. The job deadline bounds how long deferrals can continue.
 */
export async function processRetrievalJob(
  jobId: string,
  deps: ProcessorDeps,
): Promise<ProcessOutcome> {
  const { store, clock, logger } = deps;
  const claim = await store.claim(jobId);
  switch (claim.type) {
    case 'missing':
      logger.warn({ jobId }, 'queue message references unknown job; dropping');
      return { type: 'skipped', reason: 'missing' };
    case 'terminal':
      return { type: 'skipped', reason: 'terminal' };
    case 'not_yet':
      return { type: 'deferred', delayMs: claim.delayMs, reason: 'not_before' };
    case 'cancelled':
      return { type: 'cancelled' };
    case 'claimed':
      break;
  }

  const execution = claim.execution;
  const carrier = execution.carrierId;
  const log = logger.child({ jobId, carrierId: carrier, policyId: execution.policyId });
  if (execution.redelivered)
    log.warn('job redelivered after a lost execution; previous attempt abandoned');
  if (execution.firstPickup) {
    deps.metrics?.queueWait.observe({ carrier }, (clock() - execution.enqueuedAt.getTime()) / 1000);
  }

  const deadlineAt = execution.deadlineAt?.getTime();
  if (deadlineAt !== undefined && clock() >= deadlineAt) {
    return deadLetter(
      deps,
      execution,
      'deadline_exceeded',
      execution.lastErrorKind,
      'job deadline passed before the next attempt',
    );
  }

  const { client, breaker, rateLimiter } = deps.resources(carrier);

  // 1. Circuit breaker: do not call a carrier we believe is down.
  const acquired = breaker.tryAcquire();
  if (!acquired.allowed) {
    const delayMs = acquired.retryAfterMs + jitter(deps.random, acquired.retryAfterMs);
    return defer(deps, execution, 'circuit_open', delayMs, `circuit ${acquired.state}`);
  }
  const permit = acquired.permit;

  // 2. Rate limiter: respect the carrier's capacity across all workers.
  let token;
  try {
    token = await acquireWithinBudget(rateLimiter, deps.rateLimitMaxWaitMs, deps.sleep);
  } catch (error) {
    breaker.release(permit);
    throw error;
  }
  if (!token.acquired) {
    breaker.release(permit);
    const delayMs = token.retryAfterMs + jitter(deps.random, token.retryAfterMs);
    return defer(deps, execution, 'rate_limited', delayMs, 'rate limit');
  }

  // 3. The upstream attempt itself.
  const attempt = await store.startAttempt(execution, token.waitedMs > 0);
  if (!attempt) {
    breaker.release(permit);
    return { type: 'skipped', reason: 'fenced' };
  }

  const startedAt = clock();
  let policy;
  try {
    policy = await client.fetchPolicy(execution.policyId);
  } catch (raw) {
    const error = toCarrierError(raw);
    const durationMs = clock() - startedAt;
    breaker.record(permit, error.breakerOutcome);
    deps.metrics?.attempts.inc({ carrier, outcome: 'error', error_kind: error.kind });
    deps.metrics?.requestDuration.observe({ carrier, outcome: 'error' }, durationMs / 1000);

    const decision = decideRetry({
      attemptsMade: attempt.attemptNumber,
      error,
      policy: { ...deps.retryPolicy, maxAttempts: execution.maxAttempts },
      now: clock(),
      deadlineAt,
      random: deps.random,
    });

    if (decision.retry) {
      const result = await store.scheduleRetry(
        execution,
        attempt,
        error,
        decision.delayMs,
        durationMs,
      );
      if (result === 'ok') {
        deps.metrics?.retriesScheduled.inc({ carrier, error_kind: error.kind });
        log.info(
          {
            attempt: attempt.attemptNumber,
            errorKind: error.kind,
            delayMs: decision.delayMs,
            basis: decision.basis,
          },
          'transient failure; retry scheduled',
        );
        return { type: 'retry_scheduled', delayMs: decision.delayMs, errorKind: error.kind };
      }
      return afterTransition(deps, execution, result);
    }

    const status = decision.reason === 'non_retryable' ? 'failed' : 'dead_lettered';
    const finalized = await store.finalizeFailure(execution, {
      status,
      reason: decision.reason,
      errorKind: error.kind,
      message: error.message,
      attempt: { handle: attempt, error, durationMs },
    });
    if (!finalized) return { type: 'skipped', reason: 'fenced' };
    recordTerminal(deps, execution, status, decision.reason);
    log.warn(
      { attempt: attempt.attemptNumber, errorKind: error.kind, reason: decision.reason, status },
      'job stopped',
    );
    return status === 'failed'
      ? { type: 'failed', reason: decision.reason, errorKind: error.kind }
      : { type: 'dead_lettered', reason: decision.reason, errorKind: error.kind };
  }

  const durationMs = clock() - startedAt;
  breaker.record(permit, 'success');
  deps.metrics?.attempts.inc({ carrier, outcome: 'success', error_kind: 'none' });
  deps.metrics?.requestDuration.observe({ carrier, outcome: 'success' }, durationMs / 1000);

  const completed = await store.complete(execution, attempt, policy, durationMs);
  if (!completed) {
    log.warn('execution was fenced off before completion; result discarded (idempotent)');
    return { type: 'skipped', reason: 'fenced' };
  }
  recordTerminal(deps, execution, 'completed', 'succeeded');
  return { type: 'completed', attempts: attempt.attemptNumber };
}

async function defer(
  deps: ProcessorDeps,
  execution: Execution,
  reason: DeferReason,
  delayMs: number,
  description: string,
): Promise<ProcessOutcome> {
  const deadlineAt = execution.deadlineAt?.getTime();
  if (deadlineAt !== undefined && deps.clock() + delayMs > deadlineAt) {
    // Waiting would cross the deadline anyway; fail now and free the slot.
    const errorKind = reason === 'circuit_open' ? 'CIRCUIT_OPEN' : execution.lastErrorKind;
    return deadLetter(
      deps,
      execution,
      'deadline_exceeded',
      errorKind,
      `${description}: deadline would pass while deferred`,
    );
  }
  const result = await deps.store.defer(execution, reason, delayMs);
  if (result === 'ok') {
    deps.metrics?.deferrals.inc({ carrier: execution.carrierId, reason });
    return { type: 'deferred', delayMs, reason };
  }
  return afterTransition(deps, execution, result);
}

async function deadLetter(
  deps: ProcessorDeps,
  execution: Execution,
  reason: string,
  errorKind: string | null,
  message: string,
): Promise<ProcessOutcome> {
  const finalized = await deps.store.finalizeFailure(execution, {
    status: 'dead_lettered',
    reason,
    errorKind,
    message,
  });
  if (!finalized) return { type: 'skipped', reason: 'fenced' };
  recordTerminal(deps, execution, 'dead_lettered', reason);
  deps.logger.warn({ jobId: execution.jobId, reason, errorKind }, 'job dead-lettered');
  return { type: 'dead_lettered', reason, errorKind };
}

function afterTransition(
  deps: ProcessorDeps,
  execution: Execution,
  result: Exclude<TransitionResult, 'ok'>,
): ProcessOutcome {
  if (result === 'cancelled') {
    recordTerminal(deps, execution, 'cancelled', 'cancelled');
    return { type: 'cancelled' };
  }
  return { type: 'skipped', reason: 'fenced' };
}

function recordTerminal(deps: ProcessorDeps, execution: Execution, status: string, reason: string) {
  const carrier = execution.carrierId;
  deps.metrics?.jobsTerminal.inc({ carrier, status, reason });
  deps.metrics?.jobEndToEnd.observe(
    { carrier, status },
    (deps.clock() - execution.enqueuedAt.getTime()) / 1000,
  );
}

/** Up to 20% (max 250ms) of extra delay so deferred jobs do not return in lockstep. */
function jitter(random: () => number, baseMs: number): number {
  return Math.floor(random() * Math.min(250, baseMs * 0.2 + 10));
}
