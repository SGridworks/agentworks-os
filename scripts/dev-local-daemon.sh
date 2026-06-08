#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$ROOT/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env.local"
  set +a
fi

export AGENTOS_DATA_DIR="${AGENTOS_DATA_DIR:-$HOME/Library/Application Support/agentworks-os/data}"
export VAULT_ROOT="${VAULT_ROOT:-$HOME/vault}"
export RULE_PACKS_DIR="${RULE_PACKS_DIR:-$ROOT/rule-packs}"
export AGENTOS_HOST="${AGENTOS_HOST:-127.0.0.1}"
export AGENTOS_PORT="${AGENTOS_PORT:-7710}"

mkdir -p "$AGENTOS_DATA_DIR" "$VAULT_ROOT"

pnpm --dir "$ROOT/packages/memory" build
exec pnpm --dir "$ROOT/packages/agentos-d" dev
