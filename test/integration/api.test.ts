import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bullJobId } from '../../src/jobs/queues.js';
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

const submit = (body: Record<string, unknown>, key?: string) => {
  const req = request(ctx.app).post('/jobs');
  return (key ? req.set('Idempotency-Key', key) : req).send(body);
};

function expectErrorContract(body: unknown, code: string) {
  expect(body).toMatchObject({ error: { code, message: expect.any(String) } });
}

describe('POST /jobs', () => {
  it('creates a queued job, persists it and enqueues exactly one BullMQ message', async () => {
    const res = await submit({ carrierId: 'northwind', policyId: 'POL-1' }, 'key-1');
    expect(res.status).toBe(202);
    expect(res.headers['idempotent-replayed']).toBe('false');
    expect(res.headers.location).toBe(`/jobs/${res.body.id}`);
    expect(res.body).toMatchObject({
      status: 'queued',
      carrierId: 'northwind',
      policyId: 'POL-1',
      attempts: 0,
    });

    const state = await ctx.queues.get('northwind').getJobState(bullJobId(res.body.id, 0));
    expect(state).toBe('waiting');
    expect(await ctx.prisma.job.count()).toBe(1);
  });

  it('returns the original job for a duplicate submission (idempotent replay)', async () => {
    const first = await submit({ carrierId: 'northwind', policyId: 'POL-1' }, 'key-1');
    const second = await submit({ carrierId: 'northwind', policyId: 'POL-1' }, 'key-1');
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
    expect(await ctx.prisma.job.count()).toBe(1);
    expect(await ctx.queues.get('northwind').count()).toBe(1);
  });

  it('creates exactly one job under 25 concurrent duplicate submissions', async () => {
    const responses = await Promise.all(
      Array.from({ length: 25 }, () =>
        submit({ carrierId: 'northwind', policyId: 'POL-RACE' }, 'race-key'),
      ),
    );
    const ids = new Set(responses.map((r) => r.body.id as string));
    expect(ids.size).toBe(1);
    expect(responses.filter((r) => r.status === 202)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(24);
    expect(await ctx.prisma.job.count()).toBe(1);
  });

  it('rejects reuse of an idempotency key with a different payload', async () => {
    const first = await submit({ carrierId: 'northwind', policyId: 'POL-1' }, 'key-1');
    const res = await submit({ carrierId: 'northwind', policyId: 'POL-2' }, 'key-1');
    expect(res.status).toBe(409);
    expectErrorContract(res.body, 'IDEMPOTENCY_KEY_CONFLICT');
    expect(res.body.error.details).toEqual({ existingJobId: first.body.id });
  });

  it('accepts the idempotency key in the body', async () => {
    const res = await submit({
      carrierId: 'northwind',
      policyId: 'POL-1',
      idempotencyKey: 'body-key',
    });
    expect(res.status).toBe(202);
    expect(res.body.idempotencyKey).toBe('body-key');
  });

  it('requires an idempotency key', async () => {
    const res = await submit({ carrierId: 'northwind', policyId: 'POL-1' });
    expect(res.status).toBe(400);
    expectErrorContract(res.body, 'IDEMPOTENCY_KEY_REQUIRED');
  });

  it('validates the payload with field-level details', async () => {
    const res = await submit(
      { carrierId: 'northwind', policyId: 'bad id!', maxAttempts: 0, extra: true },
      'k',
    );
    expect(res.status).toBe(400);
    expectErrorContract(res.body, 'VALIDATION_ERROR');
    const paths = (res.body.error.details as Array<{ path: string }>).map((d) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['policyId', 'maxAttempts']));
    expect(res.body.error.requestId).toEqual(expect.any(String));
  });

  it('rejects unknown carriers', async () => {
    const res = await submit({ carrierId: 'acme', policyId: 'POL-1' }, 'k');
    expect(res.status).toBe(400);
    expectErrorContract(res.body, 'UNKNOWN_CARRIER');
  });

  it('rejects malformed JSON', async () => {
    const res = await request(ctx.app)
      .post('/jobs')
      .set('content-type', 'application/json')
      .set('Idempotency-Key', 'k')
      .send('{"carrierId": ');
    expect(res.status).toBe(400);
    expectErrorContract(res.body, 'INVALID_JSON');
  });
});

