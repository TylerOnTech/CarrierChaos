import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import { createApp } from '../../src/api/app.js';
import { carrierHealth, checkHealth } from '../../src/api/health.js';
import { MockCarrierAdminClient } from '../../src/carriers/mock-admin-client.js';
import { CARRIERS, type CarrierDefinition } from '../../src/carriers/registry.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { ExperimentService } from '../../src/experiments/experiment-service.js';
import { JobService } from '../../src/jobs/job-service.js';
import { JobQueues } from '../../src/jobs/queues.js';
import type { FailureProfileInput } from '../../src/mock-carrier/failure-profile.js';
import { silentLogger } from '../../src/shared/logger.js';
import { createApiMetrics, createWorkerMetrics } from '../../src/shared/metrics.js';
import { createPrismaClient, type Job, type PrismaClient } from '../../src/shared/prisma.js';
import { createRedis } from '../../src/shared/redis.js';
import {
  createWorkerRuntime,
  type WorkerRuntime,
  type WorkerRuntimeOptions,
} from '../../src/worker/worker-runtime.js';
import { TEST_ADMIN_TOKEN, startMockCarrier, type MockCarrier } from './mock-carrier.js';
import { testDatabaseUrl, testRedisUrl } from './test-env.js';

export { TEST_ADMIN_TOKEN };
export const ADMIN_HEADER = { authorization: `Bearer ${TEST_ADMIN_TOKEN}` };

/** Fast timings so retry, breaker and deadline behavior can be observed in milliseconds. */
const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  ADMIN_TOKEN: TEST_ADMIN_TOKEN,
  WORKER_CONCURRENCY: '4',
  CARRIER_REQUEST_TIMEOUT_MS: '300',
  RATE_LIMIT_MAX_WAIT_MS: '200',
  RETRY_MAX_ATTEMPTS: '4',
  RETRY_BASE_DELAY_MS: '20',
  RETRY_MAX_DELAY_MS: '200',
  RETRY_MAX_RETRY_AFTER_MS: '5000',
  JOB_DEADLINE_MS: '60000',
  BREAKER_FAILURE_RATE_THRESHOLD: '0.5',
  BREAKER_MINIMUM_REQUESTS: '4',
  BREAKER_WINDOW_MS: '5000',
  BREAKER_OPEN_DURATION_MS: '500',
  BREAKER_HALF_OPEN_MAX_PROBES: '1',
  BREAKER_HALF_OPEN_SUCCESS_THRESHOLD: '2',
  RECONCILER_INTERVAL_MS: '60000',
  SHUTDOWN_TIMEOUT_MS: '10000',
};

/** Generous per-carrier limits so tests only see rate limiting when they ask for it. */
export const TEST_CARRIERS: CarrierDefinition[] = CARRIERS.map((carrier) => ({
  ...carrier,
  rateLimit: { capacity: 200, refillPerSecond: 1000 },
}));

export interface TestContext {
  config: AppConfig;
  prisma: PrismaClient;
  redis: Redis;
  mock: MockCarrier;
  queues: JobQueues;
  jobs: JobService;
  experiments: ExperimentService;
  app: Express;
  configureCarrier(carrierId: string, profile: FailureProfileInput): void;
  startWorker(options?: Partial<WorkerRuntimeOptions>): WorkerRuntime;
  submit(
    carrierId: string,
    policyId: string,
    extra?: { maxAttempts?: number; deadlineMs?: number },
  ): Promise<Job>;
  waitForStatus(jobId: string, statuses: string[], timeoutMs?: number): Promise<Job>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createTestContext(
  envOverrides: Record<string, string> = {},
): Promise<TestContext> {
  const databaseUrl = testDatabaseUrl();
  const redisUrl = testRedisUrl();
  const mock = await startMockCarrier();
  const prisma = createPrismaClient(databaseUrl);
  const redis = createRedis(redisUrl);
  const workerConnection = createRedis(redisUrl, { forWorker: true });
  const logger = silentLogger();
  const runtimes: WorkerRuntime[] = [];

  const ctx = {} as TestContext;

  const build = () => {
    const config = loadConfig({
      ...TEST_ENV,
      ...envOverrides,
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      MOCK_CARRIER_URL: mock.url,
      // A fresh key prefix per test isolates queues, breaker state and rate limiters.
      QUEUE_PREFIX: `cctest-${randomUUID().slice(0, 8)}`,
    });
    const queues = new JobQueues(redis, config.queuePrefix, TEST_CARRIERS);
    const jobs = new JobService({
      prisma,
      queues,
      carriers: TEST_CARRIERS,
      defaults: { maxAttempts: config.retry.maxAttempts, deadlineMs: config.jobDeadlineMs },
      logger,
    });
    const experiments = new ExperimentService({
      prisma,
      jobs,
      mockAdmin: new MockCarrierAdminClient(mock.url, TEST_ADMIN_TOKEN),
      logger,
    });
    const metrics = createApiMetrics({
      carrierIds: () => queues.carrierIds(),
      queueCounts: (id) => queues.counts(id),
      jobStatusCounts: async () => [],
    });
    const app = createApp({
      logger,
      adminToken: config.adminToken,
      prisma,
      jobs,
      experiments,
      metrics,
      health: () => checkHealth(prisma, redis),
      carrierHealth: () =>
        carrierHealth({
          prisma,
          redis,
          queues,
          carriers: TEST_CARRIERS,
          keyPrefix: config.queuePrefix,
          defaultConcurrency: config.worker.concurrency,
        }),
    });
    Object.assign(ctx, { config, queues, jobs, experiments, app });
  };

  const stopWorkers = async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close({ timeoutMs: 5000 })));
  };

  Object.assign(ctx, {
    prisma,
    redis,
    mock,
    configureCarrier(carrierId: string, profile: FailureProfileInput) {
      mock.registry.get(carrierId).configure({ latencyMs: { min: 1, max: 5 }, ...profile });
    },
    startWorker(options: Partial<WorkerRuntimeOptions> = {}) {
      const runtime = createWorkerRuntime({
        config: ctx.config,
        prisma,
        workerConnection,
        redis,
        logger,
        carriers: TEST_CARRIERS,
        metrics: createWorkerMetrics(),
        enableReconciler: false,
        ...options,
      });
      runtimes.push(runtime);
      return runtime;
    },
    async submit(carrierId: string, policyId: string, extra = {}) {
      const { job } = await ctx.jobs.submit({
        carrierId,
        policyId,
        idempotencyKey: randomUUID(),
        ...extra,
      });
      return job;
    },
    async waitForStatus(jobId: string, statuses: string[], timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
        if (statuses.includes(job.status)) return job;
        if (Date.now() > deadline) {
          throw new Error(
            `job ${jobId} still '${job.status}' after ${timeoutMs}ms (wanted ${statuses.join('|')})`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    async reset() {
      await stopWorkers();
      await ctx.queues?.close();
      await prisma.$executeRawUnsafe(
        'TRUNCATE jobs, job_attempts, dead_letters, policy_records, experiments, circuit_breaker_transitions CASCADE',
      );
      for (const carrier of mock.registry.list())
        carrier.configure({ latencyMs: { min: 1, max: 5 } });
      build();
    },
    async close() {
      await stopWorkers();
      await ctx.queues?.close();
      await prisma.$disconnect();
      await redis.quit();
      await workerConnection.quit();
      await mock.close();
    },
  });

  build();
  return ctx;
}
