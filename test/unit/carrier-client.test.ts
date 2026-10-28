import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CarrierClient } from '../../src/carriers/carrier-client.js';
import type { FailureProfileInput } from '../../src/mock-carrier/failure-profile.js';
import { CarrierError } from '../../src/resilience/errors.js';
import { startMockCarrier, type MockCarrier } from '../helpers/mock-carrier.js';

let mock: MockCarrier;
let fetchCalls: string[];

const countingFetch: typeof fetch = (input, init) => {
  fetchCalls.push(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  return fetch(input, init);
};

function client(overrides: Partial<ConstructorParameters<typeof CarrierClient>[0]> = {}) {
  return new CarrierClient({
    carrierId: 'northwind',
    baseUrl: mock.url,
    timeoutMs: 300,
    fetchImpl: countingFetch,
    ...overrides,
  });
}

function configure(profile: FailureProfileInput) {
  mock.registry.get('northwind').configure({ latencyMs: { min: 1, max: 3 }, ...profile });
}

async function expectCarrierError(promise: Promise<unknown>): Promise<CarrierError> {
  const error = await promise.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CarrierError);
  return error as CarrierError;
}

beforeAll(async () => {
  mock = await startMockCarrier();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  fetchCalls = [];
  configure({});
});

describe('CarrierClient', () => {
  it('returns a validated NormalizedPolicy and reuses its session token', async () => {
    const c = client();
    const policy = await c.fetchPolicy('POL-1');
    expect(policy).toMatchObject({
      schemaVersion: 'normalized-policy/v1',
      carrierId: 'northwind',
      policyId: 'POL-1',
    });
    await c.fetchPolicy('POL-2');
    expect(fetchCalls.filter((url) => url.endsWith('/oauth/token'))).toHaveLength(1);
  });

  it('classifies HTTP 429 as RATE_LIMITED and parses Retry-After', async () => {
    configure({ sequence: ['rate_limit'], retryAfterSeconds: 2 });
    const error = await expectCarrierError(client().fetchPolicy('POL-1'));
    expect(error).toMatchObject({
      kind: 'RATE_LIMITED',
      status: 429,
      retryAfterMs: 2000,
      retryable: true,
    });
  });

  it('classifies HTTP 500 and 503 as retryable upstream failures', async () => {
    configure({ sequence: ['server_error', 'unavailable'], retryAfterSeconds: 3 });
    const c = client();
    expect(await expectCarrierError(c.fetchPolicy('POL-1'))).toMatchObject({
      kind: 'UPSTREAM_ERROR',
      status: 500,
      retryable: true,
    });
    expect(await expectCarrierError(c.fetchPolicy('POL-1'))).toMatchObject({
      kind: 'UNAVAILABLE',
      status: 503,
      retryAfterMs: 3000,
    });
  });

  it('enforces the request timeout against a hanging carrier and releases the connection', async () => {
    configure({ sequence: ['timeout'], hangMs: 10_000 });
    const started = Date.now();
    const error = await expectCarrierError(client({ timeoutMs: 200 }).fetchPolicy('POL-1'));
    const elapsed = Date.now() - started;
    expect(error).toMatchObject({ kind: 'TIMEOUT', retryable: true });
    expect(elapsed).toBeGreaterThanOrEqual(190);
    expect(elapsed).toBeLessThan(1500);
    // The aborted request must not keep occupying the carrier's (or our) connection.
    await expect.poll(() => mock.registry.get('northwind').getStats().inFlight).toBe(0);
  });

  it('succeeds on a slow response that is still within the time limit', async () => {
    configure({ sequence: ['slow'], slowResponseMs: 100 });
    await expect(client({ timeoutMs: 1000 }).fetchPolicy('POL-1')).resolves.toMatchObject({
      policyId: 'POL-1',
    });
  });

  it('classifies a connection terminated mid-response as CONNECTION_ERROR', async () => {
    configure({ sequence: ['connection_reset'] });
    const error = await expectCarrierError(client({ timeoutMs: 1000 }).fetchPolicy('POL-1'));
    expect(error).toMatchObject({ kind: 'CONNECTION_ERROR', retryable: true });
  });

  it('classifies a refused connection as CONNECTION_ERROR', async () => {
    const error = await expectCarrierError(
      client({ baseUrl: 'http://127.0.0.1:1' }).fetchPolicy('POL-1'),
    );
    expect(error.kind).toBe('CONNECTION_ERROR');
  });

  it('classifies unparseable bodies as INVALID_RESPONSE', async () => {
    configure({ faults: { invalid_json: 1 } });
    const c = client();
    for (const policyId of ['POL-1', 'POL-2', 'POL-3', 'POL-4']) {
      expect((await expectCarrierError(c.fetchPolicy(policyId))).kind).toBe('INVALID_RESPONSE');
    }
  });

  it('rejects contract violations as non-retryable SCHEMA_VIOLATION with details', async () => {
    configure({ sequence: ['schema_violation'] });
    const error = await expectCarrierError(client().fetchPolicy('POL-1'));
    expect(error).toMatchObject({ kind: 'SCHEMA_VIOLATION', retryable: false });
    expect(error.message).toMatch(/violates NormalizedPolicy v1/);
  });

  it('treats 401 as a retryable expired session and refreshes the token on the next attempt', async () => {
    configure({ sequence: ['auth_error', 'ok'] });
    const c = client();
    expect((await expectCarrierError(c.fetchPolicy('POL-1'))).kind).toBe('AUTH_EXPIRED');
    await expect(c.fetchPolicy('POL-1')).resolves.toMatchObject({ policyId: 'POL-1' });
    expect(fetchCalls.filter((url) => url.endsWith('/oauth/token'))).toHaveLength(2);
  });

  it('treats rejected client credentials as permanent AUTH_FORBIDDEN', async () => {
    const error = await expectCarrierError(
      client({ clientSecret: 'revoked-secret' }).fetchPolicy('POL-1'),
    );
    expect(error).toMatchObject({ kind: 'AUTH_FORBIDDEN', retryable: false });
  });

  it('treats a missing policy as permanent NOT_FOUND', async () => {
    const error = await expectCarrierError(client().fetchPolicy('MISSING-1'));
    expect(error).toMatchObject({ kind: 'NOT_FOUND', status: 404, retryable: false });
  });
});
