#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_DATA_DIR="${AGENTWORKS_DATA_DIR:-${AGENTOS_DATA_DIR:-$HOME/Library/Application Support/agentworks-os/data}}"
ENGINE_DATA_DIR="$LOCAL_DATA_DIR/n8n"
LOG_DIR="$HOME/.agentworks/logs"
PID_FILE="$HOME/.agentworks/automation-engine.pid"
LOG_FILE="$LOG_DIR/automation-engine.log"
VERSION="${N8N_VERSION:-1.68.0}"
CACHED_N8N_BIN="${N8N_BIN:-}"

mkdir -p "$ENGINE_DATA_DIR" "$LOG_DIR"

cd "$ROOT"
pnpm --filter @agentworks/n8n-nodes build

if [[ -z "$CACHED_N8N_BIN" ]]; then
  CACHED_N8N_BIN="$(find "$HOME/.npm/_npx" -path '*/node_modules/.bin/n8n' -print -quit 2>/dev/null || true)"
fi

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "Automation engine already running pid=$old_pid"
    exit 0
  fi
fi

if [[ -n "$CACHED_N8N_BIN" ]]; then
  engine_cmd=("$CACHED_N8N_BIN" start)
else
  engine_cmd=(npx -y "n8n@$VERSION" start)
fi

nohup env \
  N8N_HOST=127.0.0.1 \
  N8N_PORT=5678 \
  N8N_PROTOCOL=http \
  WEBHOOK_URL=http://127.0.0.1:5678/ \
  N8N_USER_FOLDER="$ENGINE_DATA_DIR" \
  N8N_CUSTOM_EXTENSIONS="$ROOT/packages/n8n-nodes" \
  N8N_SECURE_COOKIE=false \
  N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=false \
  N8N_DATABASE_TYPE=sqlite \
  N8N_DATABASE_SQLITE_VACUUM_ON_STARTUP=true \
  AGENTWORKS_API_URL="${AGENTWORKS_API_URL:-http://127.0.0.1:7710}" \
  AGENTOS_API_URL="${AGENTOS_API_URL:-http://127.0.0.1:7710}" \
  "${engine_cmd[@]}" > "$LOG_FILE" 2>&1 &

pid="$!"
echo "$pid" > "$PID_FILE"
echo "Automation engine starting pid=$pid log=$LOG_FILE"
