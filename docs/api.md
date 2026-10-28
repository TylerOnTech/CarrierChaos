# API reference

Base URL: `http://localhost:3000`. All bodies are JSON.

## Authentication (development only)

Administrative operations require the shared secret from `ADMIN_TOKEN`, sent as either header:

```
Authorization: Bearer dev-admin-token
X-Admin-Token: dev-admin-token
```

The comparison is constant-time, and the API refuses to start with `NODE_ENV=production` while the
token is still the development default. **This is not production authentication.** A real deployment
would put the API behind an identity provider (OIDC/JWT with per-operator identities, scopes
and an audit trail) or mTLS. The mock carrier's `/admin` API uses the same token.

| Endpoint | Auth |
|---|---|
| `POST /jobs`, `GET /jobs`, `GET /jobs/:id`, `GET /dead-letters` | none (client-facing; these return synthetic policyholder data, and real data would need tenant-scoped auth) |
| `POST /jobs/:id/retry`, `POST /jobs/:id/cancel`, `POST /experiments` | **admin** |
| `GET /experiments/:id`, `GET /health`, `GET /carriers/health`, `GET /metrics` | none |

## Error contract

Every non-2xx response has the same shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "request validation failed",
    "details": [{ "path": "policyId", "message": "policyId must be 1-64 characters of [A-Za-z0-9._-]" }],
    "requestId": "f3e4e860-0022-4a18-ac63-280801b180e9"
  }
}
```

`code` is stable and machine-readable; `details` is optional; `requestId` echoes `X-Request-Id`
(caller-supplied or generated) and also appears in the structured logs.

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body, query or path parameters fail validation (field-level `details`) |
| 400 | `INVALID_JSON` | Malformed JSON body |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | `POST /jobs` without an idempotency key |
| 400 | `UNKNOWN_CARRIER` | `carrierId` is not configured |
| 400 | `INVALID_CURSOR` | Malformed pagination cursor |
| 400 | `EXPERIMENT_SETUP_ERROR` | e.g. replay source experiment not found |
| 401 | `UNAUTHORIZED` | Missing or wrong admin token |
| 404 | `NOT_FOUND` / `ROUTE_NOT_FOUND` | Unknown job/experiment, or unknown route |
| 409 | `IDEMPOTENCY_KEY_CONFLICT` | Key reused with a different payload (`details.existingJobId`) |
| 409 | `INVALID_STATE_TRANSITION` | e.g. retrying a completed job (`details.currentStatus`, `details.action`) |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 100 kB |
| 502 | `MOCK_CARRIER_UNAVAILABLE` | Experiment could not configure the mock carrier |
| 500 | `INTERNAL_ERROR` | Unexpected error (details are logged, not returned) |

---

## `POST /jobs`

Submit a policy retrieval. Requires an idempotency key: the `Idempotency-Key` header (preferred)
or the `idempotencyKey` body field.

```bash
curl -i -X POST localhost:3000/jobs \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: 4a0c-retrieve-POL-1001' \
  -d '{"carrierId":"northwind","policyId":"POL-1001"}'
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `carrierId` | string | yes | `northwind`, `bluepeak` or `harborline` |
| `policyId` | string | yes | `[A-Za-z0-9._-]{1,64}`. IDs starting with `MISSING-` make the mock return 404. |
| `maxAttempts` | int 1-20 | no | Default `RETRY_MAX_ATTEMPTS` (5) |
| `deadlineMs` | int ≥ 1000 | no | Total time budget for the run. Default `JOB_DEADLINE_MS` (10 min) |

Responses:

- `202 Accepted`, `Idempotent-Replayed: false`: a new job was created and enqueued.
- `200 OK`, `Idempotent-Replayed: true`: same key and same payload; the original job is
  returned and nothing new is created.
- `409 IDEMPOTENCY_KEY_CONFLICT`: same key, different payload.

`Location: /jobs/<id>` is set in both success cases.

## `GET /jobs/:id`

