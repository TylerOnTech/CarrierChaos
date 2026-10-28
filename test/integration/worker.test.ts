import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RETRIEVAL_JOB_NAME } from '../../src/jobs/queues.js';
import { processRetrievalJob } from '../../src/worker/processor.js';
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

const attemptsOf = (jobId: string) =>
  ctx.prisma.jobAttempt.findMany({
    where: { jobId },
    orderBy: [{ run: 'asc' }, { attemptNumber: 'asc' }],
  });

describe('background processing', () => {
  it('retrieves, validates and persists a policy', async () => {
    ctx.startWorker();
    const job = await ctx.submit('northwind', 'POL-1');
    const done = await ctx.waitForStatus(job.id, ['completed']);
    expect(done).toMatchObject({ attempts: 1, executionCount: 1, lastErrorKind: null });

    const res = await request(ctx.app).get(`/jobs/${job.id}`);
    expect(res.body.result.policy).toMatchObject({ carrierId: 'northwind', policyId: 'POL-1' });
    expect(res.body.attemptHistory).toEqual([
      expect.objectContaining({ outcome: 'succeeded', httpStatus: 200 }),
    ]);
    expect(await ctx.prisma.policyRecord.count()).toBe(1);
  });

  it('recovers automatically from transient failures and honors Retry-After', async () => {
    ctx.configureCarrier('northwind', {
      sequence: ['server_error', 'rate_limit', 'ok'],
      retryAfterSeconds: 0.4,
    });
    ctx.startWorker();
    const job = await ctx.submit('northwind', 'POL-1');
    await ctx.waitForStatus(job.id, ['completed']);

    const attempts = await attemptsOf(job.id);
    expect(attempts.map((a) => [a.outcome, a.errorKind])).toEqual([
      ['retryable_error', 'UPSTREAM_ERROR'],
      ['retryable_error', 'RATE_LIMITED'],
      ['succeeded', null],
    ]);
    // The 429 asked for 400ms; the next attempt must not start earlier.
    expect(attempts[1]!.retryDelayMs).toBeGreaterThanOrEqual(400);
    const gap = attempts[2]!.startedAt.getTime() - attempts[1]!.finishedAt!.getTime();
    expect(gap).toBeGreaterThanOrEqual(390);
  });

  it('fails permanently without retrying a non-retryable error (404)', async () => {
    ctx.startWorker();
    const job = await ctx.submit('northwind', 'MISSING-1');
    const done = await ctx.waitForStatus(job.id, ['failed']);
    expect(done).toMatchObject({
      attempts: 1,
      lastErrorKind: 'NOT_FOUND',
      terminalReason: 'non_retryable',
    });
    expect(await ctx.prisma.deadLetter.count()).toBe(0);
  });

  it('does not persist anything for a schema violation', async () => {
    ctx.configureCarrier('northwind', { sequence: ['schema_violation'] });
    ctx.startWorker();
    const job = await ctx.submit('northwind', 'POL-1');
    const done = await ctx.waitForStatus(job.id, ['failed']);
    expect(done.lastErrorKind).toBe('SCHEMA_VIOLATION');
    expect(await ctx.prisma.policyRecord.count()).toBe(0);
  });

  it('refreshes an expired session token and succeeds', async () => {
    ctx.configureCarrier('northwind', { sequence: ['auth_error'] });
    ctx.startWorker();
    const job = await ctx.submit('northwind', 'POL-1');
    const done = await ctx.waitForStatus(job.id, ['completed']);
    expect(done.attempts).toBe(2);
  });

  it('bounds hanging upstream calls with the request timeout', async () => {
    ctx.configureCarrier('northwind', { faults: { timeout: 1 }, hangMs: 30_000 });
    ctx.startWorker();
    const job = await ctx.submit('northwind', 'POL-1', { maxAttempts: 2 });
    const started = Date.now();
    await ctx.waitForStatus(job.id, ['dead_lettered']);
    expect(Date.now() - started).toBeLessThan(3000);
    const attempts = await attemptsOf(job.id);
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      expect(attempt.errorKind).toBe('TIMEOUT');
      expect(attempt.durationMs).toBeGreaterThanOrEqual(290);
      expect(attempt.durationMs).toBeLessThan(1000);
    }
  });
});

