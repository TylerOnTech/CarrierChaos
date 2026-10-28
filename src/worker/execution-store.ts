import { randomUUID } from 'node:crypto';
import type { NormalizedPolicy } from '../contracts/normalized-policy.js';
import { lockJob, type LockedJob, type Tx } from '../jobs/job-lock.js';
import { isTerminal, type JobStatusValue } from '../jobs/job-states.js';
import type { CarrierError, ErrorKind } from '../resilience/errors.js';
import { sha256, stableStringify } from '../shared/hash.js';
import type { PrismaClient } from '../shared/prisma.js';

/** The worker's claim on a job for one execution; `executionId` is the fencing token. */
export interface Execution {
  jobId: string;
  executionId: string;
  carrierId: string;
  policyId: string;
  attempts: number;
  maxAttempts: number;
  replayCount: number;
  deadlineAt: Date | null;
  enqueuedAt: Date;
  lastErrorKind: string | null;
  /** True on the first pickup of this run; used for queue-wait measurement. */
  firstPickup: boolean;
  redelivered: boolean;
}

export type ClaimResult =
  | { type: 'claimed'; execution: Execution }
  | { type: 'missing' }
  | { type: 'terminal'; status: JobStatusValue }
  | { type: 'not_yet'; delayMs: number }
  | { type: 'cancelled' };

export interface AttemptHandle {
  attemptId: string;
  attemptNumber: number;
}

export type TransitionResult = 'ok' | 'cancelled' | 'fenced';

export type DeferReason = 'circuit_open' | 'rate_limited';

/** Tolerance for "the retry is not due yet" checks, absorbing scheduler/clock jitter. */
const NOT_BEFORE_TOLERANCE_MS = 50;

/**
 * All worker-side state transitions. Each method is one short transaction that locks the job
 * row, verifies the fencing token, and applies the change. No transaction is ever held open
 * across an upstream HTTP call.
 */
