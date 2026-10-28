import type { CarrierStats } from '../mock-carrier/simulator.js';
import { countBy, distribution } from './stats.js';
import type { ExperimentPlan } from './scenarios.js';

export interface SummaryJob {
  id: string;
  carrierId: string;
  policyId: string;
  status: string;
  circuitDeferrals: number;
  rateLimitDeferrals: number;
  enqueuedAt: Date;
  runStartedAt: Date | null;
  finishedAt: Date | null;
  terminalReason: string | null;
}

export interface SummaryAttempt {
  jobId: string;
  outcome: string | null;
  errorKind: string | null;
}

export interface SummaryTransition {
  carrierId: string;
  fromState: string;
  toState: string;
  reason: string;
  occurredAt: Date;
}

export interface SubmissionStats {
  submissions: number;
  created: number;
  deduplicated: number;
  replayedJobIds: string[];
}

export interface SummaryInput {
  experiment: { id: string; startedAt: Date; completedAt: Date | null; status: string };
  plan: ExperimentPlan;
  submission: SubmissionStats;
  jobs: SummaryJob[];
  attempts: SummaryAttempt[];
  transitions: SummaryTransition[];
  /** Persisted policy records matching the experiment's (carrier, policy) targets. */
  policyRecords: number;
  upstream?: Record<string, CarrierStats> | undefined;
  now: Date;
}

const TERMINAL = new Set(['completed', 'failed', 'dead_lettered', 'cancelled']);

/**
 * Builds an experiment summary purely from recorded data: job rows, attempt rows, breaker
 * transitions and (optionally) the mock carrier's own request counters. Nothing is estimated.
 */
export function buildExperimentSummary(input: SummaryInput) {
  const { experiment, plan, jobs, attempts, transitions, submission } = input;
  const startedAt = experiment.startedAt.getTime();
  const lastFinish = Math.max(...jobs.map((job) => job.finishedAt?.getTime() ?? 0), 0);
  const allTerminal = jobs.length > 0 && jobs.every((job) => TERMINAL.has(job.status));
  const endedAt = allTerminal ? lastFinish : input.now.getTime();

  const carrierIds = [plan.carrierId, ...(plan.control ? [plan.control.carrierId] : [])];
  const carriers = Object.fromEntries(
    carrierIds.map((carrierId) => {
      const carrierJobs = jobs.filter((job) => job.carrierId === carrierId);
      const ids = new Set(carrierJobs.map((job) => job.id));
      return [
        carrierId,
        summarizeCarrier(
          carrierJobs,
          attempts.filter((attempt) => ids.has(attempt.jobId)),
          transitions.filter((t) => t.carrierId === carrierId),
          startedAt,
          input.upstream?.[carrierId],
          carrierId === plan.control?.carrierId ? 'control' : 'target',
        ),
      ];
    }),
  );

  const completedJobs = jobs.filter((job) => job.status === 'completed');
  const successfulAttemptsByJob = countBy(
    attempts.filter((attempt) => attempt.outcome === 'succeeded'),
    (attempt) => attempt.jobId,
  );
  const successfulAttempts = Object.values(successfulAttemptsByJob).reduce((a, b) => a + b, 0);

  return {
    experimentId: experiment.id,
    scenario: plan.scenario,
    title: `${plan.code} — ${plan.title}`,
    description: plan.description,
    seed: plan.seed,
    status: allTerminal ? 'completed' : 'running',
    startedAt: experiment.startedAt.toISOString(),
    completedAt: allTerminal ? new Date(lastFinish).toISOString() : null,
    durationMs: Math.max(0, endedAt - startedAt),
    config: {
      carrierId: plan.carrierId,
      jobCount: plan.jobCount,
      faults: plan.faults,
      maxAttempts: plan.maxAttempts,
      deadlineMs: plan.deadlineMs,
      control: plan.control,
      replayedDeadLetters: submission.replayedJobIds.length,
    },
    totals: {
      jobs: jobs.length,
      completed: completedJobs.length,
      successRate: ratio(completedJobs.length, jobs.length),
    },
    carriers,
    idempotency: {
      submissions: submission.submissions,
      jobsCreated: submission.created,
      duplicateSubmissionsDeduplicated: submission.deduplicated,
      completedJobs: completedJobs.length,
      successfulAttempts,
      jobsWithMultipleSuccessfulAttempts: Object.values(successfulAttemptsByJob).filter(
        (n) => n > 1,
      ).length,
      distinctPoliciesCompleted: new Set(completedJobs.map((j) => `${j.carrierId}/${j.policyId}`))
        .size,
      policyRecords: input.policyRecords,
    },
  };
}

