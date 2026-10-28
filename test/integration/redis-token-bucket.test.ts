import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisTokenBucket } from '../../src/resilience/redis-token-bucket.js';
import { createRedis } from '../../src/shared/redis.js';
import { testRedisUrl } from '../helpers/test-env.js';

let redis: Redis;

beforeAll(() => {
  redis = createRedis(testRedisUrl());
});
afterAll(async () => {
  await redis.quit();
});

describe('RedisTokenBucket', () => {
  it('shares one budget between limiter instances (i.e. between worker processes)', async () => {
    const key = `bucket-test:${randomUUID()}`;
    const config = { capacity: 5, refillPerSecond: 1 };
    const workerA = new RedisTokenBucket(redis, key, config);
    const workerB = new RedisTokenBucket(redis, key, config);

    const decisions = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 ? workerA : workerB).tryAcquire()),
    );
    expect(decisions.filter((d) => d.allowed)).toHaveLength(5);
    const denied = decisions.filter((d) => !d.allowed);
    for (const decision of denied) {
      expect(decision.retryAfterMs).toBeGreaterThan(900);
      expect(decision.retryAfterMs).toBeLessThanOrEqual(1000);
    }
  });

  it('refills at the configured rate', async () => {
    const key = `bucket-test:${randomUUID()}`;
    const bucket = new RedisTokenBucket(redis, key, { capacity: 1, refillPerSecond: 20 });
    expect((await bucket.tryAcquire()).allowed).toBe(true);
    const denied = await bucket.tryAcquire();
    expect(denied.allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, denied.retryAfterMs + 10));
    expect((await bucket.tryAcquire()).allowed).toBe(true);
  });

  it('expires idle bucket state', async () => {
    const key = `bucket-test:${randomUUID()}`;
    await new RedisTokenBucket(redis, key, { capacity: 10, refillPerSecond: 5 }).tryAcquire();
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(4000);
  });
});
