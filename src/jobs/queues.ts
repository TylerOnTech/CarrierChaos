import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { CarrierDefinition } from '../carriers/registry.js';

export const RETRIEVAL_JOB_NAME = 'retrieve-policy';

/** Queue messages carry only the job id; PostgreSQL holds everything else. */
export interface RetrievalJobData {
  jobId: string;
}

export function queueName(carrierId: string): string {
  return `retrieval-${carrierId}`;
}

/**
 * Deterministic BullMQ job id per run. Adding the same id twice is a no-op in BullMQ, which makes
 * enqueueing idempotent: the API, duplicate submissions and the reconciler can all "ensure
 * enqueued" safely. A manual retry starts a new run and therefore a new id.
 */
export function bullJobId(jobId: string, replayCount: number): string {
  return replayCount === 0 ? jobId : `${jobId}-r${replayCount}`;
}

/**
 * BullMQ-level attempts only cover infrastructure failures inside the processor (e.g. PostgreSQL
 * briefly unreachable). Carrier failures are retried by the processor itself, which reschedules
 * the same BullMQ job with `moveToDelayed`, so they never consume these attempts.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export interface EnqueueTarget {
  id: string;
  carrierId: string;
  replayCount: number;
}

/** One queue per carrier: the bulkhead that keeps carriers from starving each other. */
export class JobQueues {
  private readonly queues = new Map<string, Queue<RetrievalJobData>>();

  constructor(connection: Redis, prefix: string, carriers: readonly CarrierDefinition[]) {
    for (const carrier of carriers) {
      this.queues.set(
        carrier.id,
        new Queue<RetrievalJobData>(queueName(carrier.id), {
          connection,
          prefix,
          defaultJobOptions: DEFAULT_JOB_OPTIONS,
        }),
      );
    }
  }

  get(carrierId: string): Queue<RetrievalJobData> {
    const queue = this.queues.get(carrierId);
    if (!queue) throw new Error(`no queue for carrier '${carrierId}'`);
    return queue;
  }

  carrierIds(): string[] {
    return [...this.queues.keys()];
  }

  async enqueue(target: EnqueueTarget, delayMs = 0): Promise<void> {
    await this.get(target.carrierId).add(
      RETRIEVAL_JOB_NAME,
      { jobId: target.id },
      { jobId: bullJobId(target.id, target.replayCount), delay: Math.max(0, delayMs) },
    );
  }

  /** Removes a waiting/delayed BullMQ job. Returns false if it is locked by a worker. */
  async remove(target: EnqueueTarget): Promise<boolean> {
    const job = await this.get(target.carrierId).getJob(bullJobId(target.id, target.replayCount));
    if (!job) return true;
    try {
      await job.remove();
      return true;
    } catch {
      return false;
    }
  }

  async getState(target: EnqueueTarget): Promise<string> {
    return this.get(target.carrierId).getJobState(bullJobId(target.id, target.replayCount));
  }

  async counts(carrierId: string): Promise<Record<string, number>> {
    return this.get(carrierId).getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
  }
}
