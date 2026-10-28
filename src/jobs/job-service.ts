import { findCarrier, type CarrierDefinition } from '../carriers/registry.js';
import { sha256, stableStringify } from '../shared/hash.js';
import type { Logger } from '../shared/logger.js';
import { Prisma, type Job, type PrismaClient } from '../shared/prisma.js';
import { IdempotencyConflictError, JobNotFoundError, UnknownCarrierError } from './errors.js';
import { lockJob } from './job-lock.js';
import { InvalidTransitionError, type JobStatusValue } from './job-states.js';
import type { JobQueues } from './queues.js';

export interface SubmitJobInput {
  carrierId: string;
  policyId: string;
  idempotencyKey: string;
  maxAttempts?: number | undefined;
  deadlineMs?: number | undefined;
  /** Internal: experiments group their jobs. Not accepted from the public API. */
  experimentId?: string | undefined;
}

export interface SubmitResult {
  job: Job;
  created: boolean;
}

export interface ListJobsFilter {
  status?: JobStatusValue | undefined;
  carrierId?: string | undefined;
  experimentId?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}

export type CancelOutcome = 'cancelled' | 'cancel_requested' | 'already_cancelled';

export interface JobServiceOptions {
  prisma: PrismaClient;
  queues: JobQueues;
  carriers: readonly CarrierDefinition[];
  defaults: { maxAttempts: number; deadlineMs: number };
  logger: Logger;
  onSubmit?: (carrierId: string, created: boolean) => void;
}

export class JobService {
  constructor(private readonly options: JobServiceOptions) {}

  /**
   * Idempotent job creation.
   *
   * The idempotency key is a unique column, so concurrent submissions race on the insert and
   * exactly one wins; losers read the winner's row. A reused key with a different payload is a
   * client bug and is rejected rather than silently returning an unrelated job.
   */
  async submit(input: SubmitJobInput): Promise<SubmitResult> {
    const { prisma, carriers, defaults } = this.options;
    if (!findCarrier(input.carrierId, carriers)) throw new UnknownCarrierError(input.carrierId);

    const requestHash = sha256(
      stableStringify({
        carrierId: input.carrierId,
        policyId: input.policyId,
        maxAttempts: input.maxAttempts ?? null,
        deadlineMs: input.deadlineMs ?? null,
      }),
    );

    const existing = await prisma.job.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) return this.replay(existing, requestHash);

