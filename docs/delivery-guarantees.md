# Delivery guarantees

CarrierChaos splits responsibilities between two stores:

| Store | Role | What lives there |
|---|---|---|
| **PostgreSQL** | Source of truth | Job rows and their state, attempt history, dead letters, persisted policies, breaker transitions, experiments |
| **Redis / BullMQ** | Delivery and coordination | One queue per carrier whose messages carry only a job id; delayed retries; shared rate-limit buckets; published breaker snapshots |

Every decision a worker makes is re-checked against PostgreSQL under a row lock. Redis tells a
worker *that* it should look at a job, and PostgreSQL decides *whether anything should happen*.

## What the system guarantees

### 1. Durable acceptance

When `POST /jobs` returns `202` (or `200` for an idempotent replay), the job is committed in
PostgreSQL. The queue message is written after the commit:

```
INSERT jobs (unique idempotency_key)  ──commit──►  queue.add(jobId, { jobId: <deterministic id> })
```

If the process dies or Redis is unavailable between those two steps, the job is still durable.
Two mechanisms close the gap:

- A client retrying the same request with the same `Idempotency-Key` re-ensures the enqueue.
- The worker-side **reconciler** periodically finds `queued` jobs older than a grace period that
  have no BullMQ message and enqueues them.

Both are safe to repeat because BullMQ job ids are deterministic per run (`<jobId>` for the
first run, `<jobId>-r<n>` after the n-th manual retry), and BullMQ ignores an `add` for an id it
already holds.

### 2. At-least-once execution

A job's processor can run more than once. Ways this happens:

- A worker crashes or stalls; its BullMQ lock expires and the job is redelivered to another worker.
- An infrastructure error (e.g. PostgreSQL briefly unreachable) makes the processor throw, and
  BullMQ retries the delivery.
- The reconciler re-enqueues a job whose message it could not find.
- A duplicate message exists for the same job.

As a consequence, **the carrier can receive the same request more than once**. The recovery
integration test demonstrates this deliberately: a worker is killed mid-request, the job is
redelivered, and the mock carrier serves the policy twice.

### 3. Effectively-once effects

Execution is at-least-once, but every effect is made idempotent:

| Effect | Mechanism |
|---|---|
| One job per logical operation | `UNIQUE(idempotency_key)`. Concurrent duplicates race on the insert and losers read the winner's row. A reused key with a different payload (fingerprinted with SHA-256) returns `409 IDEMPOTENCY_KEY_CONFLICT`. |
| One policy record per (carrier, policy) | `INSERT … ON CONFLICT (carrier_id, policy_id) DO UPDATE`. `version` increments only when the content hash changes; `fetch_count` records every write. |
| At most one successful result per job run | Completion is a single transaction that locks the job row and requires `status = 'processing'` **and** `execution_id = <this execution's fencing token>`. The policy upsert lives in the same transaction, so a fenced-off execution writes nothing. |
| Terminal states are absorbing | A redelivered message for a `completed`, `failed`, `dead_lettered` or `cancelled` job is a no-op. `completed` can never be retried. |

**Fencing.** Each time a worker claims a job it writes a fresh `execution_id`. Every later write
from that execution (start attempt, complete, schedule retry, defer, dead-letter) is conditional
on that id. If a "zombie" worker (one that lost its lock but is still running) finishes after
another worker took over, its writes fail the fence and are discarded. In the recovery test the
carrier served the policy twice, yet `policy_records.fetch_count` is 1 and exactly one attempt row
is `succeeded`.

### At-least-once execution vs. idempotent effects

These are two different properties, and conflating them is the most common mistake in queue
design:

- **Execution** is what the worker does, including the upstream HTTP call. It cannot be made
  exactly-once. After a timeout or a dropped connection, the worker has no way to know whether
  the carrier processed the request, so the only safe option is to try again.
- **Effects** are what the system records as a result: the job's terminal state, the persisted
  policy, the "successful result" a client reads. These *can* be made exactly-once (more
  precisely, idempotent) with unique constraints, upserts and fencing.

