import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ExperimentSummary } from '../../src/experiments/summary.js';
import { ADMIN_HEADER, createTestContext, type TestContext } from '../helpers/context.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await ctx.reset();
});

async function runExperiment(
  body: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<ExperimentSummary> {
  const started = await request(ctx.app).post('/experiments').set(ADMIN_HEADER).send(body);
  expect(started.status).toBe(202);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(ctx.app).get(`/experiments/${started.body.id}`);
    expect(res.status).toBe(200);
    if (res.body.status === 'completed') return res.body as ExperimentSummary;
    if (Date.now() > deadline)
      throw new Error(`experiment still running: ${JSON.stringify(res.body.totals)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('experiments', () => {
  it('runs a reproducible intermittent-failure experiment and reports measured outcomes', async () => {
    ctx.startWorker();
    const body = { scenario: 'intermittent', seed: 7, jobCount: 20, duplicateSubmissions: 5 };
    const first = await runExperiment(body);

    const carrier = first.carriers.northwind!;
    expect(first.totals.jobs).toBe(20);
    expect(first.idempotency).toMatchObject({
      submissions: 25,
      jobsCreated: 20,
      duplicateSubmissionsDeduplicated: 5,
      jobsWithMultipleSuccessfulAttempts: 0,
    });
    expect(first.idempotency.policyRecords).toBe(first.idempotency.distinctPoliciesCompleted);
    expect(first.idempotency.successfulAttempts).toBe(first.totals.completed);
    // Every attempt is one upstream request, as counted independently by the mock carrier.
    expect(carrier.upstream?.requests).toBe(carrier.attempts.total);
    for (const kind of Object.keys(carrier.failureDistribution)) {
      expect(['RATE_LIMITED', 'UPSTREAM_ERROR', 'UNAVAILABLE', 'TIMEOUT']).toContain(kind);
    }

    // Same seed => same per-policy fault sequence => identical retry behavior.
    await ctx.reset();
    ctx.startWorker();
    const second = await runExperiment(body);
    expect(second.carriers.northwind!.failureDistribution).toEqual(carrier.failureDistribution);
    expect(second.carriers.northwind!.attempts).toEqual(carrier.attempts);
    expect(second.totals).toEqual(first.totals);
  });

  it('demonstrates outage isolation, dead-lettering and recovery with DLQ replay', async () => {
    ctx.startWorker();
    const outage = await runExperiment({
      scenario: 'outage',
      seed: 3,
      jobCount: 10,
      controlJobCount: 6,
      deadlineMs: 2000,
    });
    expect(outage.carriers.bluepeak!.jobs.deadLettered).toBe(10);
    expect(outage.carriers.bluepeak!.circuitBreaker.timesOpened).toBeGreaterThanOrEqual(1);
    expect(outage.carriers.harborline!.jobs.completed).toBe(6);
    expect(outage.carriers.harborline!.role).toBe('control');

    const recovery = await runExperiment({ scenario: 'recovery', seed: 3, jobCount: 5 });
    expect(recovery.config.replayedDeadLetters).toBe(10);
    expect(recovery.totals).toMatchObject({ jobs: 15, completed: 15, successRate: 1 });
    const transitions = recovery.carriers.bluepeak!.circuitBreaker.transitions.map(
      (t) => `${t.from}->${t.to}`,
    );
    expect(transitions).toContain('HALF_OPEN->CLOSED');

    // The outage summary was frozen when it completed; replays do not rewrite history.
    const frozen = await request(ctx.app).get(`/experiments/${outage.experimentId}`);
    expect(frozen.body.carriers.bluepeak.jobs.deadLettered).toBe(10);
  });

  it('validates experiment requests', async () => {
    const res = await request(ctx.app)
      .post('/experiments')
      .set(ADMIN_HEADER)
      .send({ scenario: 'meteor' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const missing = await request(ctx.app).get('/experiments/7a1c1c5e-3f0e-4d55-9a53-2d2f1d0b9f11');
    expect(missing.status).toBe(404);
  });
});
