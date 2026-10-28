#!/usr/bin/env bash
# End-to-end smoke test against a running stack (used by CI after `docker compose up --wait`).
set -euo pipefail

API="${API_URL:-http://localhost:3000}"
KEY="smoke-$(date +%s)-$RANDOM"

curl -sf "${API}/health" >/dev/null
ID=$(curl -sf -X POST "${API}/jobs" -H 'content-type: application/json' -H "Idempotency-Key: ${KEY}" \
  -d '{"carrierId":"northwind","policyId":"POL-SMOKE"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')

for _ in $(seq 1 100); do
  STATUS=$(curl -sf "${API}/jobs/${ID}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).status')
  if [ "$STATUS" = "completed" ]; then
    echo "smoke test passed: job ${ID} completed"
    curl -sf "${API}/carriers/health" >/dev/null
    curl -sf "${API}/metrics" | grep -q carrierchaos_http_requests_total
    exit 0
  fi
  sleep 0.2
done
echo "smoke test failed: job ${ID} is '${STATUS}'" >&2
exit 1
