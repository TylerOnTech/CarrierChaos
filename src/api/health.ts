import type { Redis } from 'ioredis';
import { aggregateState, readBreakerStates } from '../carriers/breaker-state-store.js';
import type { CarrierDefinition } from '../carriers/registry.js';
import type { JobQueues } from '../jobs/queues.js';
import type { PrismaClient } from '../shared/prisma.js';

export interface DependencyCheck {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

async function timed(check: () => Promise<unknown>, timeoutMs = 2000): Promise<DependencyCheck> {
  const started = Date.now();
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), timeoutMs).unref(),
      ),
    ]);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function checkHealth(prisma: PrismaClient, redis: Redis) {
  const [postgres, redisCheck] = await Promise.all([
    timed(() => prisma.$queryRaw`SELECT 1`),
    timed(() => redis.ping()),
  ]);
  const ok = postgres.ok && redisCheck.ok;
  return { status: ok ? 'ok' : 'degraded', checks: { postgres, redis: redisCheck } } as const;
}

const HEALTH_BY_STATE = {
  CLOSED: 'healthy',
  HALF_OPEN: 'recovering',
  OPEN: 'unavailable',
  UNKNOWN: 'unknown',
} as const;

export interface CarrierHealthDeps {
  prisma: PrismaClient;
  redis: Redis;
  queues: JobQueues;
  carriers: readonly CarrierDefinition[];
  keyPrefix: string;
  defaultConcurrency: number;
  windowMs?: number;
}

/** Per-carrier view: breaker state (as published by workers), queue depth, recent outcomes. */
export async function carrierHealth(deps: CarrierHealthDeps) {
  const windowMs = deps.windowMs ?? 5 * 60_000;
  const since = new Date(Date.now() - windowMs);
  const recent = await deps.prisma.$queryRaw<
    Array<{ carrierId: string; outcome: string | null; count: bigint }>
  >`
    SELECT j.carrier_id AS "carrierId", a.outcome::text AS "outcome", count(*) AS "count"
      FROM job_attempts a
      JOIN jobs j ON j.id = a.job_id
     WHERE a.started_at >= ${since}
     GROUP BY 1, 2`;

  const carriers = await Promise.all(
    deps.carriers.map(async (carrier) => {
      const [breakers, queue, lastTransition] = await Promise.all([
        readBreakerStates(deps.redis, deps.keyPrefix, carrier.id),
        deps.queues.counts(carrier.id),
        deps.prisma.circuitBreakerTransition.findFirst({
          where: { carrierId: carrier.id },
          orderBy: { occurredAt: 'desc' },
        }),
      ]);
      const rows = recent.filter((row) => row.carrierId === carrier.id);
      const total = rows.reduce((sum, row) => sum + Number(row.count), 0);
      const succeeded = Number(rows.find((row) => row.outcome === 'succeeded')?.count ?? 0);
      const state = aggregateState(breakers);
      return {
        carrierId: carrier.id,
        displayName: carrier.displayName,
        status: HEALTH_BY_STATE[state],
        circuitBreaker: {
          state,
          workers: breakers.map((b) => ({
            workerId: b.workerId,
            state: b.state,
            windowRequests: b.windowRequests,
            windowFailures: b.windowFailures,
            retryAfterMs: b.retryAfterMs,
            updatedAt: new Date(b.updatedAt).toISOString(),
          })),
          lastTransition: lastTransition
            ? {
                from: lastTransition.fromState,
                to: lastTransition.toState,
                reason: lastTransition.reason,
                at: lastTransition.occurredAt.toISOString(),
              }
            : null,
        },
        queue,
        rateLimit: carrier.rateLimit,
        concurrency: carrier.concurrency ?? deps.defaultConcurrency,
        recentAttempts: {
          windowSeconds: windowMs / 1000,
          total,
          succeeded,
          successRate: total === 0 ? null : Math.round((succeeded / total) * 10_000) / 10_000,
        },
      };
    }),
  );
  return { carriers };
}
