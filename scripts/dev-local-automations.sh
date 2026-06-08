#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_DATA_DIR="${AGENTWORKS_DATA_DIR:-${AGENTOS_DATA_DIR:-$HOME/Library/Application Support/agentworks-os/data}}"
LOCAL_CONFIG_DIR="${AGENTWORKS_CONFIG_DIR:-$ROOT/config}"

if ! docker info >/dev/null 2>&1; then
  echo "Docker or OrbStack is not available. Start it, then rerun this script." >&2
  exit 1
fi

mkdir -p "$LOCAL_DATA_DIR/n8n" "$LOCAL_CONFIG_DIR"

exec env \
  AGENTWORKS_SOURCE_DIR="$ROOT" \
  AGENTWORKS_DATA_DIR="$LOCAL_DATA_DIR" \
  AGENTWORKS_CONFIG_DIR="$LOCAL_CONFIG_DIR" \
  N8N_BASE_URL="${N8N_BASE_URL:-http://127.0.0.1:5678}" \
  docker compose -f "$ROOT/docker-compose.yml" up -d --build n8n
