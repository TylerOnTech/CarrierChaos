# Load testing

Latest results: **[results/LOAD_TEST.md](results/LOAD_TEST.md)**.

## Running

```bash
docker compose up -d --build
npm run load-test                                   # 1000 jobs, 50 concurrent HTTP clients
npm run load-test -- --jobs 3000 --concurrency 100  # parameters are configurable
```

The script needs `DATABASE_URL` (read from `.env`) because it observes completion directly in
PostgreSQL.

## Methodology

1. **Healthy carriers.** Every carrier's mock profile is reset to 20-60 ms latency with no
   faults, so the run measures the pipeline rather than injected failures.
2. **Ingest.** N jobs are submitted through the real HTTP API (`POST /jobs`, each with a unique
   idempotency key) from C concurrent clients, round-robin across carriers. Each request's
   latency is recorded client-side.
3. **Completion.** The script polls PostgreSQL directly every 500 ms instead of the API, so
   monitoring traffic does not distort API latency.
4. **Report.** Ingest throughput and latency percentiles; processing wall clock (first enqueue to
   last finish) and throughput; queue-wait and end-to-end percentiles; total upstream attempts and
   rate-limit waits; and, from the mock carrier's own counters, each carrier's request count,
   peak requests per second and maximum concurrency. The machine description (CPU, cores, memory,
   OS, Node, git commit) is recorded with the results.

## Interpreting the numbers

- **Processing throughput is capped on purpose.** Per-carrier rate limits (50 + 50 + 25 req/s with
  the default registry) bound total upstream throughput at about 125 req/s plus bursts. A load
  test that hits that ceiling and stays there shows the rate limiter working under pressure,
  not a performance limit of the engine. The per-carrier peak req/s in the report should never
  exceed `burst + rate`.
- **Ingest throughput** (`POST /jobs`) is not rate-limited, and is bounded by one API process,
  PostgreSQL inserts and Redis enqueues on the same machine.
- **Everything runs on one host.** The load generator, API, worker, mock carrier, PostgreSQL and
  Redis share the same CPUs, so they compete with each other.

## What these results do not show

A local run with one API process, one worker process and a mock carrier says nothing about
production-scale throughput. A capacity claim would need, at minimum: separate hosts for the load
generator and the system under test; multiple API and worker replicas; a managed or replicated
PostgreSQL and Redis; realistic carrier latency distributions (including multi-second tails);
longer soak tests to observe memory, connection-pool and Redis growth; and runs repeated enough
times to report variance.
