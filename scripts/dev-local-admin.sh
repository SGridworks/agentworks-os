#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$ROOT/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env.local"
  set +a
fi

export AGENTOS_API_URL="${AGENTOS_API_URL:-http://127.0.0.1:7710}"
export VAULT_ROOT="${VAULT_ROOT:-$ROOT/packages/agentos-d/data/vault}"

if [[ -z "${AGENTOS_TENANT_ID:-}" ]]; then
  echo "AGENTOS_TENANT_ID is required. Set it in .env.local." >&2
  exit 1
fi

if [[ -z "${AGENTOS_COMPANY_ID:-}" ]]; then
  echo "AGENTOS_COMPANY_ID is required. Set it in .env.local." >&2
  exit 1
fi

exec pnpm --dir "$ROOT/packages/admin-ui" dev