Full job state, including the attempt history of every run, dead-letter entries, and (when
completed) the persisted NormalizedPolicy.

```json
{
  "id": "65f2453b-6588-45ae-be2c-fcf3f4d59f1e",
  "status": "completed",
  "carrierId": "northwind",
  "policyId": "POL-SMOKE",
  "idempotencyKey": "smoke-1793178158-26352",
  "attempts": 1,
  "maxAttempts": 5,
  "run": 0,
  "executions": 1,
  "cancelRequested": false,
  "deferrals": { "circuitOpen": 0, "rateLimited": 0 },
  "lastError": null,
  "terminalReason": null,
  "nextAttemptAt": null,
  "deadlineAt": "2026-10-28T09:12:39.006Z",
  "experimentId": null,
  "timestamps": {
    "createdAt": "2026-10-28T09:02:39.007Z",
    "enqueuedAt": "2026-10-28T09:02:39.006Z",
    "runStartedAt": "2026-10-28T09:02:39.015Z",
    "finishedAt": "2026-10-28T09:02:39.097Z",
    "updatedAt": "2026-10-28T09:02:39.100Z"
  },
  "result": {
    "policyRecordId": "a900aa29-28ac-42b6-9584-6a6fd21e9838",
    "version": 1,
    "fetchCount": 1,
    "policy": { "schemaVersion": "normalized-policy/v1", "carrierId": "northwind", "policyId": "POL-SMOKE", "…": "…" }
  },
  "attemptHistory": [
    {
      "run": 0,
      "attempt": 1,
      "outcome": "succeeded",
      "errorKind": null,
      "httpStatus": 200,
      "message": null,
      "retryDelayMs": null,
      "durationMs": 68,
      "workerId": "fc10bab87db2-1",
      "startedAt": "2026-10-28T09:02:39.024Z",
      "finishedAt": "2026-10-28T09:02:39.097Z"
    }
  ],
  "deadLetters": []
}
```

`attemptHistory[].outcome` is one of `succeeded`, `retryable_error`, `permanent_error`,
`abandoned` (the execution was lost to a crash or lock expiry) or `in_progress`.

## `GET /jobs`

Query: `status`, `carrierId`, `experimentId`, `limit` (1-100, default 20), `cursor`.
Results are ordered newest first and use keyset pagination on `(createdAt, id)`, which stays
stable while new jobs arrive.

```json
{ "data": [ { "id": "…", "status": "queued", "…": "…" } ], "nextCursor": "WyIyMDI2LTEwLTI4…" }
```

## `POST /jobs/:id/retry` (admin)

Manual retry / dead-letter replay. Allowed from `failed`, `dead_lettered`, `cancelled`. Returns
`202` with the job (`status: queued`, `run` incremented, `attempts: 0`). From any other state:
`409 INVALID_STATE_TRANSITION`. Concurrent replays of the same job: exactly one succeeds.

## `POST /jobs/:id/cancel` (admin)

