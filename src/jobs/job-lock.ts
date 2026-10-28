import type { Prisma } from '../shared/prisma.js';
import type { JobStatusValue } from './job-states.js';

export type Tx = Prisma.TransactionClient;

export interface LockedJob {
  id: string;
  status: JobStatusValue;
  executionId: string | null;
  cancelRequested: boolean;
  attempts: number;
  maxAttempts: number;
  replayCount: number;
  carrierId: string;
  policyId: string;
  deadlineAt: Date | null;
  nextAttemptAt: Date | null;
  enqueuedAt: Date;
  runStartedAt: Date | null;
  lastErrorKind: string | null;
  updatedAt: Date;
}

/**
 * Reads a job row and holds a row lock (`SELECT ... FOR UPDATE`) until the transaction ends.
 *
 * Every state transition (worker, API retry/cancel, reconciler) goes through this lock, so the
 * read-check-write sequence is atomic. That removes races such as "cancel arrives while the
 * worker schedules a retry" without relying on optimistic retries.
 */
export async function lockJob(tx: Tx, jobId: string): Promise<LockedJob | null> {
  const rows = await tx.$queryRaw<LockedJob[]>`
    SELECT id,
           status::text      AS "status",
           execution_id      AS "executionId",
           cancel_requested  AS "cancelRequested",
           attempts,
           max_attempts      AS "maxAttempts",
           replay_count      AS "replayCount",
           carrier_id        AS "carrierId",
           policy_id         AS "policyId",
           deadline_at       AS "deadlineAt",
           next_attempt_at   AS "nextAttemptAt",
           enqueued_at       AS "enqueuedAt",
           run_started_at    AS "runStartedAt",
           last_error_kind   AS "lastErrorKind",
           updated_at        AS "updatedAt"
      FROM jobs
     WHERE id = ${jobId}::uuid
       FOR UPDATE`;
  return rows[0] ?? null;
}
