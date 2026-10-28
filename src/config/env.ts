import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { z } from 'zod';

export const DEFAULT_ADMIN_TOKEN = 'dev-admin-token';

const int = (fallback: number) => z.coerce.number().int().nonnegative().default(fallback);
const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('info'),
    LOG_PRETTY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    REDIS_URL: z.string().default('redis://localhost:6379'),
    MOCK_CARRIER_URL: z.url().default('http://localhost:4000'),
    QUEUE_PREFIX: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .default('carrierchaos'),

    ADMIN_TOKEN: z
      .string()
      .min(8, 'ADMIN_TOKEN must be at least 8 characters')
      .default(DEFAULT_ADMIN_TOKEN),

    API_PORT: positiveInt(3000),
    WORKER_METRICS_PORT: positiveInt(9464),
    MOCK_CARRIER_PORT: positiveInt(4000),

    WORKER_CONCURRENCY: positiveInt(8),
    CARRIER_REQUEST_TIMEOUT_MS: positiveInt(2000),
    RATE_LIMIT_MAX_WAIT_MS: int(1000),

    RETRY_MAX_ATTEMPTS: positiveInt(5),
    RETRY_BASE_DELAY_MS: int(250),
    RETRY_MAX_DELAY_MS: int(8000),
    RETRY_MAX_RETRY_AFTER_MS: int(30_000),
    JOB_DEADLINE_MS: positiveInt(600_000),

    BREAKER_FAILURE_RATE_THRESHOLD: z.coerce.number().gt(0).max(1).default(0.5),
    BREAKER_MINIMUM_REQUESTS: positiveInt(10),
    BREAKER_WINDOW_MS: positiveInt(10_000),
    BREAKER_OPEN_DURATION_MS: positiveInt(5000),
    BREAKER_HALF_OPEN_MAX_PROBES: positiveInt(2),
    BREAKER_HALF_OPEN_SUCCESS_THRESHOLD: positiveInt(2),

    RECONCILER_INTERVAL_MS: positiveInt(15_000),
    SHUTDOWN_TIMEOUT_MS: positiveInt(25_000),
  })
  .refine((env) => env.RETRY_MAX_DELAY_MS >= env.RETRY_BASE_DELAY_MS, {
    message: 'RETRY_MAX_DELAY_MS must be >= RETRY_BASE_DELAY_MS',
    path: ['RETRY_MAX_DELAY_MS'],
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.ADMIN_TOKEN !== DEFAULT_ADMIN_TOKEN, {
    message: 'refusing to run in production with the default development ADMIN_TOKEN',
    path: ['ADMIN_TOKEN'],
  });

export type Env = z.output<typeof EnvSchema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  logLevel: Env['LOG_LEVEL'];
  logPretty: boolean;
  databaseUrl: string;
  redisUrl: string;
  mockCarrierUrl: string;
  queuePrefix: string;
  adminToken: string;
  ports: { api: number; workerMetrics: number; mockCarrier: number };
  worker: {
    concurrency: number;
    requestTimeoutMs: number;
    rateLimitMaxWaitMs: number;
    reconcilerIntervalMs: number;
    shutdownTimeoutMs: number;
  };
  retry: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    maxRetryAfterMs: number;
  };
  jobDeadlineMs: number;
  breaker: {
    failureRateThreshold: number;
    minimumRequests: number;
    windowMs: number;
    openDurationMs: number;
    halfOpenMaxProbes: number;
    halfOpenSuccessThreshold: number;
  };
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const env = parsed.data;
  return {
    env: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    logPretty: env.LOG_PRETTY,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    mockCarrierUrl: env.MOCK_CARRIER_URL.replace(/\/$/, ''),
    queuePrefix: env.QUEUE_PREFIX,
    adminToken: env.ADMIN_TOKEN,
    ports: {
      api: env.API_PORT,
      workerMetrics: env.WORKER_METRICS_PORT,
      mockCarrier: env.MOCK_CARRIER_PORT,
    },
    worker: {
      concurrency: env.WORKER_CONCURRENCY,
      requestTimeoutMs: env.CARRIER_REQUEST_TIMEOUT_MS,
      rateLimitMaxWaitMs: env.RATE_LIMIT_MAX_WAIT_MS,
      reconcilerIntervalMs: env.RECONCILER_INTERVAL_MS,
      shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    },
    retry: {
      maxAttempts: env.RETRY_MAX_ATTEMPTS,
      baseDelayMs: env.RETRY_BASE_DELAY_MS,
      maxDelayMs: env.RETRY_MAX_DELAY_MS,
      maxRetryAfterMs: env.RETRY_MAX_RETRY_AFTER_MS,
    },
    jobDeadlineMs: env.JOB_DEADLINE_MS,
    breaker: {
      failureRateThreshold: env.BREAKER_FAILURE_RATE_THRESHOLD,
      minimumRequests: env.BREAKER_MINIMUM_REQUESTS,
      windowMs: env.BREAKER_WINDOW_MS,
      openDurationMs: env.BREAKER_OPEN_DURATION_MS,
      halfOpenMaxProbes: env.BREAKER_HALF_OPEN_MAX_PROBES,
      halfOpenSuccessThreshold: env.BREAKER_HALF_OPEN_SUCCESS_THRESHOLD,
    },
  };
}

/** Loads `.env` (if present) without overriding variables that are already set. */
export function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    process.env[key] ??= value;
  }
}