describe('GET /jobs and /jobs/:id', () => {
  it('returns job details with attempt history', async () => {
    const created = await submit({ carrierId: 'northwind', policyId: 'POL-1' }, 'k');
    const res = await request(ctx.app).get(`/jobs/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: created.body.id,
      attemptHistory: [],
      deadLetters: [],
      result: null,
    });
  });

  it('returns 404 for an unknown job and 400 for a malformed id', async () => {
    const missing = await request(ctx.app).get('/jobs/7a1c1c5e-3f0e-4d55-9a53-2d2f1d0b9f11');
    expect(missing.status).toBe(404);
    expectErrorContract(missing.body, 'NOT_FOUND');
    const malformed = await request(ctx.app).get('/jobs/not-a-uuid');
    expect(malformed.status).toBe(400);
    expectErrorContract(malformed.body, 'VALIDATION_ERROR');
  });

  it('lists with filters and stable cursor pagination', async () => {
    for (let i = 0; i < 5; i += 1)
      await submit({ carrierId: 'northwind', policyId: `POL-${i}` }, `k-${i}`);
    await submit({ carrierId: 'bluepeak', policyId: 'POL-X' }, 'k-x');

    const page1 = await request(ctx.app).get('/jobs').query({ carrierId: 'northwind', limit: 2 });
    expect(page1.body.data).toHaveLength(2);
    const page2 = await request(ctx.app)
      .get('/jobs')
      .query({ carrierId: 'northwind', limit: 2, cursor: page1.body.nextCursor });
    const page3 = await request(ctx.app)
      .get('/jobs')
      .query({ carrierId: 'northwind', limit: 2, cursor: page2.body.nextCursor });
    const all = [...page1.body.data, ...page2.body.data, ...page3.body.data].map(
      (j: { policyId: string }) => j.policyId,
    );
    expect(all.sort()).toEqual(['POL-0', 'POL-1', 'POL-2', 'POL-3', 'POL-4']);
    expect(page3.body.nextCursor).toBeNull();

    const bad = await request(ctx.app).get('/jobs').query({ cursor: 'garbage' });
    expect(bad.status).toBe(400);
    expectErrorContract(bad.body, 'INVALID_CURSOR');
    const badStatus = await request(ctx.app).get('/jobs').query({ status: 'exploded' });
    expect(badStatus.status).toBe(400);
  });
});

describe('admin operations', () => {
  it('require the admin token', async () => {
    const created = await submit({ carrierId: 'northwind', policyId: 'POL-1' }, 'k');
    const noToken = await request(ctx.app).post(`/jobs/${created.body.id}/cancel`);
    expect(noToken.status).toBe(401);
    expectErrorContract(noToken.body, 'UNAUTHORIZED');
    const wrong = await request(ctx.app)
      .post(`/jobs/${created.body.id}/retry`)
      .set('authorization', 'Bearer nope');
    expect(wrong.status).toBe(401);
    const experiment = await request(ctx.app).post('/experiments').send({ scenario: 'healthy' });
    expect(experiment.status).toBe(401);
  });

  it('cancels a queued job and removes its queue message', async () => {
    const created = await submit({ carrierId: 'northwind', policyId: 'POL-1' }, 'k');
    const res = await request(ctx.app).post(`/jobs/${created.body.id}/cancel`).set(ADMIN_HEADER);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      outcome: 'cancelled',
      job: { status: 'cancelled', terminalReason: 'cancelled' },
    });
    expect(
      await ctx.queues.getState({ id: created.body.id, carrierId: 'northwind', replayCount: 0 }),
    ).toBe('unknown');

    const again = await request(ctx.app).post(`/jobs/${created.body.id}/cancel`).set(ADMIN_HEADER);
    expect(again.body.outcome).toBe('already_cancelled');
  });

  it('flags an in-flight job for cancellation instead of interrupting it', async () => {
    const job = await ctx.submit('northwind', 'POL-1');
    await ctx.prisma.job.update({ where: { id: job.id }, data: { status: 'processing' } });
    const res = await request(ctx.app).post(`/jobs/${job.id}/cancel`).set(ADMIN_HEADER);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      outcome: 'cancel_requested',
      job: { status: 'processing', cancelRequested: true },
    });
  });

  it('refuses to cancel or retry a completed job', async () => {
    const job = await ctx.submit('northwind', 'POL-1');
    await ctx.prisma.job.update({ where: { id: job.id }, data: { status: 'completed' } });
    const cancel = await request(ctx.app).post(`/jobs/${job.id}/cancel`).set(ADMIN_HEADER);
    expect(cancel.status).toBe(409);
    expectErrorContract(cancel.body, 'INVALID_STATE_TRANSITION');
    const retry = await request(ctx.app).post(`/jobs/${job.id}/retry`).set(ADMIN_HEADER);
    expect(retry.status).toBe(409);
    expect(retry.body.error.details).toEqual({ currentStatus: 'completed', action: 'retry' });
  });

  it('refuses to retry a job that is still queued', async () => {
    const job = await ctx.submit('northwind', 'POL-1');
    const res = await request(ctx.app).post(`/jobs/${job.id}/retry`).set(ADMIN_HEADER);
    expect(res.status).toBe(409);
  });

  it('retries a cancelled job as a new run with a new queue message', async () => {
    const job = await ctx.submit('northwind', 'POL-1');
    await request(ctx.app).post(`/jobs/${job.id}/cancel`).set(ADMIN_HEADER);
    const res = await request(ctx.app).post(`/jobs/${job.id}/retry`).set(ADMIN_HEADER);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'queued', run: 1, attempts: 0 });
    expect(await ctx.queues.getState({ id: job.id, carrierId: 'northwind', replayCount: 1 })).toBe(
      'waiting',
    );
  });

  it('returns 404 when operating on an unknown job', async () => {
    const res = await request(ctx.app)
      .post('/jobs/7a1c1c5e-3f0e-4d55-9a53-2d2f1d0b9f11/retry')
      .set(ADMIN_HEADER);
    expect(res.status).toBe(404);
  });
});

describe('system endpoints', () => {
  it('reports dependency health', async () => {
    const res = await request(ctx.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      checks: { postgres: { ok: true }, redis: { ok: true } },
    });
  });

  it('exposes Prometheus metrics including queue depth', async () => {
    await submit({ carrierId: 'northwind', policyId: 'POL-1' }, 'k');
    const res = await request(ctx.app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('carrierchaos_http_requests_total');
    expect(res.text).toMatch(/carrierchaos_queue_jobs\{carrier="northwind",state="waiting"\} 1/);
  });

  it('reports per-carrier health', async () => {
    const res = await request(ctx.app).get('/carriers/health');
    expect(res.status).toBe(200);
    expect(res.body.carriers.map((c: { carrierId: string }) => c.carrierId)).toEqual([
      'northwind',
      'bluepeak',
      'harborline',
    ]);
    expect(res.body.carriers[0]).toMatchObject({
      status: 'unknown',
      circuitBreaker: { state: 'UNKNOWN' },
    });
  });

  it('uses the error contract for unknown routes', async () => {
    const res = await request(ctx.app).get('/nope');
    expect(res.status).toBe(404);
    expectErrorContract(res.body, 'ROUTE_NOT_FOUND');
  });

  it('propagates a caller-supplied request id', async () => {
    const res = await request(ctx.app).get('/jobs/not-a-uuid').set('x-request-id', 'trace-123');
    expect(res.headers['x-request-id']).toBe('trace-123');
    expect(res.body.error.requestId).toBe('trace-123');
  });
});
