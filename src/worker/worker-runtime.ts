import { hostname } from 'node:os';
import { DelayedError, UnrecoverableError, Worker, type Job, type WorkerOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { CarrierClient } from '../carriers/carrier-client.js';
import { CARRIERS, type CarrierDefinition } from '../carriers/registry.js';
import type { AppConfig } from '../config/env.js';
import { JobQueues, queueName, type RetrievalJobData } from '../jobs/queues.js';
import { RedisTokenBucket } from '../resilience/redis-token-bucket.js';
import type { RateLimiter } from '../resilience/rate-limiter.js';
import type { RetryPolicy } from '../resilience/retry-policy.js';
import type { Logger } from '../shared/logger.js';
import type { WorkerMetrics } from '../shared/metrics.js';
import type { PrismaClient } from '../shared/prisma.js';
import { sleep } from '../shared/time.js';
import { BreakerRegistry } from './breaker-registry.js';
import { ExecutionStore } from './execution-store.js';
import { processRetrievalJob, type CarrierResources, type ProcessorDeps } from './processor.js';
import { Reconciler } from './reconciler.js';

export interface WorkerRuntimeOptions {
  config: AppConfig;
  prisma: PrismaClient;
  /** Connection for BullMQ workers (must use maxRetriesPerRequest: null). */
  workerConnection: Redis;
  /** General-purpose connection: rate limiter, breaker publishing, reconciler queue lookups. */
  redis: Redis;
  logger: Logger;
  carriers?: readonly CarrierDefinition[];
  workerId?: string;
  metrics?: WorkerMetrics;
  random?: () => number;
  /** Test hooks: shorter BullMQ lock/stall timings, custom rate limiters, etc. */
  bullWorkerOptions?: Partial<WorkerOptions>;
  rateLimiterFor?: (carrier: CarrierDefinition) => RateLimiter;
  enableReconciler?: boolean;
}

export interface WorkerRuntime {
  workerId: string;
  workers: Map<string, Worker<RetrievalJobData>>;
  breakers: BreakerRegistry;
  reconciler: Reconciler;
  processorDeps: ProcessorDeps;
  /** Graceful shutdown: stop taking jobs, let active ones finish (bounded), then release resources. */
  close(options?: { timeoutMs?: number }): Promise<void>;
}

export function retryPolicyFrom(config: AppConfig): RetryPolicy {
  return {
    maxAttempts: config.retry.maxAttempts,
    backoff: {
      baseDelayMs: config.retry.baseDelayMs,
      maxDelayMs: config.retry.maxDelayMs,
      jitter: 'equal',
    },
    maxRetryAfterMs: config.retry.maxRetryAfterMs,
  };
}

export function createWorkerRuntime(options: WorkerRuntimeOptions): WorkerRuntime {
  const { config, prisma, logger, metrics } = options;
  const carriers = options.carriers ?? CARRIERS;
  const workerId = options.workerId ?? `${hostname()}-${process.pid}`;
  const carrierIds = carriers.map((carrier) => carrier.id);

  const breakers = new BreakerRegistry(carrierIds, config.breaker, {
    workerId,
    logger,
    prisma,
    redis: options.redis,
    keyPrefix: config.queuePrefix,
    metrics,
  });

  const resources = new Map<string, CarrierResources>();
  for (const carrier of carriers) {
    resources.set(carrier.id, {
      client: new CarrierClient({
        carrierId: carrier.id,
        baseUrl: config.mockCarrierUrl,
        timeoutMs: config.worker.requestTimeoutMs,
      }),
      breaker: breakers.get(carrier.id),
      rateLimiter:
        options.rateLimiterFor?.(carrier) ??
        new RedisTokenBucket(
          options.redis,
          `${config.queuePrefix}:ratelimit:${carrier.id}`,
          carrier.rateLimit,
        ),
    });
  }

  const processorDeps: ProcessorDeps = {
    store: new ExecutionStore(prisma, workerId),
    resources: (carrierId) => {
      const found = resources.get(carrierId);
      if (!found) throw new Error(`carrier '${carrierId}' is not configured on this worker`);
      return found;
    },
    retryPolicy: retryPolicyFrom(config),
    rateLimitMaxWaitMs: config.worker.rateLimitMaxWaitMs,
    clock: Date.now,
    random: options.random ?? Math.random,
    sleep,
    logger,
    metrics,
  };

  /** Translates processor outcomes into BullMQ operations. */
  const handle = async (job: Job<RetrievalJobData>, token?: string) => {
    const outcome = await processRetrievalJob(job.data.jobId, processorDeps);
    switch (outcome.type) {
      case 'retry_scheduled':
      case 'deferred':
        // Same BullMQ job, rescheduled; does not consume BullMQ's infrastructure attempts.
        await job.moveToDelayed(Date.now() + outcome.delayMs, token);
        throw new DelayedError();
      case 'failed':
      case 'dead_lettered':
        // Already recorded in PostgreSQL; keep it in BullMQ's failed set for visibility.
        throw new UnrecoverableError(`${outcome.type}: ${outcome.reason}`);
      default:
        return outcome;
    }
  };

  const workers = new Map<string, Worker<RetrievalJobData>>();
  for (const carrier of carriers) {
    const worker = new Worker<RetrievalJobData>(queueName(carrier.id), handle, {
      connection: options.workerConnection,
      prefix: config.queuePrefix,
      concurrency: carrier.concurrency ?? config.worker.concurrency,
      // A crashed worker's job becomes visible again once its lock expires.
      lockDuration: 30_000,
      stalledInterval: 15_000,
      maxStalledCount: 2,
      ...options.bullWorkerOptions,
    });
    worker.on('failed', (job, error) => {
      if (error instanceof UnrecoverableError || error.name === 'UnrecoverableError') return;
      logger.error(
        { err: error, jobId: job?.data.jobId, carrierId: carrier.id },
        'processor infrastructure error',
      );
    });
    worker.on('error', (error) =>
      logger.error({ err: error, carrierId: carrier.id }, 'worker error'),
    );
    workers.set(carrier.id, worker);
  }

  const queues = new JobQueues(options.redis, config.queuePrefix, carriers);
  const reconciler = new Reconciler({ prisma, queues, logger });
  if (options.enableReconciler ?? true) reconciler.start(config.worker.reconcilerIntervalMs);
  breakers.startHeartbeat();

  logger.info(
    { workerId, carriers: carrierIds, concurrency: config.worker.concurrency },
    'worker runtime started',
  );

  return {
    workerId,
    workers,
    breakers,
    reconciler,
    processorDeps,
    async close({ timeoutMs = config.worker.shutdownTimeoutMs } = {}) {
      logger.info({ timeoutMs }, 'draining workers');
      await reconciler.stop();
      const drain = Promise.all([...workers.values()].map((worker) => worker.close()));
      const timedOut = await Promise.race([
        drain.then(() => false),
        sleep(timeoutMs).then(() => true),
      ]);
      if (timedOut) {
        // Active jobs keep their locks until they expire, then BullMQ redelivers them;
        // fencing makes any late writes from this process no-ops.
        logger.warn('shutdown timeout reached; forcing worker close');
        await Promise.all([...workers.values()].map((worker) => worker.close(true)));
      }
      await breakers.close();
      await queues.close();
      logger.info('workers drained');
    },
  };
}
