import type { Redis } from 'ioredis';
import { publishBreakerState } from '../carriers/breaker-state-store.js';
import {
  CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitState,
  type StateChange,
} from '../resilience/circuit-breaker.js';
import type { Logger } from '../shared/logger.js';
import type { WorkerMetrics } from '../shared/metrics.js';
import type { PrismaClient } from '../shared/prisma.js';

const STATE_GAUGE: Record<CircuitState, number> = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 };

export interface BreakerRegistryDeps {
  workerId: string;
  logger: Logger;
  prisma?: PrismaClient;
  redis?: Redis;
  keyPrefix: string;
  metrics?: WorkerMetrics | undefined;
}

/**
 * One circuit breaker per carrier for this worker process. Transitions are logged, exported as
 * metrics, persisted to PostgreSQL (so experiments can report them) and published to Redis.
 */
export class BreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly pending = new Set<Promise<unknown>>();
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(
    carrierIds: readonly string[],
    options: CircuitBreakerOptions,
    private readonly deps: BreakerRegistryDeps,
  ) {
    for (const carrierId of carrierIds) {
      const breaker = new CircuitBreaker(options);
      breaker.onStateChange((change) => this.onTransition(carrierId, change));
      this.breakers.set(carrierId, breaker);
      deps.metrics?.breakerState.set({ carrier: carrierId }, 0);
    }
  }

  get(carrierId: string): CircuitBreaker {
    const breaker = this.breakers.get(carrierId);
    if (!breaker) throw new Error(`no circuit breaker for carrier '${carrierId}'`);
    return breaker;
  }

  /** Publishes every breaker's snapshot now and then every `intervalMs`. */
  startHeartbeat(intervalMs = 2000): void {
    this.publishAll();
    this.heartbeat = setInterval(() => this.publishAll(), intervalMs);
    this.heartbeat.unref();
  }

  /** Stops publishing and waits for in-flight persistence writes. */
  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    await Promise.allSettled([...this.pending]);
  }

  private publishAll(): void {
    for (const carrierId of this.breakers.keys()) this.publish(carrierId);
  }

  private publish(carrierId: string): void {
    const { redis, keyPrefix, workerId } = this.deps;
    if (!redis) return;
    const snapshot = this.get(carrierId).snapshot();
    this.deps.metrics?.breakerState.set({ carrier: carrierId }, STATE_GAUGE[snapshot.state]);
    this.track(
      publishBreakerState(redis, keyPrefix, carrierId, {
        ...snapshot,
        workerId,
        updatedAt: Date.now(),
      }),
      'failed to publish breaker state',
    );
  }

  private onTransition(carrierId: string, change: StateChange): void {
    const { logger, metrics, prisma, workerId } = this.deps;
    const level = change.to === 'OPEN' ? 'warn' : 'info';
    logger[level](
      { carrierId, from: change.from, to: change.to, reason: change.reason },
      'circuit breaker transition',
    );
    metrics?.breakerTransitions.inc({ carrier: carrierId, from: change.from, to: change.to });
    metrics?.breakerState.set({ carrier: carrierId }, STATE_GAUGE[change.to]);

    if (prisma) {
      this.track(
        prisma.circuitBreakerTransition.create({
          data: {
            carrierId,
            workerId,
            fromState: change.from,
            toState: change.to,
            reason: change.reason,
            occurredAt: new Date(change.at),
          },
        }),
        'failed to persist breaker transition',
      );
    }
    this.publish(carrierId);
  }

  private track(promise: Promise<unknown>, message: string): void {
    const tracked = promise
      .catch((error: unknown) => this.deps.logger.error({ err: error }, message))
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }
}
