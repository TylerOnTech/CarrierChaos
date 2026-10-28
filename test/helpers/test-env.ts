import { loadDotEnv } from '../../src/config/env.js';

/**
 * Integration tests TRUNCATE tables, so they only ever run against a database whose name
 * contains "test" (TEST_DATABASE_URL), never the development database.
 */
export function testDatabaseUrl(): string {
  loadDotEnv();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set; see .env.example (integration tests need Postgres + Redis)',
    );
  }
  const database = new URL(url).pathname.slice(1);
  if (!database.includes('test')) {
    throw new Error(`refusing to run integration tests against non-test database '${database}'`);
  }
  return url;
}

/** A separate Redis logical database (15 by default) keeps test keys away from dev data. */
export function testRedisUrl(): string {
  loadDotEnv();
  return process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
}
