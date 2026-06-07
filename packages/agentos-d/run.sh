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

# KIMI_API_KEY for the daemon-side LLM adapter. Source from Hermes config
# unless already set in the env. Single source of truth: ~/.hermes/config.yaml.
if [ -z "${KIMI_API_KEY:-}" ] && [ -f "${HOME}/.hermes/config.yaml" ]; then
  KIMI_API_KEY=$(/usr/bin/python3 -c "
import yaml
try:
    with open('${HOME}/.hermes/config.yaml') as f:
        cfg = yaml.safe_load(f)
    print(cfg.get('providers', {}).get('kimi', {}).get('api_key', ''), end='')
except Exception:
    print('', end='')
") || true
  export KIMI_API_KEY
fi

exec node dist/cli.js "$@"