export class ExecutionStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly workerId: string,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Takes ownership of a job for one execution, or explains why it should not run now. */
  async claim(jobId: string): Promise<ClaimResult> {
    return this.prisma.$transaction(async (tx) => {
      const job = await lockJob(tx, jobId);
      if (!job) return { type: 'missing' };
      if (isTerminal(job.status)) return { type: 'terminal', status: job.status };

      const now = this.clock();
      if (
        job.status === 'queued' &&
        job.nextAttemptAt &&
        job.nextAttemptAt.getTime() > now + NOT_BEFORE_TOLERANCE_MS
      ) {
        // Delivered early (e.g. the retry was persisted but the delay was lost in a crash).
        return { type: 'not_yet', delayMs: job.nextAttemptAt.getTime() - now };
      }

      const redelivered = job.status === 'processing';
      if (redelivered) await abandonOpenAttempts(tx, job.id, now);

      if (job.cancelRequested) {
        await tx.job.update({
          where: { id: job.id },
          data: terminalData('cancelled', 'cancelled', now),
        });
        return { type: 'cancelled' };
      }

      const executionId = randomUUID();
      await tx.job.update({
        where: { id: job.id },
        data: {
          status: 'processing',
          executionId,
          executionCount: { increment: 1 },
          nextAttemptAt: null,
          ...(job.runStartedAt ? {} : { runStartedAt: new Date(now) }),
        },
      });
      return {
        type: 'claimed',
        execution: {
          jobId: job.id,
          executionId,
          carrierId: job.carrierId,
          policyId: job.policyId,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          replayCount: job.replayCount,
          deadlineAt: job.deadlineAt,
          enqueuedAt: job.enqueuedAt,
          lastErrorKind: job.lastErrorKind,
          firstPickup: job.runStartedAt === null,
          redelivered,
        },
      };
    });
  }

  /** Records the start of an upstream attempt. Returns null if this execution was fenced off. */
  async startAttempt(
    execution: Execution,
    waitedForRateLimit: boolean,
  ): Promise<AttemptHandle | null> {
    return this.prisma.$transaction(async (tx) => {
      const job = await lockJob(tx, execution.jobId);
      if (!owns(job, execution)) return null;
      const attemptNumber = job.attempts + 1;
      await tx.job.update({
        where: { id: job.id },
        data: {
          attempts: attemptNumber,
          ...(waitedForRateLimit ? { rateLimitDeferrals: { increment: 1 } } : {}),
        },
      });
      const attempt = await tx.jobAttempt.create({
        data: {
          jobId: job.id,
          run: job.replayCount,
          attemptNumber,
          executionId: execution.executionId,
          workerId: this.workerId,
          startedAt: new Date(this.clock()),
        },
      });
      return { attemptId: attempt.id, attemptNumber };
    });
  }

  /**
   * Persists the policy and completes the job atomically. The policy write is an idempotent
   * upsert keyed by (carrier, policy), and the whole transaction only commits if this execution
   * still owns the job, so a zombie execution can never produce a second successful result.
   */
  async complete(
    execution: Execution,
    attempt: AttemptHandle,
    policy: NormalizedPolicy,
    durationMs: number,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const job = await lockJob(tx, execution.jobId);
      if (!owns(job, execution)) return false;
      const now = new Date(this.clock());
      const policyRecordId = await upsertPolicy(tx, policy, execution.jobId);
      await tx.job.update({
        where: { id: job.id },
        data: {
          ...terminalData('completed', null, now.getTime()),
          resultPolicyRecordId: policyRecordId,
          lastErrorKind: null,
          lastErrorMessage: null,
        },
      });
      await tx.jobAttempt.update({
        where: { id: attempt.attemptId },
        data: { outcome: 'succeeded', httpStatus: 200, finishedAt: now, durationMs },
      });
      return true;
    });
  }

  async scheduleRetry(
    execution: Execution,
    attempt: AttemptHandle,
    error: CarrierError,
    delayMs: number,
    durationMs: number,
  ): Promise<TransitionResult> {
    return this.prisma.$transaction(async (tx) => {
      const job = await lockJob(tx, execution.jobId);
      if (!owns(job, execution)) return 'fenced';
      const now = this.clock();
      await finishAttempt(tx, attempt, 'retryable_error', error, now, durationMs, delayMs);
      if (job.cancelRequested) {
        await tx.job.update({
          where: { id: job.id },
          data: { ...terminalData('cancelled', 'cancelled', now), ...errorData(error) },
        });
        return 'cancelled';
      }
      await tx.job.update({
        where: { id: job.id },
        data: {
          status: 'queued',
          executionId: null,
          nextAttemptAt: new Date(now + delayMs),
          ...errorData(error),
        },
      });
      return 'ok';
    });
  }

  /** Puts the job back in the queue without consuming an attempt. */
  async defer(
    execution: Execution,
    reason: DeferReason,
    delayMs: number,
  ): Promise<TransitionResult> {
    return this.prisma.$transaction(async (tx) => {
      const job = await lockJob(tx, execution.jobId);
      if (!owns(job, execution)) return 'fenced';
      const now = this.clock();
      if (job.cancelRequested) {
        await tx.job.update({
          where: { id: job.id },
          data: terminalData('cancelled', 'cancelled', now),
        });
        return 'cancelled';
      }
      await tx.job.update({
        where: { id: job.id },
        data: {
          status: 'queued',
          executionId: null,
          nextAttemptAt: new Date(now + delayMs),
          ...(reason === 'circuit_open'
            ? { circuitDeferrals: { increment: 1 }, lastErrorKind: 'CIRCUIT_OPEN' }
            : { rateLimitDeferrals: { increment: 1 } }),
        },
      });
      return 'ok';
    });
  }

  /** Moves the job to `failed` or `dead_lettered`; dead letters get an inspectable DLQ record. */
  async finalizeFailure(
    execution: Execution,
    outcome: {
      status: 'failed' | 'dead_lettered';
      reason: string;
      /** An {@link ErrorKind}, `CIRCUIT_OPEN`, or the last recorded kind for deadline expiry. */
      errorKind: ErrorKind | (string & {}) | null;
      message: string;
      attempt?: { handle: AttemptHandle; error: CarrierError; durationMs: number };
    },
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const job = await lockJob(tx, execution.jobId);
      if (!owns(job, execution)) return false;
      const now = this.clock();
      if (outcome.attempt) {
        const { handle, error, durationMs } = outcome.attempt;
        await finishAttempt(
          tx,
          handle,
          error.retryable ? 'retryable_error' : 'permanent_error',
          error,
          now,
          durationMs,
          null,
        );
      }
      await tx.job.update({
        where: { id: job.id },
        data: {
          ...terminalData(outcome.status, outcome.reason, now),
          lastErrorKind: outcome.errorKind,
          lastErrorMessage: truncate(outcome.message),
        },
      });
      if (outcome.status === 'dead_lettered') {
        await tx.deadLetter.create({
          data: {
            jobId: job.id,
            run: job.replayCount,
            carrierId: job.carrierId,
            errorKind: outcome.errorKind,
            reason: outcome.reason,
            message: truncate(outcome.message),
            attempts: job.attempts,
          },
        });
      }
      return true;
    });
  }
}