| Current state | Response | `outcome` |
|---|---|---|
| `queued` | `200` | `cancelled` (queue message removed) |
| `processing` | `202` | `cancel_requested` (honored at the worker's next checkpoint) |
| `cancelled` | `200` | `already_cancelled` |
| `completed` / `failed` / `dead_lettered` | `409` | `INVALID_STATE_TRANSITION` |

## `GET /dead-letters`

Query: `carrierId`, `state` (`open` (default), `replayed`, `all`), `limit` (1-200).

```json
{
  "data": [
    {
      "id": "97704de5-fbd6-481d-9359-f1ae96cfae79",
      "jobId": "385a85e4-825f-44fa-81d4-ad55dc245543",
      "carrierId": "bluepeak",
      "policyId": "POL-C42-0053",
      "run": 0,
      "reason": "deadline_exceeded",
      "errorKind": "CIRCUIT_OPEN",
      "message": "circuit OPEN: deadline would pass while deferred",
      "attempts": 0,
      "createdAt": "2026-10-28T09:01:33.899Z",
      "replayedAt": null,
      "currentJobStatus": "dead_lettered",
      "replay": { "method": "POST", "path": "/jobs/385a85e4-825f-44fa-81d4-ad55dc245543/retry" }
    }
  ]
}
```

## `POST /experiments` (admin) and `GET /experiments/:id`

```bash
curl -X POST localhost:3000/experiments -H 'authorization: Bearer dev-admin-token' \
  -H 'content-type: application/json' -d '{"scenario":"intermittent","seed":42}'
```

| Field | Notes |
|---|---|
| `scenario` | `healthy` (A), `intermittent` (B), `outage` (C), `recovery` (D) |
| `seed` | Seeds fault injection and submission order (default 42) |
| `jobCount`, `duplicateSubmissions`, `faults`, `maxAttempts`, `deadlineMs`, `carrierId`, `controlJobCount` | Optional overrides of the scenario preset |
| `replayFromExperimentId` | `recovery` only: whose dead letters to replay (default: latest `outage`) |

`POST` returns `202` with the experiment id and its resolved plan. `GET /experiments/:id` returns a
live summary while jobs are running; once every job is terminal the summary is frozen (stored with
the mock carrier's request counters) and `status` becomes `completed`. See
[experiments.md](experiments.md) for the summary fields.

## `GET /health`

`200` when PostgreSQL and Redis both answer, otherwise `503`:

```json
{ "status": "ok", "checks": { "postgres": { "ok": true, "latencyMs": 2 }, "redis": { "ok": true, "latencyMs": 2 } } }
```

## `GET /carriers/health`

Per carrier: aggregated breaker state as published by workers (`healthy`/`recovering`/
`unavailable`/`unknown`), per-worker breaker snapshots, the last recorded transition, BullMQ queue
depth, rate limit, concurrency, and attempt success rate over the last 5 minutes.

## `GET /metrics`

Prometheus text format. The API exposes HTTP metrics, submissions (created vs deduplicated),
queue depth per carrier and state, and job counts per status. The worker exposes its own
endpoint on `:9464/metrics`: upstream attempts by outcome and error kind, request duration,
retries, deferrals, terminal outcomes, end-to-end and queue-wait histograms, breaker state and
transitions.

---

## Mock carrier API (`http://localhost:4000`)

| Endpoint | Purpose |
|---|---|
| `POST /carriers/:carrierId/oauth/token` | Client-credentials token (`client_secret` starting with `revoked` → 401) |
| `GET /carriers/:carrierId/policies/:policyId` | NormalizedPolicy v1, or an injected fault |
| `GET /admin/carriers[/:carrierId]` (admin) | Profile and live statistics (requests, outcomes, peak req/s, max concurrent, …) |
| `PUT /admin/carriers/:carrierId/profile` (admin) | Replace the failure profile (also resets counters and stats) |
| `POST /admin/carriers/:carrierId/reset` (admin) | Reset counters and stats |

Failure profile:

```json
{
  "seed": 42,
  "latencyMs": { "min": 20, "max": 60 },
  "faults": { "rate_limit": 0.1, "server_error": 0.08, "unavailable": 0.07, "timeout": 0.05 },
  "sequence": ["server_error", "rate_limit", "ok"],
  "retryAfterSeconds": 1,
  "slowResponseMs": 1200,
  "hangMs": 60000
}
```

Fault kinds: `rate_limit` (429 + Retry-After), `server_error` (500), `unavailable` (503 +
Retry-After), `slow` (delayed success), `timeout` (hangs, then drops the socket),
`connection_reset` (headers and a partial body, then the socket is destroyed), `invalid_json`
(HTML error page or truncated JSON), `schema_violation` (valid JSON that breaks the contract),
`auth_error` (401 token expired).

`sequence` entries are served first, in arrival order (deterministic for tests). After that,
`faults` probabilities apply, seeded by `(seed, carrierId, policyId, n)` where `n` counts
earlier requests for that policy. The same experiment therefore produces the same per-policy
fault sequence no matter how concurrent workers interleave.
