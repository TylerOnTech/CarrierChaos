/**
 * Job state machine.
 *
 *   queued ──► processing ──► completed
 *     ▲  │         │  ├─────► failed          (non-retryable error)
 *     │  │         │  ├─────► dead_lettered   (retry budget, deadline or worker lost)
 *     │  │         │  └─────► cancelled       (cancel requested while in flight)
 *     │  │         └──► queued                (retry scheduled, or deferred by breaker/rate limit)
 *     │  └────────────► cancelled
 *     └── failed | dead_lettered | cancelled   (explicit manual retry / DLQ replay)
 *
 * `processing -> processing` covers redelivery: a worker crashed or lost its lock and another
 * execution takes over. The fencing token (execution_id) makes the old execution's writes no-ops.
 * `completed` is final: retrying it would duplicate a successful result.
 */
export const JOB_STATUSES = [
  'queued',
  'processing',
  'completed',
  'failed',
  'dead_lettered',
  'cancelled',
] as const;

export type JobStatusValue = (typeof JOB_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<JobStatusValue> = new Set([
  'completed',
  'failed',
  'dead_lettered',
  'cancelled',
]);

const TRANSITIONS: Readonly<Record<JobStatusValue, readonly JobStatusValue[]>> = {
  queued: ['processing', 'cancelled'],
  processing: ['processing', 'queued', 'completed', 'failed', 'dead_lettered', 'cancelled'],
  completed: [],
  failed: ['queued'],
  dead_lettered: ['queued'],
  cancelled: ['queued'],
};

export function canTransition(from: JobStatusValue, to: JobStatusValue): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: JobStatusValue): boolean {
  return TERMINAL_STATUSES.has(status);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: JobStatusValue,
    readonly to: JobStatusValue,
    readonly action: string,
  ) {
    super(`cannot ${action} a job in status '${from}'`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: JobStatusValue, to: JobStatusValue, action: string): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to, action);
}
