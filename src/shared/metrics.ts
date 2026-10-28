import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';

export { Registry };

const LATENCY_BUCKETS_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];

export function createWorkerMetrics(registry: Registry = new Registry()) {
  collectDefaultMetrics({ register: registry, prefix: 'carrierchaos_worker_' });
  const registers = [registry];
  return {
    registry,
    attempts: new Counter({
      name: 'carrierchaos_carrier_attempts_total',
      help: 'Upstream carrier attempts by outcome and error kind',
      labelNames: ['carrier', 'outcome', 'error_kind'] as const,
      registers,
    }),
    requestDuration: new Histogram({
      name: 'carrierchaos_carrier_request_duration_seconds',
      help: 'Duration of upstream carrier requests',
      labelNames: ['carrier', 'outcome'] as const,
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers,
    }),
    retriesScheduled: new Counter({
      name: 'carrierchaos_retries_scheduled_total',
      help: 'Automatic retries scheduled after a transient failure',
      labelNames: ['carrier', 'error_kind'] as const,
      registers,
    }),
    deferrals: new Counter({
      name: 'carrierchaos_job_deferrals_total',
      help: 'Jobs deferred without consuming an attempt (open breaker, rate limit, not-before)',
      labelNames: ['carrier', 'reason'] as const,
      registers,
    }),
    jobsTerminal: new Counter({
      name: 'carrierchaos_jobs_terminal_total',
      help: 'Jobs reaching a terminal state',
      labelNames: ['carrier', 'status', 'reason'] as const,
      registers,
    }),
    jobEndToEnd: new Histogram({
      name: 'carrierchaos_job_end_to_end_seconds',
      help: 'Time from (re)enqueue to terminal state',
      labelNames: ['carrier', 'status'] as const,
      buckets: LATENCY_BUCKETS_SECONDS,
      registers,
    }),
    queueWait: new Histogram({
      name: 'carrierchaos_job_queue_wait_seconds',
      help: 'Time from (re)enqueue until a worker first picked the job up',
      labelNames: ['carrier'] as const,
      buckets: LATENCY_BUCKETS_SECONDS,
      registers,
    }),
    breakerState: new Gauge({
      name: 'carrierchaos_circuit_breaker_state',
      help: 'Circuit breaker state per carrier (0=closed, 1=half_open, 2=open)',
      labelNames: ['carrier'] as const,
      registers,
    }),
    breakerTransitions: new Counter({
      name: 'carrierchaos_circuit_breaker_transitions_total',
      help: 'Circuit breaker state transitions',
      labelNames: ['carrier', 'from', 'to'] as const,
      registers,
    }),
  };
}

export type WorkerMetrics = ReturnType<typeof createWorkerMetrics>;

export interface ApiMetricSources {
  queueCounts(carrierId: string): Promise<Record<string, number>>;
  carrierIds(): string[];
  jobStatusCounts(): Promise<Array<{ status: string; count: number }>>;
}

export function createApiMetrics(sources: ApiMetricSources, registry: Registry = new Registry()) {
  collectDefaultMetrics({ register: registry, prefix: 'carrierchaos_api_' });
  const registers = [registry];
  return {
    registry,
    httpRequests: new Counter({
      name: 'carrierchaos_http_requests_total',
      help: 'HTTP requests handled by the API',
      labelNames: ['method', 'route', 'status'] as const,
      registers,
    }),
    httpDuration: new Histogram({
      name: 'carrierchaos_http_request_duration_seconds',
      help: 'HTTP request latency',
      labelNames: ['method', 'route'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers,
    }),
    jobsSubmitted: new Counter({
      name: 'carrierchaos_jobs_submitted_total',
      help: 'Job submissions by result (created vs. idempotent replay)',
      labelNames: ['carrier', 'result'] as const,
      registers,
    }),
    queueDepth: new Gauge({
      name: 'carrierchaos_queue_jobs',
      help: 'BullMQ jobs per carrier queue and state (sampled at scrape time)',
      labelNames: ['carrier', 'state'] as const,
      registers,
      async collect() {
        for (const carrierId of sources.carrierIds()) {
          const counts = await sources.queueCounts(carrierId);
          for (const [state, count] of Object.entries(counts)) {
            this.set({ carrier: carrierId, state }, count);
          }
        }
      },
    }),
    jobsByStatus: new Gauge({
      name: 'carrierchaos_jobs_by_status',
      help: 'Durable job records per status (sampled at scrape time)',
      labelNames: ['status'] as const,
      registers,
      async collect() {
        this.reset();
        for (const { status, count } of await sources.jobStatusCounts()) {
          this.set({ status }, count);
        }
      },
    }),
  };
}

export type ApiMetrics = ReturnType<typeof createApiMetrics>;