function owns(job: LockedJob | null, execution: Execution): job is LockedJob {
  return job !== null && job.status === 'processing' && job.executionId === execution.executionId;
}

function terminalData(status: JobStatusValue, reason: string | null, now: number) {
  return {
    status,
    terminalReason: reason,
    executionId: null,
    nextAttemptAt: null,
    finishedAt: new Date(now),
  } as const;
}

function errorData(error: CarrierError) {
  return { lastErrorKind: error.kind, lastErrorMessage: truncate(error.message) };
}

async function finishAttempt(
  tx: Tx,
  attempt: AttemptHandle,
  outcome: 'retryable_error' | 'permanent_error',
  error: CarrierError,
  now: number,
  durationMs: number,
  retryDelayMs: number | null,
): Promise<void> {
  await tx.jobAttempt.update({
    where: { id: attempt.attemptId },
    data: {
      outcome,
      errorKind: error.kind,
      httpStatus: error.status ?? null,
      errorMessage: truncate(error.message),
      retryDelayMs,
      finishedAt: new Date(now),
      durationMs,
    },
  });
}

/** Marks attempts left open by a crashed or fenced-off execution as abandoned. */
export async function abandonOpenAttempts(tx: Tx, jobId: string, now: number): Promise<void> {
  await tx.jobAttempt.updateMany({
    where: { jobId, finishedAt: null },
    data: {
      outcome: 'abandoned',
      finishedAt: new Date(now),
      errorMessage: 'execution lost (worker crash or lock expiry)',
    },
  });
}

async function upsertPolicy(tx: Tx, policy: NormalizedPolicy, jobId: string): Promise<string> {
  const contentHash = sha256(stableStringify(policy));
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO policy_records
      (id, carrier_id, policy_id, schema_version, data, content_hash, version, fetch_count,
       first_job_id, last_job_id, created_at, updated_at)
    VALUES
      (gen_random_uuid(), ${policy.carrierId}, ${policy.policyId}, ${policy.schemaVersion},
       ${JSON.stringify(policy)}::jsonb, ${contentHash}, 1, 1, ${jobId}::uuid, ${jobId}::uuid, now(), now())
    ON CONFLICT (carrier_id, policy_id) DO UPDATE SET
      data         = EXCLUDED.data,
      version      = policy_records.version
                     + CASE WHEN policy_records.content_hash = EXCLUDED.content_hash THEN 0 ELSE 1 END,
      content_hash = EXCLUDED.content_hash,
      fetch_count  = policy_records.fetch_count + 1,
      last_job_id  = EXCLUDED.last_job_id,
      updated_at   = now()
    RETURNING id`;
  return rows[0]!.id;
}

function truncate(message: string, max = 500): string {
  return message.length > max ? `${message.slice(0, max - 1)}…` : message;
}
