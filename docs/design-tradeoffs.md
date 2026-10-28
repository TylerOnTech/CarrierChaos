# Design tradeoffs

Each section names the decision, the alternatives considered, and what was given up.

## 1. PostgreSQL as the source of truth, BullMQ only for delivery

**Decision.** Job state, attempts, dead letters and results live in PostgreSQL. A BullMQ message
contains only `{ jobId }`.

**Alternatives.** Keep state in BullMQ job data (simplest, but Redis becomes the system of record
for business state, and it is hard to query or audit). Use PostgreSQL alone as the queue
(`SELECT … FOR UPDATE SKIP LOCKED`): one datastore and a transactional enqueue, but you end up
hand-building delays, stall detection and worker coordination. Use a workflow engine (Temporal):
the strongest guarantees, but heavy for a compact project.

**Cost.** Two stores that can disagree (the dual-write problem). This is mitigated by deterministic
BullMQ ids, client retries that re-ensure enqueueing, and a reconciler. See
[delivery-guarantees.md](delivery-guarantees.md).

## 2. The processor owns carrier retries; BullMQ attempts cover infrastructure only

**Decision.** On a transient carrier error the processor computes the delay itself (backoff +
jitter + Retry-After), persists it, and reschedules the *same* message with `moveToDelayed`.
BullMQ's own `attempts` only absorb infrastructure failures such as a database blip.

**Why.** It gives deterministic, unit-testable retry decisions
([`decideRetry`](../src/resilience/retry-policy.ts)); an attempt budget stored in PostgreSQL
next to the attempt history; and the ability to *defer without consuming an attempt* (breaker
open, rate limited), which BullMQ's built-in retries cannot express. **Cost:** more code on the
critical path, and two retry layers to explain.

## 3. One queue and worker pool per carrier (bulkhead)

**Decision.** `retrieval-northwind`, `retrieval-bluepeak`, … each have their own BullMQ worker
with its own concurrency.

**Why.** A carrier that hangs can only exhaust *its own* slots. Experiment C and the isolation
test show the healthy carrier's latency is unaffected while another carrier times out.
**Cost.** Total concurrency is the sum across carriers, so capacity cannot be lent from an idle
carrier to a busy one. Adding a carrier means adding a queue (configuration, not code). At
hundreds of carriers you would group them into a smaller number of pools.

## 4. In-process circuit breakers

**Decision.** Each worker process keeps one breaker per carrier in memory and publishes
snapshots to Redis for `/carriers/health`.

**Alternative.** A shared breaker in Redis: all workers trip together, but every call pays a
Redis round trip, and correct half-open probing across processes needs Lua and careful lease
handling.

**Cost.** With N worker processes, a dead carrier receives up to N × `minimumRequests` calls
before every breaker is open, and processes may briefly disagree. That was judged acceptable: the
breaker's job is to stop *sustained* hammering, and the per-process version is simple and fully
deterministic to test (injected clock, generation-fenced permits).

## 5. Shared token bucket in Redis for rate limits

**Decision.** A Lua token bucket per carrier, shared by all workers, using the Redis server clock.
Short waits happen in-process (≤ `RATE_LIMIT_MAX_WAIT_MS`); longer ones defer the job and free the
slot.

**Alternatives.** BullMQ's queue limiter limits job *starts*, not HTTP requests, and pauses the
whole queue. An in-process limiter cannot respect a carrier's limit once there are several
workers. **Cost:** one Redis round trip per upstream call.

## 6. Row locks plus fencing tokens for state transitions

**Decision.** Every transition starts with `SELECT … FOR UPDATE`. Worker writes also require the
current `execution_id`.

**Alternative.** Optimistic `UPDATE … WHERE status = …` statements. These work for single
transitions but get awkward for read-decide-write sequences ("is cancel requested? then cancel,
else schedule a retry").

**Cost.** Short row-level lock contention per job, which is negligible because there is one
writer per job almost all the time. The fencing token is what makes "a zombie worker finished
late" harmless.

## 7. Error classification: what is worth retrying

| Retryable | Not retryable |
|---|---|
| 429, 5xx, timeouts, connection errors, unparseable JSON, 401 (session expired) | 404, 403 / rejected credentials, other 4xx, **schema violations** |

Two judgment calls stand out. Unparseable JSON is retried, because truncated bodies and proxy
error pages are usually transient. A *well-formed* response that violates the contract is not
retried, because contract drift is deterministic: retrying burns rate-limit budget and delays the
alert. 429 counts as *neutral* for the circuit breaker. A throttling carrier is healthy, and
tripping the breaker on 429s would turn a rate-limit problem into an outage.

## 8. Deferrals do not consume attempts, but deadlines bound everything

Waiting on an open breaker or a rate limit is not the job's fault, so it does not spend the retry
budget. Without a bound, though, jobs could wait forever behind a dead carrier, so every run has
a deadline. If the next attempt or deferral would cross it, the job is dead-lettered
immediately (`deadline_exceeded`) rather than waiting just to fail.

## 9. Cooperative cancellation

Cancelling an in-flight job sets a flag that the worker honors at its next checkpoint; an
in-flight HTTP request is not aborted. Aborting mid-request would not undo anything at the
carrier anyway, and a successful in-flight attempt yields a valid, idempotent result. **Cost:** a
cancel can take up to one request timeout to take effect, and a cancelled-while-in-flight job can
still end up `completed`.

## 10. Idempotency keys are required and fingerprinted

`POST /jobs` rejects requests without a key instead of deduplicating on `(carrier, policy)`,
because "fetch this policy again later" is a legitimate, distinct operation. The key's payload is
fingerprinted, so a reused key with a different body is a `409`, not a silently returned
unrelated job.

## 11. Equal jitter by default

Full jitter (uniform in `[0, cap]`) is best at spreading load, but it can retry almost
immediately. Equal jitter keeps a growing floor (`cap/2 + uniform(0, cap/2)`), so consecutive
retries always back off, at the cost of slightly more clustering. Both are implemented and
selectable.

## 12. Dead-letter queue as a PostgreSQL table

Dead letters are written in the same transaction as the `dead_lettered` transition, are
queryable (`GET /dead-letters`) and carry their replay history. A separate BullMQ "DLQ queue"
would be a second, non-atomic write into a store that is worse at inspection.
