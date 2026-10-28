import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/shared/prisma.js';
import { TEST_CARRIERS, createTestContext, type TestContext } from '../helpers/context.js';

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

async function submitMany(carrierId: string, count: number, extra = {}): Promise<Job[]> {
  const jobs: Job[] = [];
  for (let i = 0; i < count; i += 1)
    jobs.push(await ctx.submit(carrierId, `POL-${carrierId}-${i}`, extra));
  return jobs;
}

const waitAll = (jobs: Job[], statuses: string[], timeoutMs = 15_000) =>
  Promise.all(jobs.map((job) => ctx.waitForStatus(job.id, statuses, timeoutMs)));

describe('worker concurrency', () => {
  it('never runs more upstream calls for a carrier than its configured concurrency', async () => {
    ctx.configureCarrier('northwind', { latencyMs: { min: 120, max: 120 } });
    ctx.startWorker({
      carriers: TEST_CARRIERS.map((c) => (c.id === 'northwind' ? { ...c, concurrency: 3 } : c)),
    });
    const jobs = await submitMany('northwind', 12);
    await waitAll(jobs, ['completed']);
    expect(ctx.mock.registry.get('northwind').getStats().maxInFlight).toBe(3);
  });
});

describe('per-carrier rate limiting', () => {
  it('keeps the request rate within the carrier budget across the worker pool', async () => {
    const limited = TEST_CARRIERS.map((c) =>
      c.id === 'northwind' ? { ...c, rateLimit: { capacity: 2, refillPerSecond: 10 } } : c,
    );
    ctx.startWorker({ carriers: limited });
    const started = Date.now();
    const jobs = await submitMany('northwind', 14);
    const done = await waitAll(jobs, ['completed']);
    const elapsed = Date.now() - started;

    // Burst of 2, then 10/s: 14 requests need at least ~1.2s.
    expect(elapsed).toBeGreaterThanOrEqual(1100);
    const stats = ctx.mock.registry.get('northwind').getStats();
    expect(stats.peakRequestsPerSecond).toBeLessThanOrEqual(12);
    expect(done.reduce((sum, job) => sum + job.rateLimitDeferrals, 0)).toBeGreaterThan(0);
    // Waiting for tokens never consumed the retry budget.
    expect(done.every((job) => job.attempts === 1)).toBe(true);
  });
});

describe('circuit breaker', () => {
  it('opens during an outage, short-circuits calls and bounds upstream load', async () => {
    ctx.configureCarrier('bluepeak', { faults: { unavailable: 1 }, retryAfterSeconds: null });
    ctx.startWorker();
    const jobs = await submitMany('bluepeak', 20, { maxAttempts: 4, deadlineMs: 2500 });
    const done = await waitAll(jobs, ['dead_lettered']);

    const transitions = await ctx.prisma.circuitBreakerTransition.findMany({
      where: { carrierId: 'bluepeak' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(transitions[0]).toMatchObject({ fromState: 'CLOSED', toState: 'OPEN' });

    // Without the breaker, 20 jobs x 4 attempts = 80 calls to a dead carrier.
    const upstream = ctx.mock.registry.get('bluepeak').getStats().requests;
    expect(upstream).toBeLessThan(40);
    expect(done.reduce((sum, job) => sum + job.circuitDeferrals, 0)).toBeGreaterThan(0);
    for (const job of done) {
      expect(['deadline_exceeded', 'attempts_exhausted']).toContain(job.terminalReason);
    }

    const health = await request(ctx.app).get('/carriers/health');
    const bluepeak = health.body.carriers.find(
      (c: { carrierId: string }) => c.carrierId === 'bluepeak',
    );
    expect(['OPEN', 'HALF_OPEN']).toContain(bluepeak.circuitBreaker.state);
  });

  it('probes and closes again once the carrier recovers', async () => {
    ctx.configureCarrier('bluepeak', { faults: { unavailable: 1 }, retryAfterSeconds: null });
    const runtime = ctx.startWorker();
    await waitAll(await submitMany('bluepeak', 6, { maxAttempts: 2, deadlineMs: 2000 }), [
      'dead_lettered',
    ]);
    expect(runtime.breakers.get('bluepeak').currentState()).not.toBe('CLOSED');

    ctx.configureCarrier('bluepeak', {});
    const recovered = await waitAll(
      await Promise.all(Array.from({ length: 6 }, (_, i) => ctx.submit('bluepeak', `POL-R-${i}`))),
      ['completed'],
    );
    expect(recovered).toHaveLength(6);
    expect(runtime.breakers.get('bluepeak').currentState()).toBe('CLOSED');

    const path = (
      await ctx.prisma.circuitBreakerTransition.findMany({
        where: { carrierId: 'bluepeak' },
        orderBy: { occurredAt: 'asc' },
      })
    ).map((t) => `${t.fromState}->${t.toState}`);
    expect(path[0]).toBe('CLOSED->OPEN');
    expect(path.slice(-2)).toEqual(['OPEN->HALF_OPEN', 'HALF_OPEN->CLOSED']);
  });
});

describe('failure isolation', () => {
  it('keeps a healthy carrier fast while another carrier hangs', async () => {
    ctx.configureCarrier('bluepeak', { faults: { timeout: 1 }, hangMs: 30_000 });
    ctx.startWorker();
    const sick = await submitMany('bluepeak', 16, { maxAttempts: 3, deadlineMs: 5000 });
    const healthy = await submitMany('northwind', 16);

    const healthyDone = await waitAll(healthy, ['completed'], 5000);
    const slowest = Math.max(
      ...healthyDone.map((j) => j.finishedAt!.getTime() - j.enqueuedAt.getTime()),
    );
    expect(slowest).toBeLessThan(1500);

    // The hanging carrier is still working through timeouts when the healthy one is done.
    const sickNow = await ctx.prisma.job.findMany({ where: { id: { in: sick.map((j) => j.id) } } });
    expect(sickNow.some((j) => j.status === 'queued' || j.status === 'processing')).toBe(true);
    await waitAll(sick, ['dead_lettered', 'completed'], 15_000);
  });
});
