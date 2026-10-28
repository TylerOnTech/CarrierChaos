#!/usr/bin/env bash
# CarrierChaos terminal demo (~3 minutes). Requires a running stack: docker compose up -d --build
# Uses only curl and node (for JSON formatting).
set -euo pipefail

API="${API_URL:-http://localhost:3000}"
MOCK="${MOCK_CARRIER_URL:-http://localhost:4000}"
TOKEN="${ADMIN_TOKEN:-dev-admin-token}"
RUN="demo-$(date +%s)"
AUTH=(-H "authorization: Bearer ${TOKEN}")
JSON=(-H 'content-type: application/json')

step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
show() { node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));const f=$1;console.log(JSON.stringify(f(d),null,2))"; }
field() { node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log($1)"; }
profile() { curl -sf -X PUT "${MOCK}/admin/carriers/$1/profile" "${AUTH[@]}" "${JSON[@]}" -d "$2" >/dev/null; }
submit() { curl -sf -X POST "${API}/jobs" "${JSON[@]}" -H "Idempotency-Key: $1" -d "{\"carrierId\":\"$2\",\"policyId\":\"$3\"}"; }
wait_terminal() {
  for _ in $(seq 1 150); do
    status=$(curl -sf "${API}/jobs/$1" | field 'd.status')
    case "$status" in completed|failed|dead_lettered|cancelled) return 0 ;; esac
    sleep 0.2
  done
}

step "1. Health of the API and its dependencies"
curl -sf "${API}/health" | show 'd=>d'

step "2. Submit a retrieval job, then submit it again with the same Idempotency-Key"
profile northwind '{"seed":1}'
ID=$(submit "${RUN}-1" northwind POL-DEMO-1 | field 'd.id')
curl -s -o /dev/null -w 'duplicate submission -> HTTP %{http_code}\n' -X POST "${API}/jobs" "${JSON[@]}" \
  -H "Idempotency-Key: ${RUN}-1" -d '{"carrierId":"northwind","policyId":"POL-DEMO-1"}'
wait_terminal "$ID"
curl -sf "${API}/jobs/${ID}" | show 'd=>({id:d.id,status:d.status,attempts:d.attempts,policyholder:d.result.policy.policyholder.lastName,premiumCents:d.result.policy.premium.amountCents})'

step "3. Inject a 500 and a 429 (Retry-After: 1s) before success: automatic recovery"
profile northwind '{"seed":1,"sequence":["server_error","rate_limit","ok"],"retryAfterSeconds":1}'
ID=$(submit "${RUN}-2" northwind POL-DEMO-2 | field 'd.id')
wait_terminal "$ID"
curl -sf "${API}/jobs/${ID}" | show 'd=>({status:d.status,attempts:d.attemptHistory.map(a=>({attempt:a.attempt,outcome:a.outcome,errorKind:a.errorKind,retryDelayMs:a.retryDelayMs}))})'

step "4. A permanent failure (HTTP 404) is not retried"
ID=$(submit "${RUN}-3" northwind MISSING-DEMO | field 'd.id')
wait_terminal "$ID"
curl -sf "${API}/jobs/${ID}" | show 'd=>({status:d.status,attempts:d.attempts,lastError:d.lastError,terminalReason:d.terminalReason})'

step "5. Carrier outage: bluepeak returns 503 for everything"
profile bluepeak '{"seed":1,"faults":{"unavailable":1},"retryAfterSeconds":null}'
OUT_IDS=()
for i in $(seq 1 15); do
  OUT_IDS+=("$(curl -sf -X POST "${API}/jobs" "${JSON[@]}" -H "Idempotency-Key: ${RUN}-out-${i}" \
    -d "{\"carrierId\":\"bluepeak\",\"policyId\":\"POL-OUT-${i}\",\"maxAttempts\":3,\"deadlineMs\":8000}" | field 'd.id')")
done
statuses() {
  for JOB in "${OUT_IDS[@]}"; do curl -sf "${API}/jobs/${JOB}" | field 'd.status'; done | sort | uniq -c
}
sleep 3
curl -sf "${API}/carriers/health" | show 'd=>d.carriers.map(c=>({carrier:c.carrierId,status:c.status,breaker:c.circuitBreaker.state,lastTransition:c.circuitBreaker.lastTransition}))'
echo "upstream requests seen by bluepeak so far (15 jobs x 3 attempts would be 45):"
curl -sf "${MOCK}/admin/carriers/bluepeak" "${AUTH[@]}" | field 'd.stats.requests'

step "6. Dead letters accumulate for inspection"
sleep 7
statuses
curl -sf "${API}/dead-letters?carrierId=bluepeak&limit=1" | show 'd=>d.data[0]'

step "7. Restore the carrier and replay dead letters (admin-only)"
profile bluepeak '{"seed":1}'
for JOB in "${OUT_IDS[@]}"; do
  curl -sf -X POST "${API}/jobs/${JOB}/retry" "${AUTH[@]}" >/dev/null
done
sleep 8
statuses
curl -sf "${API}/carriers/health" | show 'd=>d.carriers.filter(c=>c.carrierId==="bluepeak").map(c=>({breaker:c.circuitBreaker.state,lastTransition:c.circuitBreaker.lastTransition}))'

step "Done. Metrics: ${API}/metrics (API) and http://localhost:9464/metrics (worker)"
