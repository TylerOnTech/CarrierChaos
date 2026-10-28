# Reliability experiments: methodology

Experiments run through the same code paths as production traffic. `POST /experiments`
configures the mock carrier's failure profile, submits a deterministic batch of jobs through
`JobService.submit` (idempotency included), and the normal workers process them.
`GET /experiments/:id` summarizes what was recorded.

Latest results: **[results/EXPERIMENTS.md](results/EXPERIMENTS.md)** (raw JSON alongside).

## Running

```bash
docker compose up -d --build      # or run api/worker/mock locally, see README
npm run experiments               # runs A, B, C, D in order, seed 42
npm run experiments -- --scenarios healthy,intermittent --seed 7
```

The runner waits for each experiment to finish before starting the next, because D depends on
C's dead letters and on the breaker state C leaves behind. It writes
`docs/results/experiments-<timestamp>.json` and `docs/results/EXPERIMENTS.md`.

## Scenarios

| | Scenario | Setup |
|---|---|---|
| A | `healthy` | 100 jobs to `northwind`, no faults, 10 duplicate submissions mixed in concurrently |
| B | `intermittent` | 100 jobs to `northwind`; per-request faults: 10% 429 (Retry-After 1 s), 8% 500, 7% 503, 5% hang (exceeds the 2 s client timeout); `maxAttempts` 6; 10 duplicate submissions |
| C | `outage` | 60 jobs to `bluepeak`, which returns 503 for everything; `maxAttempts` 4, deadline 20 s. At the same time, 40 jobs go to a healthy control carrier (`harborline`) |
| D | `recovery` | `bluepeak` restored. The dead letters from C are replayed via the normal manual-retry path, plus 40 new jobs |

Service configuration is whatever the stack runs with; the defaults are in `.env.example`
(worker concurrency 8 per carrier, request timeout 2 s, backoff base 250 ms / cap 8 s, breaker:
50% failure rate over ≥10 calls in 10 s, open 5 s, 2 half-open probes, 2 successes to close).
Carrier rate limits are in `src/carriers/registry.ts`.

## What is measured and where it comes from

| Metric | Source |
|---|---|
| Success rate, final states, terminal reasons | `jobs` rows |
| Attempts, retries, jobs retried, failure distribution | `job_attempts` rows started after the experiment began |
| Circuit-open deferrals, rate-limit waits | Per-job counters incremented in the same transactions as the deferral |
| Queue wait | `run_started_at − enqueued_at` (first pickup of the run) |
| End-to-end latency | `finished_at − enqueued_at`, completed jobs only |
| Breaker transitions | `circuit_breaker_transitions` rows written by workers, cut off at the last job's finish time |
| Upstream requests, peak req/s, max concurrent | The **mock carrier's own counters**, independent of the worker's bookkeeping |
| Duplicate-effect prevention | Submissions vs. jobs created; successful attempts vs. completed jobs; jobs with >1 successful attempt; policy records vs. distinct completed policies |

The experiment is "completed" when every job is terminal; its summary is then frozen in the
`experiments` row. Nothing is extrapolated. Unmeasured fields are reported as `n/a`.

Two cross-checks catch bookkeeping bugs: worker attempt counts must equal the requests the
mock carrier saw (`upstream.requests == attempts.total` is asserted in the integration test),
and successful attempts must equal completed jobs.

## Reproducibility

Faults are drawn from a PRNG seeded with `(seed, carrierId, policyId, n)`, where `n` counts
earlier requests for that policy. Policy ids are derived from the scenario and seed. Re-running
a scenario with the same seed therefore gives every (policy, attempt) pair the same fault,
regardless of concurrency or ordering. The integration test runs scenario B twice and asserts
identical failure distribution, attempt counts and outcomes.

What is **not** bit-for-bit reproducible: latencies, the exact moments breaker transitions
happen, and how many deferrals occur, since all of these depend on scheduling and wall-clock
time. In C the breaker transitions follow from timing, so the number of half-open probes can
differ by one between runs.

## Reading the results honestly

- These are single runs on one machine with Docker Compose. They show behavior (bounded
  retries, breaker activation, isolation, recovery, no duplicate effects), not capacity.
- Latencies include the deliberate pacing of rate limits and Retry-After. For example, B's tail
  latency is dominated by 1 s Retry-After waits and 2 s timeouts, by design.
- D's end-to-end latency includes time spent waiting for the breaker left open by C to allow
  probes. That is the cost of not hammering a carrier that has only just recovered.
