import { execSync } from 'node:child_process';
import { Redis } from 'ioredis';
import { loadDotEnv } from '../../src/config/env.js';
import { testDatabaseUrl, testRedisUrl } from './test-env.js';

/** Applies migrations to the test database and clears the test Redis database once per run. */
export default async function setup(): Promise<void> {
  loadDotEnv();
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    stdio: 'pipe',
  });
  const redis = new Redis(testRedisUrl());
  await redis.flushdb();
  await redis.quit();
}