    const now = Date.now();
    let job: Job;
    try {
      job = await prisma.job.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          requestHash,
          carrierId: input.carrierId,
          policyId: input.policyId,
          maxAttempts: input.maxAttempts ?? defaults.maxAttempts,
          deadlineAt: new Date(now + (input.deadlineMs ?? defaults.deadlineMs)),
          experimentId: input.experimentId ?? null,
          enqueuedAt: new Date(now),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await prisma.job.findUniqueOrThrow({
          where: { idempotencyKey: input.idempotencyKey },
        });
        return this.replay(winner, requestHash);
      }
      throw error;
    }

    await this.ensureEnqueued(job);
    this.options.onSubmit?.(job.carrierId, true);
    return { job, created: true };
  }

  async get(jobId: string) {
    return this.options.prisma.job.findUnique({
      where: { id: jobId },
      include: {
        attemptLog: { orderBy: [{ run: 'asc' }, { attemptNumber: 'asc' }] },
        deadLetters: { orderBy: { createdAt: 'asc' } },
        resultPolicy: true,
      },
    });
  }

  /** Keyset pagination over (createdAt DESC, id DESC); stable under concurrent inserts. */
  async list(filter: ListJobsFilter): Promise<{ items: Job[]; nextCursor: string | null }> {
    const where: Prisma.JobWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.carrierId ? { carrierId: filter.carrierId } : {}),
      ...(filter.experimentId ? { experimentId: filter.experimentId } : {}),
    };
    const cursor = filter.cursor ? decodeCursor(filter.cursor) : undefined;
    if (cursor) {
      where.OR = [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ];
    }
    const rows = await this.options.prisma.job.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit + 1,
    });
    const items = rows.slice(0, filter.limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: rows.length > filter.limit && last ? encodeCursor(last) : null,
    };
  }

  /**
   * Manual retry / dead-letter replay. Starts a new run with a fresh attempt budget and deadline,
   * marks open dead letters as replayed, and enqueues under a new BullMQ id. Completed jobs cannot
   * be retried: that would produce a second successful result for one logical operation.
   */
  async retry(jobId: string): Promise<Job> {
    const { prisma } = this.options;
    const job = await prisma.$transaction(async (tx) => {
      const locked = await lockJob(tx, jobId);
      if (!locked) throw new JobNotFoundError(jobId);
      if (!['failed', 'dead_lettered', 'cancelled'].includes(locked.status)) {
        throw new InvalidTransitionError(locked.status, 'queued', 'retry');
      }
      const now = Date.now();
      const budgetMs = locked.deadlineAt
        ? locked.deadlineAt.getTime() - locked.enqueuedAt.getTime()
        : this.options.defaults.deadlineMs;
      await tx.deadLetter.updateMany({
        where: { jobId, replayedAt: null },
        data: { replayedAt: new Date(now) },
      });
      return tx.job.update({
        where: { id: jobId },
        data: {
          status: 'queued',
          attempts: 0,
          replayCount: { increment: 1 },
          executionId: null,
          cancelRequested: false,
          nextAttemptAt: null,
          terminalReason: null,
          finishedAt: null,
          runStartedAt: null,
          enqueuedAt: new Date(now),
          deadlineAt: new Date(now + budgetMs),
        },
      });
    });
    await this.ensureEnqueued(job);
    this.options.logger.info({ jobId, run: job.replayCount }, 'job manually retried');
    return job;
  }

  /**
   * Cancellation. A queued job is cancelled immediately and its queue message removed. A job in
   * flight cannot be interrupted safely mid-request, so it is flagged; the worker honors the flag
   * at its next checkpoint (before retrying or deferring). If the in-flight attempt succeeds, the
   * job completes: the effect already happened and is idempotent.
   */
  async cancel(jobId: string): Promise<{ job: Job; outcome: CancelOutcome }> {
    const { prisma, queues } = this.options;
    const result = await prisma.$transaction(async (tx) => {
      const locked = await lockJob(tx, jobId);
      if (!locked) throw new JobNotFoundError(jobId);
      const now = new Date();
      switch (locked.status) {
        case 'queued':
          return {
            outcome: 'cancelled' as const,
            job: await tx.job.update({
              where: { id: jobId },
              data: {
                status: 'cancelled',
                terminalReason: 'cancelled',
                finishedAt: now,
                executionId: null,
                nextAttemptAt: null,
              },
            }),
          };
        case 'processing':
          return {
            outcome: 'cancel_requested' as const,
            job: await tx.job.update({ where: { id: jobId }, data: { cancelRequested: true } }),
          };
        case 'cancelled':
          return {
            outcome: 'already_cancelled' as const,
            job: await tx.job.findUniqueOrThrow({ where: { id: jobId } }),
          };
        default:
          throw new InvalidTransitionError(locked.status, 'cancelled', 'cancel');
      }
    });
    if (result.outcome === 'cancelled') {
      // Best effort: if the message is already locked by a worker, the worker sees the
      // cancelled status when it claims the job and drops it.
      await queues.remove(result.job).catch(() => false);
    }
    return result;
  }

  private async replay(existing: Job, requestHash: string): Promise<SubmitResult> {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyConflictError(existing.idempotencyKey, existing.id);
    }
    // Heals the enqueue gap if the original request crashed between commit and enqueue.
    if (existing.status === 'queued') await this.ensureEnqueued(existing);
    this.options.onSubmit?.(existing.carrierId, false);
    return { job: existing, created: false };
  }

  private async ensureEnqueued(job: Job): Promise<void> {
    try {
      const delay = job.nextAttemptAt ? job.nextAttemptAt.getTime() - Date.now() : 0;
      await this.options.queues.enqueue(job, delay);
    } catch (error) {
      // The job is durable in PostgreSQL; the reconciler will enqueue it once Redis is back.
      this.options.logger.error(
        { err: error, jobId: job.id },
        'enqueue failed; reconciler will retry',
      );
    }
  }
}

function encodeCursor(job: Pick<Job, 'createdAt' | 'id'>): string {
  return Buffer.from(JSON.stringify([job.createdAt.toISOString(), job.id])).toString('base64url');
}

export class InvalidCursorError extends Error {
  constructor() {
    super('invalid pagination cursor');
    this.name = 'InvalidCursorError';
  }
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [
      string,
      string,
    ];
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime()) || typeof id !== 'string') throw new Error('bad cursor');
    return { createdAt: date, id };
  } catch {
    throw new InvalidCursorError();
  }
}
