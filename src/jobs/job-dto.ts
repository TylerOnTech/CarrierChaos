import type { DeadLetter, Job, JobAttempt } from '../shared/prisma.js';

type JobWithDetails = Job & {
  attemptLog?: JobAttempt[];
  deadLetters?: DeadLetter[];
  resultPolicy?: { id: string; data: unknown; version: number; fetchCount: number } | null;
};

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);

/** Public JSON representation of a job. Internal fields (fencing token, hashes) stay private. */
export function toJobDto(job: JobWithDetails) {
  return {
    id: job.id,
    status: job.status,
    carrierId: job.carrierId,
    policyId: job.policyId,
    idempotencyKey: job.idempotencyKey,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    run: job.replayCount,
    executions: job.executionCount,
    cancelRequested: job.cancelRequested,
    deferrals: { circuitOpen: job.circuitDeferrals, rateLimited: job.rateLimitDeferrals },
    lastError: job.lastErrorKind
      ? { kind: job.lastErrorKind, message: job.lastErrorMessage }
      : null,
    terminalReason: job.terminalReason,
    nextAttemptAt: iso(job.nextAttemptAt),
    deadlineAt: iso(job.deadlineAt),
    experimentId: job.experimentId,
    timestamps: {
      createdAt: iso(job.createdAt),
      enqueuedAt: iso(job.enqueuedAt),
      runStartedAt: iso(job.runStartedAt),
      finishedAt: iso(job.finishedAt),
      updatedAt: iso(job.updatedAt),
    },
    ...(job.resultPolicy !== undefined
      ? {
          result: job.resultPolicy
            ? {
                policyRecordId: job.resultPolicy.id,
                version: job.resultPolicy.version,
                fetchCount: job.resultPolicy.fetchCount,
                policy: job.resultPolicy.data,
              }
            : null,
        }
      : {}),
    ...(job.attemptLog
      ? {
          attemptHistory: job.attemptLog.map((attempt) => ({
            run: attempt.run,
            attempt: attempt.attemptNumber,
            outcome: attempt.outcome ?? 'in_progress',
            errorKind: attempt.errorKind,
            httpStatus: attempt.httpStatus,
            message: attempt.errorMessage,
            retryDelayMs: attempt.retryDelayMs,
            durationMs: attempt.durationMs,
            workerId: attempt.workerId,
            startedAt: iso(attempt.startedAt),
            finishedAt: iso(attempt.finishedAt),
          })),
        }
      : {}),
    ...(job.deadLetters
      ? {
          deadLetters: job.deadLetters.map((entry) => ({
            id: entry.id,
            run: entry.run,
            reason: entry.reason,
            errorKind: entry.errorKind,
            message: entry.message,
            attempts: entry.attempts,
            createdAt: iso(entry.createdAt),
            replayedAt: iso(entry.replayedAt),
          })),
        }
      : {}),
  };
}

export type JobDto = ReturnType<typeof toJobDto>;