export type ExperimentSummary = ReturnType<typeof buildExperimentSummary>;

function summarizeCarrier(
  jobs: SummaryJob[],
  attempts: SummaryAttempt[],
  transitions: SummaryTransition[],
  startedAt: number,
  upstream: CarrierStats | undefined,
  role: 'target' | 'control',
) {
  const byStatus = countBy(jobs, (job) => job.status);
  const jobsWithAttempts = new Set(attempts.map((attempt) => attempt.jobId)).size;
  const attemptsPerJob = Object.values(countBy(attempts, (attempt) => attempt.jobId));
  const completed = jobs.filter((job) => job.status === 'completed');

  const queueWait: number[] = [];
  for (const job of jobs) {
    if (job.runStartedAt) queueWait.push(job.runStartedAt.getTime() - job.enqueuedAt.getTime());
  }
  const endToEnd = completed
    .filter((job) => job.finishedAt)
    .map((job) => job.finishedAt!.getTime() - job.enqueuedAt.getTime());

  return {
    role,
    jobs: {
      total: jobs.length,
      completed: byStatus.completed ?? 0,
      failed: byStatus.failed ?? 0,
      deadLettered: byStatus.dead_lettered ?? 0,
      cancelled: byStatus.cancelled ?? 0,
      inFlight: jobs.length - jobs.filter((job) => TERMINAL.has(job.status)).length,
    },
    successRate: ratio(completed.length, jobs.length),
    attempts: {
      total: attempts.length,
      retries: Math.max(0, attempts.length - jobsWithAttempts),
      jobsRetried: attemptsPerJob.filter((n) => n > 1).length,
      maxPerJob: attemptsPerJob.length ? Math.max(...attemptsPerJob) : 0,
    },
    deferrals: {
      circuitOpen: jobs.reduce((sum, job) => sum + job.circuitDeferrals, 0),
      rateLimited: jobs.reduce((sum, job) => sum + job.rateLimitDeferrals, 0),
    },
    latencyMs: {
      queueWait: distribution(queueWait),
      endToEndCompleted: distribution(endToEnd),
    },
    failureDistribution: countBy(
      attempts.filter((attempt) => attempt.outcome !== 'succeeded'),
      (attempt) => attempt.errorKind ?? attempt.outcome ?? 'unknown',
    ),
    terminalReasons: countBy(
      jobs.filter((job) => job.status === 'failed' || job.status === 'dead_lettered'),
      (job) => job.terminalReason,
    ),
    circuitBreaker: {
      transitions: transitions.map((t) => ({
        from: t.fromState,
        to: t.toState,
        atMs: t.occurredAt.getTime() - startedAt,
        reason: t.reason,
      })),
      timesOpened: transitions.filter((t) => t.toState === 'OPEN').length,
    },
    ...(upstream
      ? {
          upstream: {
            requests: upstream.requests,
            byOutcome: upstream.byOutcome,
            peakRequestsPerSecond: upstream.peakRequestsPerSecond,
            maxConcurrentRequests: upstream.maxInFlight,
            successfulResponses: upstream.successfulResponses,
            policiesServedMoreThanOnce: upstream.policiesServedMoreThanOnce,
          },
        }
      : {}),
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 10_000;
}
