import { lockJob } from '../jobs/job-lock.js';
import type { JobQueues } from '../jobs/queues.js';
import type { Logger } from '../shared/logger.js';
import type { PrismaClient } from '../shared/prisma.js';
import { abandonOpenAttempts } from './execution-store.js';

export interface ReconcilerOptions {
  prisma: PrismaClient;
  queues: JobQueues;
  logger: Logger;
  /** A queued job older than this with no BullMQ message is re-enqueued. */
  queuedGraceMs?: number;
  /** A processing job untouched for this long whose BullMQ job is gone is dead-lettered. */
  processingStaleMs?: number;
  batchSize?: number;
  clock?: () => number;
}

export interface ReconcileResult {
  reenqueued: number;
  deadLettered: number;
}

const LIVE_QUEUE_STATES = new Set([
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'waiting-children',
]);

/**
 * Repairs the gaps between PostgreSQL (source of truth) and Redis (delivery):
 *
 * 1. Enqueue gap: the API committed a job but crashed (or Redis was down) before enqueueing it.
 *    Re-adding is safe because BullMQ job ids are deterministic per run.
 * 2. Lost execution: a job is stuck in `processing` but BullMQ no longer has a live job for it
 *    (stalled too many times, or infrastructure retries exhausted). Rather than loop forever on a
 *    possible poison message, the job is dead-lettered with reason `worker_lost` for inspection
 *    and manual replay.
 *
 * Every repair is a conditional, row-locked transition, so concurrent reconcilers are harmless.
 */
export class Reconciler {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | undefined;
  private readonly queuedGraceMs: number;
  private readonly processingStaleMs: number;
  private readonly batchSize: number;
  private readonly clock: () => number;

  constructor(private readonly options: ReconcilerOptions) {
    this.queuedGraceMs = options.queuedGraceMs ?? 30_000;
    this.processingStaleMs = options.processingStaleMs ?? 120_000;
    this.batchSize = options.batchSize ?? 100;
    this.clock = options.clock ?? Date.now;
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.runOnce()
        .catch((error: unknown) =>
          this.options.logger.error({ err: error }, 'reconciler pass failed'),
        )
        .finally(() => (this.running = undefined));
    }, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  async runOnce(): Promise<ReconcileResult> {
    const reenqueued = await this.repairEnqueueGaps();
    const deadLettered = await this.repairLostExecutions();
    if (reenqueued + deadLettered > 0) {
      this.options.logger.warn({ reenqueued, deadLettered }, 'reconciler repaired job state');
    }
    return { reenqueued, deadLettered };
  }

  private async repairEnqueueGaps(): Promise<number> {
    const { prisma, queues } = this.options;
    const now = this.clock();
    const candidates = await prisma.job.findMany({
      where: { status: 'queued', updatedAt: { lt: new Date(now - this.queuedGraceMs) } },
      orderBy: { updatedAt: 'asc' },
      take: this.batchSize,
      select: { id: true, carrierId: true, replayCount: true, nextAttemptAt: true },
    });
    let repaired = 0;
    for (const job of candidates) {
      if ((await queues.getState(job)) !== 'unknown') continue;
      const delayMs = job.nextAttemptAt ? job.nextAttemptAt.getTime() - now : 0;
      await queues.enqueue(job, delayMs);
      repaired += 1;
    }
    return repaired;
  }

  private async repairLostExecutions(): Promise<number> {
    const { prisma, queues } = this.options;
    const now = this.clock();
    const candidates = await prisma.job.findMany({
      where: { status: 'processing', updatedAt: { lt: new Date(now - this.processingStaleMs) } },
      orderBy: { updatedAt: 'asc' },
      take: this.batchSize,
      select: { id: true, carrierId: true, replayCount: true, updatedAt: true },
    });
    let repaired = 0;
    for (const candidate of candidates) {
      if (LIVE_QUEUE_STATES.has(await queues.getState(candidate))) continue;
      const done = await prisma.$transaction(async (tx) => {
        const job = await lockJob(tx, candidate.id);
        // Only act if nothing touched the job since we looked at it.
        if (
          !job ||
          job.status !== 'processing' ||
          job.updatedAt.getTime() !== candidate.updatedAt.getTime()
        ) {
          return false;
        }
        await abandonOpenAttempts(tx, job.id, now);
        await tx.job.update({
          where: { id: job.id },
          data: {
            status: 'dead_lettered',
            terminalReason: 'worker_lost',
            executionId: null,
            nextAttemptAt: null,
            finishedAt: new Date(now),
            lastErrorMessage: 'execution lost: no live queue message for a processing job',
          },
        });
        await tx.deadLetter.create({
          data: {
            jobId: job.id,
            run: job.replayCount,
            carrierId: job.carrierId,
            errorKind: job.lastErrorKind,
            reason: 'worker_lost',
            message: 'execution lost: no live queue message for a processing job',
            attempts: job.attempts,
          },
        });
        return true;
      });
      if (done) repaired += 1;
    }
    return repaired;
  }
}