describe('dead-letter handling', () => {
  it('dead-letters after exhausting retries, then replays under operator control', async () => {
    ctx.configureCarrier('northwind', { faults: { unavailable: 1 }, retryAfterSeconds: null });
    ctx.startWorker();
    const job = await ctx.submit('northwind', 'POL-1', { maxAttempts: 3 });
    const dead = await ctx.waitForStatus(job.id, ['dead_lettered']);
    expect(dead).toMatchObject({
      attempts: 3,
      terminalReason: 'attempts_exhausted',
      lastErrorKind: 'UNAVAILABLE',
    });

    const dlq = await request(ctx.app).get('/dead-letters');
    expect(dlq.body.data).toEqual([
      expect.objectContaining({
        jobId: job.id,
        reason: 'attempts_exhausted',
        errorKind: 'UNAVAILABLE',
        attempts: 3,
        replayedAt: null,
      }),
    ]);

    // Carrier recovers; the operator replays the dead letter.
    ctx.configureCarrier('northwind', {});
    const replay = await request(ctx.app).post(`/jobs/${job.id}/retry`).set(ADMIN_HEADER);
    expect(replay.status).toBe(202);
    const done = await ctx.waitForStatus(job.id, ['completed']);
    expect(done).toMatchObject({ replayCount: 1, attempts: 1 });

    const attempts = await attemptsOf(job.id);
    expect(attempts.map((a) => [a.run, a.attemptNumber, a.outcome])).toEqual([
      [0, 1, 'retryable_error'],
      [0, 2, 'retryable_error'],
      [0, 3, 'retryable_error'],
      [1, 1, 'succeeded'],
    ]);
    const entry = await ctx.prisma.deadLetter.findFirstOrThrow({ where: { jobId: job.id } });
    expect(entry.replayedAt).not.toBeNull();
    expect((await request(ctx.app).get('/dead-letters')).body.data).toEqual([]);
  });

  it('allows only one concurrent replay of the same dead letter', async () => {
    ctx.configureCarrier('northwind', { faults: { unavailable: 1 }, retryAfterSeconds: null });
    const worker = ctx.startWorker();
    const job = await ctx.submit('northwind', 'POL-1', { maxAttempts: 1 });
    await ctx.waitForStatus(job.id, ['dead_lettered']);
    await worker.close();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(ctx.app).post(`/jobs/${job.id}/retry`).set(ADMIN_HEADER),
      ),
    );
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
  });
});

describe('idempotent effects under at-least-once delivery', () => {
  it('keeps one policy record when the same policy is retrieved by different jobs', async () => {
    ctx.startWorker();
    const a = await ctx.submit('northwind', 'POL-SAME');
    const b = await ctx.submit('northwind', 'POL-SAME');
    await ctx.waitForStatus(a.id, ['completed']);
    await ctx.waitForStatus(b.id, ['completed']);
    const records = await ctx.prisma.policyRecord.findMany();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ fetchCount: 2, version: 1 });
  });

  it('turns a redelivered message for a completed job into a no-op', async () => {
    ctx.startWorker();
    const job = await ctx.submit('northwind', 'POL-1');
    await ctx.waitForStatus(job.id, ['completed']);
    const requestsBefore = ctx.mock.registry.get('northwind').getStats().requests;

    // Simulate a duplicate delivery: a second queue message for the same job.
    const duplicate = await ctx.queues
      .get('northwind')
      .add(RETRIEVAL_JOB_NAME, { jobId: job.id }, { jobId: 'duplicate-delivery' });
    await expect.poll(() => duplicate.getState(), { timeout: 5000 }).toBe('completed');

    expect(ctx.mock.registry.get('northwind').getStats().requests).toBe(requestsBefore);
    const after = await ctx.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after).toMatchObject({ attempts: 1, executionCount: 1 });
    expect((await ctx.prisma.policyRecord.findFirstOrThrow()).fetchCount).toBe(1);
  });

  it('ignores direct re-execution of a terminal job', async () => {
    const runtime = ctx.startWorker();
    const job = await ctx.submit('northwind', 'POL-1');
    await ctx.waitForStatus(job.id, ['completed']);
    await expect(processRetrievalJob(job.id, runtime.processorDeps)).resolves.toEqual({
      type: 'skipped',
      reason: 'terminal',
    });
  });
});

describe('cancellation', () => {
  it('stops an in-flight job at its next checkpoint instead of retrying it', async () => {
    ctx.configureCarrier('northwind', { faults: { timeout: 1 }, hangMs: 30_000 });
    ctx.startWorker();
    const job = await ctx.submit('northwind', 'POL-1', { maxAttempts: 4 });
    await ctx.waitForStatus(job.id, ['processing']);

    const res = await request(ctx.app).post(`/jobs/${job.id}/cancel`).set(ADMIN_HEADER);
    expect(res.status).toBe(202);
    const done = await ctx.waitForStatus(job.id, ['cancelled']);
    expect(done.attempts).toBe(1);
    expect(done.lastErrorKind).toBe('TIMEOUT');
  });
});
