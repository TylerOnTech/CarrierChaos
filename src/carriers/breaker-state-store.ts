import type { Redis } from 'ioredis';
import type { CircuitSnapshot, CircuitState } from '../resilience/circuit-breaker.js';

/**
 * Circuit breakers live in worker memory. Workers publish their breaker snapshots to Redis so
 * the API (a different process) can report carrier health. One hash per carrier, one field per
 * worker; entries from workers that stopped publishing are ignored as stale.
 */
export interface PublishedBreakerState extends CircuitSnapshot {
  workerId: string;
  updatedAt: number;
}

const STALE_AFTER_MS = 15_000;
const KEY_TTL_SECONDS = 60;

export function breakerKey(prefix: string, carrierId: string): string {
  return `${prefix}:breakers:${carrierId}`;
}

export async function publishBreakerState(
  redis: Redis,
  prefix: string,
  carrierId: string,
  state: PublishedBreakerState,
): Promise<void> {
  const key = breakerKey(prefix, carrierId);
  await redis
    .multi()
    .hset(key, state.workerId, JSON.stringify(state))
    .expire(key, KEY_TTL_SECONDS)
    .exec();
}

export async function readBreakerStates(
  redis: Redis,
  prefix: string,
  carrierId: string,
  now: number = Date.now(),
): Promise<PublishedBreakerState[]> {
  const entries = await redis.hgetall(breakerKey(prefix, carrierId));
  return Object.values(entries)
    .map((raw) => JSON.parse(raw) as PublishedBreakerState)
    .filter((state) => now - state.updatedAt <= STALE_AFTER_MS);
}

/** The most pessimistic state across workers (OPEN > HALF_OPEN > CLOSED). */
export function aggregateState(states: PublishedBreakerState[]): CircuitState | 'UNKNOWN' {
  if (states.length === 0) return 'UNKNOWN';
  if (states.some((s) => s.state === 'OPEN')) return 'OPEN';
  if (states.some((s) => s.state === 'HALF_OPEN')) return 'HALF_OPEN';
  return 'CLOSED';
}
