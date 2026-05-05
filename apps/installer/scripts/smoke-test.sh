#!/usr/bin/env bash
#
# smoke-test.sh — end-to-end install verification for AgentWorks OS.
#
# Tests the substrate the way a real customer (and an agent) actually exercises
# it: create a tenant, ask the policy engine to evaluate an action, parse the
# response, assert the decision shape. Returns 0 if every step succeeds.
#
# Designed to be runnable by an AI agent: every step prints a single-line
# status, exits non-zero on the first failure, and the failure line tells the
# agent what to do next.
#
# Usage:
#   ./apps/installer/scripts/smoke-test.sh                # default daemon URL
#   AGENTOS_URL=http://localhost:7710 ./smoke-test.sh     # override URL
#
set -euo pipefail

readonly DAEMON_URL="${AGENTOS_URL:-http://127.0.0.1:7710}"
readonly TIMEOUT_SECS="${SMOKE_TIMEOUT_SECS:-90}"

if [[ -t 1 ]]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BLUE=''; NC=''
fi

pass()  { echo -e "${GREEN}[PASS]${NC} $*"; }
fail()  { echo -e "${RED}[FAIL]${NC} $*" >&2; }
info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }

require_cmd() {
  if ! command -v "$1" &>/dev/null; then
    fail "Missing required command: $1"
    fail "Install $1 and re-run."
    exit 2
  fi
}

require_cmd curl
require_cmd python3

# -----------------------------------------------------------------------------
# Step 1 — daemon is reachable
# -----------------------------------------------------------------------------
info "Polling ${DAEMON_URL}/api/health (up to ${TIMEOUT_SECS}s)..."
elapsed=0
until curl -sf -m 3 "${DAEMON_URL}/api/health" >/dev/null 2>&1; do
  if (( elapsed >= TIMEOUT_SECS )); then
    fail "agentos-d did not respond at ${DAEMON_URL}/api/health within ${TIMEOUT_SECS}s."
    fail "Diagnose: docker compose logs agentos-d --tail 100"
    fail "Common causes: container OOMed, migration crash, or port 7710 blocked by another process."
    exit 1
  fi
  sleep 3
  elapsed=$(( elapsed + 3 ))
done
pass "agentos-d /api/health is up."

health_body=$(curl -sf "${DAEMON_URL}/api/health")
if ! echo "$health_body" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
  fail "Health endpoint returned without status=ok: $health_body"
  exit 1
fi

# -----------------------------------------------------------------------------
# Step 2 — create a smoke-test tenant
# -----------------------------------------------------------------------------
info "POST ${DAEMON_URL}/api/tenants — creating smoke-test tenant..."
tenant_resp=$(curl -sS -X POST "${DAEMON_URL}/api/tenants" \
  -H 'content-type: application/json' \
  -d '{"name":"smoke-test","description":"created by apps/installer/scripts/smoke-test.sh"}' 2>&1) || {
  fail "POST /api/tenants failed: $tenant_resp"
  fail "Diagnose: docker compose logs agentos-d --tail 100"
  exit 1
}

tenant_id=$(printf '%s' "$tenant_resp" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("id") or d.get("tenantId") or "")' 2>/dev/null) \
  || tenant_id=""

if [[ -z "$tenant_id" ]]; then
  fail "Could not parse tenant id from response: $tenant_resp"
  exit 1
fi
pass "Tenant created: ${tenant_id}"

# -----------------------------------------------------------------------------
# Step 3 — policy.check round-trip
# -----------------------------------------------------------------------------
info "POST ${DAEMON_URL}/api/policy/check — evaluating a benign action..."
policy_resp=$(curl -sS -X POST "${DAEMON_URL}/api/policy/check" \
  -H 'content-type: application/json' \
  -d "$(cat <<EOF
{
  "tenantId": "${tenant_id}",
  "actionKind": "smoke.test",
  "payload": {"sample": "value"},
  "actorId": "smoke-test",
  "actorLabel": "installer smoke test",
  "actorType": "system",
  "summary": "installer smoke test ping"
}
EOF
)" 2>&1) || {
  fail "POST /api/policy/check failed: $policy_resp"
  fail "Diagnose: docker compose logs agentos-d --tail 100"
  exit 1
}

decision=$(printf '%s' "$policy_resp" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("decision") or "")' 2>/dev/null) \
  || decision=""

case "$decision" in
  allow|block|route_to_review)
    pass "policy.check returned a valid decision: ${decision}"
    ;;
  "")
    fail "policy.check response had no decision field: $policy_resp"
    exit 1
    ;;
  *)
    fail "policy.check returned an unexpected decision: ${decision}"
    fail "Full response: $policy_resp"
    exit 1
    ;;
esac

# -----------------------------------------------------------------------------
# Step 4 — scanner-worker /health (FATAL).
# Stub mode is the default in docker-compose.yml as of v0.1.7, so /health
# should respond in <1s. If it doesn't, the sidecar is genuinely broken
# and the install gate must fail loudly. Set SMOKE_SCANNER_OPTIONAL=1 to
# downgrade to a warning (the historical pre-v0.1.8 behavior) — useful
# only when running with EMBEDDING_MODE=real on a slow link.
# -----------------------------------------------------------------------------
scanner_optional="${SMOKE_SCANNER_OPTIONAL:-0}"
scanner_url="${SCANNER_URL:-http://127.0.0.1:3101}"
scanner_timeout="${SMOKE_SCANNER_TIMEOUT:-30}"

elapsed=0
until curl -sf -m 3 "${scanner_url}/health" >/dev/null 2>&1; do
  if (( elapsed >= scanner_timeout )); then
    if [[ "$scanner_optional" == "1" ]]; then
      warn "scanner-worker /health unreachable on ${scanner_url} after ${scanner_timeout}s. SMOKE_SCANNER_OPTIONAL=1, continuing."
      warn "Investigate: docker compose logs scanner-worker --tail 50"
      break
    fi
    fail "scanner-worker /health unreachable on ${scanner_url} after ${scanner_timeout}s."
    fail "Diagnose: docker compose logs scanner-worker --tail 100"
    fail "If you're running EMBEDDING_MODE=real, the sidecar may still be downloading model weights;"
    fail "re-run with SMOKE_SCANNER_OPTIONAL=1 to make this a warning instead of a failure."
    exit 1
  fi
  sleep 2
  elapsed=$(( elapsed + 2 ))
done
[[ "$scanner_optional" == "1" && $elapsed -ge $scanner_timeout ]] || pass "scanner-worker /health is up."

# -----------------------------------------------------------------------------
# Step 5 — n8n (warning only; n8n is workflow automation, not core compliance,
# and its first-boot SQLite init takes 20-60s on a slow disk).
# -----------------------------------------------------------------------------
if curl -sf -m 3 http://127.0.0.1:5678/healthz >/dev/null 2>&1; then
  pass "n8n /healthz is up."
else
  warn "n8n /healthz unreachable on 5678. n8n boots slowly on first run; retry in a minute."
fi

echo ""
echo "=============================================================================="
echo -e "${GREEN}AgentWorks OS smoke test PASSED${NC}"
echo "=============================================================================="
echo "  Daemon URL:  ${DAEMON_URL}"
echo "  Tenant ID:   ${tenant_id}"
echo "  Decision:    ${decision}"
echo ""
echo "The substrate is responding to writes and the policy engine is online."
echo "Next: open the Admin UI or wire an MCP client. See README.md."
exit 0