For read-only policy retrieval, a duplicate upstream call costs some of the carrier's rate-limit
budget and nothing else. A write operation against a carrier (not in scope here) would also need
carrier-side idempotency keys, because no amount of local fencing can un-send an HTTP request.

## Retries, deferrals and their bounds

| Situation | State change | Consumes an attempt? | Bounded by |
|---|---|---|---|
| Transient error (429, 5xx, timeout, connection error, invalid JSON, 401) | `processing → queued` with `next_attempt_at` | Yes | `maxAttempts`, job deadline, `RETRY_MAX_RETRY_AFTER_MS` |
| Circuit breaker open | `processing → queued` (deferred) | No | Job deadline |
| Rate-limit token not available within `RATE_LIMIT_MAX_WAIT_MS` | `processing → queued` (deferred) | No | Job deadline |
| Non-retryable error (404, 403, schema violation, bad request) | `processing → failed` | Yes (the one attempt) | n/a |

The delay before a retry is `max(exponential backoff with equal jitter, Retry-After + up to 10%
positive jitter)`. If the next attempt or deferral would land past the job's deadline, the job is
dead-lettered immediately (`deadline_exceeded`) instead of waiting just to fail later.

If a message is delivered *before* the job's persisted `next_attempt_at` (possible if a worker
crashed between persisting the retry and delaying the message), the worker re-delays it rather
than retrying early.

## Cancellation

- **Queued** jobs are cancelled immediately and their queue message is removed (best effort; if
  a worker already holds the message, it sees `cancelled` when it claims the job and drops it).
- **Processing** jobs are flagged (`cancel_requested`). An in-flight HTTP request is not
  interrupted. At the next checkpoint (before scheduling a retry or a deferral) the worker moves
  the job to `cancelled`. If the in-flight attempt succeeds, the job completes. The effect has
  already happened, and it is idempotent.
- `cancelled` jobs can be retried manually.

## Manual retry and dead-letter replay

`POST /jobs/:id/retry` (admin) is allowed from `failed`, `dead_lettered` and `cancelled`. It
starts a new **run**: the attempt counter resets, the deadline is renewed with the original
budget, open dead-letter entries are marked `replayed_at`, and a new BullMQ message is enqueued
under the next run's id. The row lock makes concurrent replays of the same job safe: exactly one
succeeds and the rest get `409`. Attempt history is kept per run.

## Limitations

- **Redis durability.** BullMQ state lives in Redis. Compose runs Redis with AOF
  (`appendfsync everysec`), so a Redis crash can lose about a second of queue operations. The
  reconciler re-enqueues `queued` jobs whose messages vanished (preserving `next_attempt_at`),
  and dead-letters `processing` jobs whose execution was lost (`worker_lost`). Healing is
  eventual: grace period plus reconciler interval, not instant.
- **Reconciler conservatism.** A job that sits in `processing` for longer than
  `processingStaleMs` (2 minutes) without a live BullMQ job is dead-lettered as `worker_lost`
  rather than retried automatically. That avoids endless loops on a poison message, at the
  cost of occasionally requiring a manual replay.
- **Per-process circuit breakers.** Breaker state is in worker memory. With N worker processes,
  each must observe failures before it stops calling a dead carrier. The bound is N ×
  `minimumRequests` calls rather than `minimumRequests`.
- **Clocks.** Deadlines and `next_attempt_at` use the worker's clock; the token bucket uses the
  Redis server clock. Large clock skew between worker hosts would make deadlines imprecise.
- **No ordering guarantees** between jobs, including jobs for the same policy.
- **Single PostgreSQL instance.** This setup has no HA or failover. A PostgreSQL outage stops
  progress, but nothing is lost: processors fail with infrastructure errors and BullMQ retries
  them.
- **Fencing protects the database, not the carrier.** A zombie execution can still send its
  HTTP request; it just cannot record a result.
