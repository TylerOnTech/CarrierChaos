/**
 * Failure taxonomy for third-party carrier calls.
 *
 * Every upstream failure is reduced to an {@link ErrorKind}. The kind alone decides whether a
 * retry can help (`retryable`) and how the failure is reported to the circuit breaker
 * (`breakerOutcome`). Keeping this in one table makes the policy reviewable and testable.
 */
export const ERROR_KINDS = [
  'RATE_LIMITED',
  'UPSTREAM_ERROR',
  'UNAVAILABLE',
  'TIMEOUT',
  'CONNECTION_ERROR',
  'INVALID_RESPONSE',
  'AUTH_EXPIRED',
  'SCHEMA_VIOLATION',
  'AUTH_FORBIDDEN',
  'NOT_FOUND',
  'BAD_REQUEST',
  'UNKNOWN',
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

/**
 * How an outcome is reported to the circuit breaker:
 * - `failure`: evidence the carrier is unhealthy (counts toward opening the breaker).
 * - `success`: the carrier answered coherently, even if the answer was an error for this request.
 * - `neutral`: says nothing about carrier health (e.g. throttling, expired credentials).
 */
export type BreakerOutcome = 'success' | 'failure' | 'neutral';

export interface ErrorPolicy {
  retryable: boolean;
  breakerOutcome: BreakerOutcome;
  description: string;
}

export const ERROR_POLICIES: Readonly<Record<ErrorKind, ErrorPolicy>> = {
  RATE_LIMITED: {
    retryable: true,
    breakerOutcome: 'neutral',
    description: 'HTTP 429. Carrier is healthy but throttling us; honor Retry-After.',
  },
  UPSTREAM_ERROR: {
    retryable: true,
    breakerOutcome: 'failure',
    description: 'HTTP 500/502/504 or other 5xx.',
  },
  UNAVAILABLE: {
    retryable: true,
    breakerOutcome: 'failure',
    description: 'HTTP 503. Honor Retry-After when present.',
  },
  TIMEOUT: {
    retryable: true,
    breakerOutcome: 'failure',
    description: 'No complete response within the request time limit.',
  },
  CONNECTION_ERROR: {
    retryable: true,
    breakerOutcome: 'failure',
    description: 'Connection refused, reset, or terminated mid-response.',
  },
  INVALID_RESPONSE: {
    retryable: true,
    breakerOutcome: 'failure',
    description: 'Body is not parseable JSON (truncated payloads, proxy error pages).',
  },
  AUTH_EXPIRED: {
    retryable: true,
    breakerOutcome: 'neutral',
    description: 'HTTP 401. Session/token expired; refresh credentials and retry.',
  },
  SCHEMA_VIOLATION: {
    retryable: false,
    breakerOutcome: 'success',
    description:
      'Well-formed JSON that violates the NormalizedPolicy contract. Contract drift is not fixed by retrying.',
  },
  AUTH_FORBIDDEN: {
    retryable: false,
    breakerOutcome: 'success',
    description: 'HTTP 403 or rejected client credentials.',
  },
  NOT_FOUND: {
    retryable: false,
    breakerOutcome: 'success',
    description: 'HTTP 404. The policy does not exist at this carrier.',
  },
  BAD_REQUEST: {
    retryable: false,
    breakerOutcome: 'success',
    description: 'Other HTTP 4xx. The request itself is wrong.',
  },
  UNKNOWN: {
    retryable: true,
    breakerOutcome: 'neutral',
    description: 'Unexpected error. Retried within the attempt budget, then dead-lettered.',
  },
};

export interface CarrierErrorOptions {
  status?: number;
  retryAfterMs?: number;
  details?: unknown;
  cause?: unknown;
}

export class CarrierError extends Error {
  readonly kind: ErrorKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly details: unknown;

  constructor(kind: ErrorKind, message: string, options: CarrierErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CarrierError';
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details;
  }

  get retryable(): boolean {
    return ERROR_POLICIES[this.kind].retryable;
  }

  get breakerOutcome(): BreakerOutcome {
    return ERROR_POLICIES[this.kind].breakerOutcome;
  }
}

/** Maps a non-2xx HTTP status to an error kind. */
export function errorKindForStatus(status: number): ErrorKind {
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503) return 'UNAVAILABLE';
  if (status === 408) return 'TIMEOUT';
  if (status === 401) return 'AUTH_EXPIRED';
  if (status === 403) return 'AUTH_FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status >= 500) return 'UPSTREAM_ERROR';
  if (status >= 400) return 'BAD_REQUEST';
  return 'UNKNOWN';
}

/** Normalizes anything thrown during a carrier call into a {@link CarrierError}. */
export function toCarrierError(error: unknown): CarrierError {
  if (error instanceof CarrierError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CarrierError('UNKNOWN', message, { cause: error });
}
