import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.js';

const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      env: 'development',
      adminToken: 'dev-admin-token',
      worker: { concurrency: 8, requestTimeoutMs: 2000 },
      retry: { maxAttempts: 5 },
      breaker: { failureRateThreshold: 0.5, minimumRequests: 10, openDurationMs: 5000 },
    });
  });

  it('coerces numeric environment variables', () => {
    expect(loadConfig({ ...base, WORKER_CONCURRENCY: '3' }).worker.concurrency).toBe(3);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it('rejects inconsistent retry settings', () => {
    expect(() =>
      loadConfig({ ...base, RETRY_BASE_DELAY_MS: '500', RETRY_MAX_DELAY_MS: '100' }),
    ).toThrow(/RETRY_MAX_DELAY_MS/);
  });

  it('refuses the development admin token in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(
      /default development ADMIN_TOKEN/,
    );
    expect(
      loadConfig({ ...base, NODE_ENV: 'production', ADMIN_TOKEN: 'a-real-long-secret' }).env,
    ).toBe('production');
  });
});
