import { MockCarrierAdminClient } from '../carriers/mock-admin-client.js';
import { CARRIERS } from '../carriers/registry.js';
import { loadConfig, loadDotEnv } from '../config/env.js';
import { ExperimentService } from '../experiments/experiment-service.js';
import { JobService } from '../jobs/job-service.js';
import { JobQueues } from '../jobs/queues.js';
import { createLogger } from '../shared/logger.js';
import { createApiMetrics } from '../shared/metrics.js';
import { createPrismaClient } from '../shared/prisma.js';
import { createRedis } from '../shared/redis.js';
import { createApp } from './app.js';
import { carrierHealth, checkHealth } from './health.js';

loadDotEnv();
const config = loadConfig();
const logger = createLogger({ service: 'api', level: config.logLevel, pretty: config.logPretty });
const prisma = createPrismaClient(config.databaseUrl);
const redis = createRedis(config.redisUrl);
const queues = new JobQueues(redis, config.queuePrefix, CARRIERS);

const metrics = createApiMetrics({
  carrierIds: () => queues.carrierIds(),
  queueCounts: (carrierId) => queues.counts(carrierId),
  jobStatusCounts: async () =>
    (await prisma.job.groupBy({ by: ['status'], _count: { _all: true } })).map((row) => ({
      status: row.status,
      count: row._count._all,
    })),
});

const jobs = new JobService({
  prisma,
  queues,
  carriers: CARRIERS,
  defaults: { maxAttempts: config.retry.maxAttempts, deadlineMs: config.jobDeadlineMs },
  logger,
  onSubmit: (carrierId, created) =>
    metrics.jobsSubmitted.inc({ carrier: carrierId, result: created ? 'created' : 'deduplicated' }),
});

const experiments = new ExperimentService({
  prisma,
  jobs,
  mockAdmin: new MockCarrierAdminClient(config.mockCarrierUrl, config.adminToken),
  logger,
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
      carriers: CARRIERS,
      keyPrefix: config.queuePrefix,
      defaultConcurrency: config.worker.concurrency,
    }),
});

const server = app.listen(config.ports.api, () => {
  logger.info({ port: config.ports.api }, 'API listening');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down API');
  server.close();
  server.closeIdleConnections();
  try {
    await queues.close();
    await Promise.all([prisma.$disconnect(), redis.quit()]);
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
