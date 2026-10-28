import { describe, expect, it } from 'vitest';
import { buildSubmissions } from '../../src/experiments/experiment-service.js';
import { resolvePlan } from '../../src/experiments/scenarios.js';
import { distribution, percentile } from '../../src/experiments/stats.js';
import { buildExperimentSummary, type SummaryJob } from '../../src/experiments/summary.js';

describe('percentile', () => {
  it('uses nearest rank', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 99)).toBe(99);
    expect(percentile(values, 100)).toBe(100);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });

  it('summarizes a distribution', () => {
    expect(distribution([30, 10, 20])).toEqual({
      count: 3,
      p50: 20,
      p95: 30,
      p99: 30,
      max: 30,
      mean: 20,
    });
  });
});

describe('buildSubmissions', () => {
  it('is deterministic and includes duplicates of primary keys', () => {
    const plan = resolvePlan({
      scenario: 'healthy',
      seed: 42,
      jobCount: 20,
      duplicateSubmissions: 5,
    });
    const a = buildSubmissions(plan, 'exp-1');
    const b = buildSubmissions(plan, 'exp-1');
    expect(a).toEqual(b);
    expect(a).toHaveLength(25);
    expect(new Set(a.map((s) => s.idempotencyKey)).size).toBe(20);
    expect(a.every((s) => s.policyId.startsWith('POL-A42-'))).toBe(true);
  });

  it('adds control-carrier jobs for the outage scenario', () => {
    const plan = resolvePlan({ scenario: 'outage', seed: 1 });
    const submissions = buildSubmissions(plan, 'exp-2');
    expect(submissions.filter((s) => s.carrierId === 'bluepeak')).toHaveLength(60);
    expect(submissions.filter((s) => s.carrierId === 'harborline')).toHaveLength(40);
  });
});

describe('buildExperimentSummary', () => {
  const startedAt = new Date('2026-01-01T00:00:00Z');
  const at = (ms: number) => new Date(startedAt.getTime() + ms);
  const job = (id: string, overrides: Partial<SummaryJob>): SummaryJob => ({
    id,
    carrierId: 'northwind',
    policyId: `POL-${id}`,
    status: 'completed',
    circuitDeferrals: 0,
    rateLimitDeferrals: 0,
    enqueuedAt: at(0),
    runStartedAt: at(10),
    finishedAt: at(100),
    terminalReason: null,
    ...overrides,
  });

  it('computes outcomes from recorded jobs and attempts only', () => {
    const plan = resolvePlan({ scenario: 'intermittent', seed: 1, jobCount: 3 });
    const summary = buildExperimentSummary({
      experiment: { id: 'e1', startedAt, completedAt: null, status: 'running' },
      plan,
      submission: { submissions: 4, created: 3, deduplicated: 1, replayedJobIds: [] },
      jobs: [
        job('1', {}),
        job('2', { finishedAt: at(400), circuitDeferrals: 2 }),
        job('3', {
          status: 'dead_lettered',
          terminalReason: 'attempts_exhausted',
          finishedAt: at(900),
        }),
      ],
      attempts: [
        { jobId: '1', outcome: 'succeeded', errorKind: null },
        { jobId: '2', outcome: 'retryable_error', errorKind: 'RATE_LIMITED' },
        { jobId: '2', outcome: 'succeeded', errorKind: null },
        { jobId: '3', outcome: 'retryable_error', errorKind: 'UNAVAILABLE' },
        { jobId: '3', outcome: 'retryable_error', errorKind: 'TIMEOUT' },
      ],
      transitions: [],
      policyRecords: 2,
      now: at(1000),
    });

    expect(summary.status).toBe('completed');
    expect(summary.durationMs).toBe(900);
    expect(summary.totals).toEqual({ jobs: 3, completed: 2, successRate: 0.6667 });
    const carrier = summary.carriers.northwind!;
    expect(carrier.attempts).toEqual({ total: 5, retries: 2, jobsRetried: 2, maxPerJob: 2 });
    expect(carrier.failureDistribution).toEqual({ RATE_LIMITED: 1, UNAVAILABLE: 1, TIMEOUT: 1 });
    expect(carrier.terminalReasons).toEqual({ attempts_exhausted: 1 });
    expect(carrier.deferrals.circuitOpen).toBe(2);
    expect(carrier.latencyMs.endToEndCompleted).toMatchObject({ count: 2, max: 400 });
    expect(summary.idempotency).toMatchObject({
      duplicateSubmissionsDeduplicated: 1,
      successfulAttempts: 2,
      jobsWithMultipleSuccessfulAttempts: 0,
      distinctPoliciesCompleted: 2,
      policyRecords: 2,
    });
  });

  it('reports running while any job is not terminal', () => {
    const plan = resolvePlan({ scenario: 'healthy', seed: 1, jobCount: 2 });
    const summary = buildExperimentSummary({
      experiment: { id: 'e1', startedAt, completedAt: null, status: 'running' },
      plan,
      submission: { submissions: 2, created: 2, deduplicated: 0, replayedJobIds: [] },
      jobs: [job('1', {}), job('2', { status: 'queued', finishedAt: null })],
      attempts: [],
      transitions: [],
      policyRecords: 1,
      now: at(5000),
    });
    expect(summary.status).toBe('running');
    expect(summary.completedAt).toBeNull();
    expect(summary.carriers.northwind!.jobs.inFlight).toBe(1);
  });
});
