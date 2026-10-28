# Technical demo (≈5 minutes)

A talk track for walking someone through CarrierChaos in a terminal.

## Setup (before the call)

```bash
docker compose up -d --build
curl -s localhost:3000/health
```

## 1. The problem (30 s)

> "Carrier integrations fail in every way an HTTP dependency can: throttling, 5xx, hanging
> connections, half-written responses, garbage bodies, expired sessions, and responses that
> parse fine but break the contract. CarrierChaos is a compact engine for retrieving policy data
> reliably anyway, plus a fault-injecting carrier simulator for proving it."

Show the architecture diagram in the README: API → PostgreSQL (truth) + BullMQ (delivery), one
queue per carrier, and the worker pipeline *claim → breaker → rate limit → attempt → classify →
retry policy*.

## 2. Scripted walkthrough (2-3 min)

```bash
npm run demo        # scripts/demo.sh
```

Narrate each step as it prints:

1. **Idempotent submission.** The second submission with the same `Idempotency-Key` returns
   `200` with the same job; nothing new is created.
2. **Transient failures.** A 500 then a 429 with `Retry-After: 1`. The attempt history shows
   the retry delay jump to about 1 s because the server asked for it.
3. **Permanent failure.** A 404 fails after exactly one attempt. Retrying would not help.
4. **Outage.** Bluepeak returns 503 for everything. `/carriers/health` shows the breaker OPEN,
   and the mock carrier saw far fewer requests than jobs × attempts.
5. **Dead letters.** Exhausted jobs land in `/dead-letters` with a reason and a replay link.
6. **Recovery.** Restore the carrier, replay the dead letters (admin token), and watch the
   breaker go HALF_OPEN → CLOSED as the jobs complete.

## 3. The guarantees (1 min)

Open [delivery-guarantees.md](delivery-guarantees.md) and make one point:

> "Execution is at-least-once. I can't make an HTTP call exactly-once, and after a timeout I
> genuinely don't know whether the carrier did the work. So I make the *effects* idempotent: a
> unique key per submission, an upsert per policy, and a fencing token so that a zombie worker's
> late success is discarded. The recovery test kills a worker mid-request: the carrier serves the
> policy twice, and there is still exactly one policy record and one successful attempt."

## 4. Evidence (1 min)

- `npm test`: unit tests with injected clocks and fake timers, plus integration tests against
  real PostgreSQL, Redis and BullMQ.
- [results/EXPERIMENTS.md](results/EXPERIMENTS.md): measured outcomes of experiments A-D.
- Worker metrics: `curl -s localhost:9464/metrics | grep carrierchaos_circuit_breaker`.

## Likely questions

- *Why not just use BullMQ's built-in retries?* → [design-tradeoffs.md §2](design-tradeoffs.md#2-the-processor-owns-carrier-retries-bullmq-attempts-cover-infrastructure-only)
- *What if Redis loses data?* → [delivery-guarantees.md, Limitations](delivery-guarantees.md#limitations)
- *Why is the breaker per process?* → [design-tradeoffs.md §4](design-tradeoffs.md#4-in-process-circuit-breakers)
