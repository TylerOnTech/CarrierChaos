import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/shared/logger.js';
import { Reconciler } from '../../src/worker/reconciler.js';
import { createTestContext, type TestContext } from '../helpers/context.js';

let ctx: TestContext;

beforeAll(async () => {
  // Longer request timeout so a slow upstream call can outlive a crashed worker's lock.
  ctx = await createTestContext({ CARRIER_REQUEST_TIMEOUT_MS: '5000' });
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await ctx.reset();
});

/** BullMQ timings that let a crashed worker's job be detected as stalled within ~1s. */
const fastStall = { lockDuration: 1000, stalledInterval: 300 };

describe('recovery after a worker crash', () => {
  it('redelivers the stalled job to another worker and fences off the crashed execution', async () => {
    // First request is slow (the crashed worker's attempt); the redelivered attempt is fast.
    ctx.configureCarrier('northwind', { sequence: ['slow', 'ok'], slowResponseMs: 2500 });
    const crashed = ctx.startWorker({ workerId: 'worker-a', bullWorkerOptions: fastStall });
    const job = await ctx.submit('northwind', 'POL-1');
    await expect
      .poll(() => ctx.prisma.jobAttempt.count({ where: { jobId: job.id } }), { timeout: 5000 })
      .toBe(1);

    // Simulate a crash: stop the worker without waiting and without releasing the job lock.
    // The in-flight processor keeps running in the background, exactly like a zombie process.
    await Promise.all([...crashed.workers.values()].map((worker) => worker.close(true)));

    ctx.startWorker({ workerId: 'worker-b', bullWorkerOptions: fastStall });
    const done = await ctx.waitForStatus(job.id, ['completed'], 10_000);
    expect(done).toMatchObject({ executionCount: 2, attempts: 2 });

    const attempts = await ctx.prisma.jobAttempt.findMany({
      where: { jobId: job.id },
      orderBy: { attemptNumber: 'asc' },
    });
    expect(attempts.map((a) => [a.workerId, a.outcome])).toEqual([
      ['worker-a', 'abandoned'],
      ['worker-b', 'succeeded'],
    ]);

    // Let the zombie finish: the carrier served the policy twice (at-least-once execution)...
    await expect
      .poll(() => ctx.mock.registry.get('northwind').getStats().successfulResponses, {
        timeout: 5000,
      })
      .toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // ...but there is exactly one persisted effect and one successful result.
    const records = await ctx.prisma.policyRecord.findMany();
    expect(records).toHaveLength(1);
    expect(records[0]!.fetchCount).toBe(1);
    const final = await ctx.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(final.status).toBe('completed');
    expect(
      await ctx.prisma.jobAttempt.count({ where: { jobId: job.id, outcome: 'succeeded' } }),
    ).toBe(1);
  });

  it('respects a persisted retry time when a message is delivered early', async () => {
    const job = await ctx.submit('northwind', 'POL-1');
    // Emulate a crash between "retry persisted in PostgreSQL" and "message delayed in Redis":
    // the message is immediately deliverable, but the job must not run before nextAttemptAt.
    const notBefore = new Date(Date.now() + 800);
    await ctx.prisma.job.update({ where: { id: job.id }, data: { nextAttemptAt: notBefore } });
    ctx.startWorker();
    const done = await ctx.waitForStatus(job.id, ['completed']);
    const attempt = await ctx.prisma.jobAttempt.findFirstOrThrow({ where: { jobId: job.id } });
    expect(attempt.startedAt.getTime()).toBeGreaterThanOrEqual(notBefore.getTime() - 50);
    expect(done.attempts).toBe(1);
  });
});

describe('graceful shutdown', () => {
  it('lets in-flight jobs finish before the worker exits', async () => {
    ctx.configureCarrier('northwind', { sequence: ['slow'], slowResponseMs: 800 });
    const runtime = ctx.startWorker();
    const job = await ctx.submit('northwind', 'POL-1');
    await expect
      .poll(() => ctx.prisma.jobAttempt.count({ where: { jobId: job.id } }), { timeout: 5000 })
      .toBe(1);

    await runtime.close({ timeoutMs: 5000 });
    const after = await ctx.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('completed');
    expect(after.executionCount).toBe(1);
  });

  it('stops accepting new jobs once closed', async () => {
    const runtime = ctx.startWorker();
    await runtime.close();
    const job = await ctx.submit('northwind', 'POL-1');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await ctx.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(
      'queued',
    );
  });
});

describe('reconciler', () => {
  const reconciler = () =>
    new Reconciler({
      prisma: ctx.prisma,
      queues: ctx.queues,
      logger: silentLogger(),
      queuedGraceMs: 0,
      processingStaleMs: 0,
    });

  it('re-enqueues a committed job whose queue message was never written', async () => {
    // As if the API crashed between the INSERT and the enqueue.
    const job = await ctx.prisma.job.create({
      data: {
        idempotencyKey: randomUUID(),
        requestHash: 'x',
        carrierId: 'northwind',
        policyId: 'POL-GAP',
        maxAttempts: 3,
        deadlineAt: new Date(Date.now() + 60_000),
      },
    });
    expect(await ctx.queues.getState({ ...job, replayCount: 0 })).toBe('unknown');

    await expect(reconciler().runOnce()).resolves.toEqual({ reenqueued: 1, deadLettered: 0 });
    await expect(reconciler().runOnce()).resolves.toEqual({ reenqueued: 0, deadLettered: 0 });

    ctx.startWorker();
    await ctx.waitForStatus(job.id, ['completed']);
  });

  it('dead-letters a processing job whose execution was lost', async () => {
    const job = await ctx.prisma.job.create({
      data: {
        idempotencyKey: randomUUID(),
        requestHash: 'x',
        carrierId: 'northwind',
        policyId: 'POL-LOST',
        maxAttempts: 3,
        status: 'processing',
        executionId: randomUUID(),
        attempts: 1,
      },
    });
    await expect(reconciler().runOnce()).resolves.toEqual({ reenqueued: 0, deadLettered: 1 });
    const after = await ctx.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after).toMatchObject({
      status: 'dead_lettered',
      terminalReason: 'worker_lost',
      executionId: null,
    });
    expect(
      await ctx.prisma.deadLetter.count({ where: { jobId: job.id, reason: 'worker_lost' } }),
    ).toBe(1);
  });
});
