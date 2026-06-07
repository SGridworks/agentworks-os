#!/usr/bin/env bash
# Launch agentos-d with the canonical out-of-repo data dir + vault.
# Set in this script (not in shell rc) so a stray `node dist/cli.js`
# without env still cannot fall back to ./data inside the repo.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if [[ -f "${ROOT}/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT}/.env.local"
  set +a
fi

DAEMON_DATA_DIR="${AGENTOS_DATA_DIR:-${HOME}/Library/Application Support/agentworks-os/data}"
DAEMON_VAULT_ROOT="${VAULT_ROOT:-${HOME}/vault}"
DAEMON_RULE_PACKS="${RULE_PACKS_DIR:-${ROOT}/rule-packs}"

mkdir -p "${DAEMON_DATA_DIR}/keys"

cd "$(dirname "$0")"

export AGENTOS_DATA_DIR="${DAEMON_DATA_DIR}"
export VAULT_ROOT="${DAEMON_VAULT_ROOT}"
export RULE_PACKS_DIR="${DAEMON_RULE_PACKS}"
export AGENTOS_PORT="${AGENTOS_PORT:-7710}"

exec node dist/cli.js "$@"
