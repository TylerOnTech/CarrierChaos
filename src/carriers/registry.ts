import type { TokenBucketConfig } from '../resilience/rate-limiter.js';

/**
 * Integrated carriers. Each one gets its own BullMQ queue, worker pool, circuit breaker and
 * rate limiter (bulkhead isolation), so one carrier's outage cannot consume another's capacity.
 * All carriers are fictional and served by the local mock carrier API.
 */
export interface CarrierDefinition {
  id: string;
  displayName: string;
  /** Requests the carrier allows us: burst `capacity`, sustained `refillPerSecond`. */
  rateLimit: TokenBucketConfig;
  /** Overrides WORKER_CONCURRENCY for this carrier's worker pool. */
  concurrency?: number;
}

export const CARRIERS: readonly CarrierDefinition[] = [
  {
    id: 'northwind',
    displayName: 'Northwind Mutual (synthetic)',
    rateLimit: { capacity: 20, refillPerSecond: 50 },
  },
  {
    id: 'bluepeak',
    displayName: 'BluePeak Insurance (synthetic)',
    rateLimit: { capacity: 20, refillPerSecond: 50 },
  },
  {
    id: 'harborline',
    displayName: 'Harborline Casualty (synthetic)',
    rateLimit: { capacity: 10, refillPerSecond: 25 },
  },
];

export const CARRIER_IDS = CARRIERS.map((carrier) => carrier.id);

export function findCarrier(
  carrierId: string,
  carriers: readonly CarrierDefinition[] = CARRIERS,
): CarrierDefinition | undefined {
  return carriers.find((carrier) => carrier.id === carrierId);
}
