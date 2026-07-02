#!/usr/bin/env bash
#
# agentworks — AgentWorks OS CLI
# Wraps docker compose and the installer for common operations.
#
# Usage:
#   agentworks status
#   agentworks logs [service]
#   agentworks update
#   agentworks update --check
#   agentworks backup --output <file.tar.gz>
#   agentworks restore --input <file.tar.gz>
#   agentworks uninstall
#   agentworks mcp configure
#   agentworks support-bundle
#   agentworks install
#
set -euo pipefail

# -----------------------------------------------------------------------------
# Constants
# -----------------------------------------------------------------------------
readonly AGENTWORKS_DIR="${AGENTWORKS_DIR:-$HOME/.agentworks}"
readonly COMPOSE_FILE="${AGENTWORKS_DIR}/docker-compose.yml"
readonly CONFIG_DIR="${AGENTWORKS_DIR}/config"
readonly SECRETS_FILE="${CONFIG_DIR}/secrets.json"
readonly LOG_DIR="${AGENTWORKS_DIR}/logs"
readonly DATA_DIR="${AGENTWORKS_DIR}/data"
readonly AGENTWORKS_VERSION="${AGENTWORKS_VERSION:-0.3.0-alpha.2}"  # BUMP ON RELEASE
readonly REPO="SGridworks/agentworks-os"
readonly GITHUB_RELEASES="https://api.github.com/repos/${REPO}/releases"

# Color codes
if [[ -t 1 ]]; then
  readonly RED='\033[0;31m'
  readonly GREEN='\033[0;32m'
  readonly YELLOW='\033[0;33m'
  readonly BLUE='\033[0;34m'
  readonly NC='\033[0m'
else
  readonly RED=''
  readonly GREEN=''
  readonly YELLOW=''
  readonly BLUE=''
  readonly NC=''
fi

# -----------------------------------------------------------------------------
# Logging
# -----------------------------------------------------------------------------
log_info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
log_step()  { echo -e "${BLUE}[STEP]${NC} $*"; }

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
is_installed() {
  [[ -f "$COMPOSE_FILE" ]]
}

require_installed() {
  if ! is_installed; then
    log_error "AgentWorks OS is not installed. Run: agentworks install"
    exit 1
  fi
}

get_compose_cmd() {
  # Use whichever docker compose variant is available
  if docker compose version &>/dev/null; then
    echo "docker compose"
  elif command -v docker-compose &>/dev/null; then
    echo "docker-compose"
  else
    log_error "docker compose not found"
    exit 1
  fi
}

refuse_active_daemon_for_restore() {
  local data_dir="$1"
  local lock_path="${data_dir}/.awos-daemon.lock"
  [[ -f "$lock_path" ]] || return 0

  local pid
  pid="$(sed -n 's/^[[:space:]]*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$lock_path" | head -1)"
  if [[ -z "$pid" ]]; then
    log_error "Refusing restore: invalid daemon lock at ${lock_path}"
    exit 1
  fi

  if kill -0 "$pid" 2>/dev/null; then
    log_error "Refusing restore: agentos-d appears active for ${data_dir} (pid ${pid}). Stop the daemon before overwriting agentworks.db."
    exit 1
  fi
}

# -----------------------------------------------------------------------------
# Command: status
# -----------------------------------------------------------------------------
cmd_status() {
  require_installed
  cd "$AGENTWORKS_DIR"
  local compose_cmd
  compose_cmd=$(get_compose_cmd)

  echo ""
  echo "AgentWorks OS — Service Status"
  echo "================================"
  echo ""

  $compose_cmd ps

  echo ""
  local health
  health=$(curl -s http://localhost:7710/api/health 2>/dev/null || true)
  if [[ -n "$health" ]] && echo "$health" | grep -q '"status"'; then
    echo -e "agentos-d API: ${GREEN}UP${NC} — $health"
  else
    echo -e "agentos-d API: ${RED}DOWN${NC}"
  fi
}

# -----------------------------------------------------------------------------
# Command: logs
# -----------------------------------------------------------------------------
cmd_logs() {
  require_installed
  cd "$AGENTWORKS_DIR"
  local compose_cmd
  compose_cmd=$(get_compose_cmd)

  local service="${1:-}"
  if [[ -n "$service" ]]; then
    $compose_cmd logs -f "$service"
  else
    $compose_cmd logs -f
  fi
}

# -----------------------------------------------------------------------------
# Command: update
# -----------------------------------------------------------------------------
cmd_update() {
  require_installed
  cd "$AGENTWORKS_DIR"
  local compose_cmd
  compose_cmd=$(get_compose_cmd)

  local check_only=false
  if [[ "${1:-}" == "--check" ]]; then
    check_only=true
  fi

  log_step "Checking for updates..."

  local latest_version
  latest_version=$(curl -s "$GITHUB_RELEASES/latest" 2>/dev/null \
    | sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v?([^"]+)".*/\1/p' | head -1 || true)

  if [[ -z "$latest_version" ]]; then
    log_warn "Could not fetch latest version from GitHub."
    return 1
  fi

  if [[ "$check_only" == "true" ]]; then
    if [[ "$latest_version" == "$AGENTWORKS_VERSION" ]]; then
      echo "You are on the latest version: ${latest_version}"
    else
      echo "Current: ${AGENTWORKS_VERSION}  Latest: ${latest_version}"
    fi
    return 0
  fi

  log_info "Latest version: ${latest_version}"
  log_info "Current version: ${AGENTWORKS_VERSION}"

  if [[ "$latest_version" == "$AGENTWORKS_VERSION" ]]; then
    log_info "Already on the latest version."
    return 0
  fi

  # Refresh the compose file so image paths (registry namespace), ports,
  # and service definitions from the new release are applied — not just
  # the version tag. Without this, a release that moved the GHCR
  # namespace or changed services would make `compose pull` fetch a
  # non-existent manifest. Fetch the target release's compose so it
  # matches the images being pulled, and only swap it in on success.
  log_step "Refreshing docker-compose.yml for ${latest_version}..."
  local compose_url="https://raw.githubusercontent.com/${REPO}/v${latest_version}/docker-compose.yml"
  local tmp_compose="${COMPOSE_FILE}.new"
  if ! curl -fsSL -L "${compose_url}" -o "${tmp_compose}"; then
    log_error "Failed to download docker-compose.yml for ${latest_version} from ${compose_url}"
    rm -f "${tmp_compose}"
    return 1
  fi
  mv "${tmp_compose}" "${COMPOSE_FILE}"
  log_info "Updated docker-compose.yml for ${latest_version}."

  # Persist the new version in .env so later plain `docker compose`
  # calls from the install dir resolve the refreshed compose to the
  # correct tag (not the old tag under the new namespace).
  local env_file
  for env_file in "${AGENTWORKS_DIR}/.env" "${CONFIG_DIR}/.env"; do
    [[ -f "$env_file" ]] || continue
    if grep -q '^AGENTWORKS_VERSION=' "$env_file"; then
      sed -i.bak "s/^AGENTWORKS_VERSION=.*/AGENTWORKS_VERSION=${latest_version}/" "$env_file" && rm -f "${env_file}.bak"
    else
      printf 'AGENTWORKS_VERSION=%s\n' "$latest_version" >> "$env_file"
    fi
  done

  log_step "Pulling updated images..."
  AGENTWORKS_VERSION="$latest_version" $compose_cmd pull

  log_step "Starting updated services..."
  AGENTWORKS_VERSION="$latest_version" $compose_cmd up -d

  log_info "Update complete."
}

# -----------------------------------------------------------------------------
# Command: backup
# -----------------------------------------------------------------------------
cmd_backup() {
  require_installed
  local output="${1:-}"
  local encrypt="${BACKUP_ENCRYPT:-true}"

  if [[ -z "$output" ]]; then
    output="agentworks-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
    log_info "No output specified, using: ${output}"
  fi

  log_step "Creating backup: ${output}"

  # Create a temp dir for the backup
  local tmpdir
  tmpdir=$(mktemp -d)
  trap "rm -rf $tmpdir" EXIT

  # Collect data dirs
  mkdir -p "$tmpdir/data" "$tmpdir/config"
  cp -r "$DATA_DIR/." "$tmpdir/data/"
  cp -r "$CONFIG_DIR/." "$tmpdir/config/"

  # chmod secrets to readable only
  chmod 600 "$tmpdir/config"/*.json 2>/dev/null || true

  # Database dump
  local compose_cmd
  compose_cmd=$(get_compose_cmd)
  cd "$AGENTWORKS_DIR"
  if $compose_cmd ps -q postgres &>/dev/null; then
    log_step "Dumping database..."
    mkdir -p "$tmpdir/db"
    $compose_cmd exec -T postgres pg_dump -U agentworks -d agentworks > "$tmpdir/db/agentworks.sql" 2>/dev/null || true
  fi

  # Create tarball
  tar -czf "$output" -C "$tmpdir" data config db

  # Encrypt if openssl is available and encrypt is enabled
  if [[ "$encrypt" == "true" ]] && command -v openssl &>/dev/null; then
    local passphrase="${BACKUP_PASSPHRASE:-}"
    if [[ -z "$passphrase" ]]; then
      log_warn "BACKUP_PASSPHRASE not set — skipping encryption (backup is still tarball)"
    else
      log_step "Encrypting backup..."
      local enc_output="${output%.tar.gz}.enc"
      openssl enc -aes-256-cbc -salt -pbkdf2 -pass pass:"$passphrase" -in "$output" -out "$enc_output"
      rm -f "$output"
      output="$enc_output"
    fi
  fi

  log_info "Backup saved to: ${output}"
}

# -----------------------------------------------------------------------------
# Command: restore
# -----------------------------------------------------------------------------
cmd_restore() {
  require_installed
  local input="${1:-}"

  if [[ -z "$input" ]]; then
    log_error "Usage: agentworks restore --input <file.tar.gz>"
    exit 1
  fi

  if [[ ! -f "$input" ]]; then
    log_error "File not found: ${input}"
    exit 1
  fi

  log_warn "This will overwrite current data. Ctrl+C to abort."
  sleep 3

  log_step "Restoring from: ${input}"

  local tmpdir
  tmpdir=$(mktemp -d)
  trap "rm -rf $tmpdir" EXIT

  tar -xzf "$input" -C "$tmpdir"

  # Stop services
  cd "$AGENTWORKS_DIR"
  local compose_cmd
  compose_cmd=$(get_compose_cmd)
  $compose_cmd stop

  # Restore data
  refuse_active_daemon_for_restore "$DATA_DIR"
  rm -rf "$DATA_DIR"/* && cp -r "$tmpdir/data/"* "$DATA_DIR/"
  rm -rf "$CONFIG_DIR"/* && cp -r "$tmpdir/config/"* "$CONFIG_DIR/"

  # Restart services
  $compose_cmd up -d

  log_info "Restore complete."
}

# -----------------------------------------------------------------------------
# Command: uninstall
# -----------------------------------------------------------------------------
cmd_uninstall() {
  require_installed

  log_warn "This will remove ALL AgentWorks OS data and containers."
  log_warn "Ctrl+C to abort."
  sleep 5

  cd "$AGENTWORKS_DIR"
  local compose_cmd
  compose_cmd=$(get_compose_cmd)

  log_step "Stopping services..."
  $compose_cmd down -v 2>/dev/null || true

  log_step "Removing data directories..."
  rm -rf "$DATA_DIR" "$CONFIG_DIR" "$LOG_DIR" "$AGENTWORKS_DIR/docker-compose.yml"

  log_info "AgentWorks OS has been removed."
}

# -----------------------------------------------------------------------------
# Command: mcp configure
# -----------------------------------------------------------------------------
cmd_mcp_configure() {
  require_installed

  local config_file=""
  local platform
  platform=$(uname -s)

  case "$platform" in
    Darwin)
      config_file="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
      ;;
    Linux)
      config_file="$HOME/.config/Claude/claude_desktop_config.json"
      ;;
    *)
      log_error "Unsupported platform: ${platform}"
      exit 1
      ;;
  esac

  log_step "Configuring Claude Desktop MCP..."

  # Detect if config file exists
  local config_dir
  config_dir=$(dirname "$config_file")
  mkdir -p "$config_dir"

  local mcp_url="http://localhost:7710"
  # Bridge path: shipped with the agentos-d package. Fall back to the global
  # install path if running from a checkout.
  local bridge_path="${AGENTWORKS_DIR}/bin/mcp-stdio-bridge.js"
  if [[ ! -f "$bridge_path" ]]; then
    if [[ -f "$(pwd)/packages/agentos-d/dist/bin/mcp-stdio-bridge.js" ]]; then
      bridge_path="$(pwd)/packages/agentos-d/dist/bin/mcp-stdio-bridge.js"
    fi
  fi

  if [[ ! -f "$bridge_path" ]]; then
    log_error "MCP stdio bridge not found at: $bridge_path"
    log_error "Run 'agentworks install' first or build packages/agentos-d."
    exit 1
  fi

  # Claude Desktop's claude_desktop_config.json speaks stdio MCP only.
  # The bridge translates stdio JSON-RPC ↔ HTTP /api/mcp on the daemon.
  python3 - <<EOF
import json, sys, os

config_file = "$config_file"
mcp_url = "$mcp_url"
bridge_path = "$bridge_path"

try:
    with open(config_file) as f:
        config = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    config = {}

config.setdefault("mcpServers", {})
config["mcpServers"]["agentworks"] = {
    "command": "node",
    "args": [bridge_path],
    "env": {"AGENTOS_URL": mcp_url}
}

os.makedirs(os.path.dirname(config_file), exist_ok=True)
with open(config_file, "w") as f:
    json.dump(config, f, indent=2)

print("MCP configured at:", config_file)
print("Server: agentworks → bridge:", bridge_path, "→", mcp_url)
EOF

  log_info "Claude Desktop MCP configured: ${config_file}"
  log_info "Restart Claude Desktop to activate."
}

# -----------------------------------------------------------------------------
# Command: support-bundle
# -----------------------------------------------------------------------------
cmd_support_bundle() {
  require_installed
  local output="${1:-agentworks-support-$(date +%Y%m%d-%H%M%S).tar.gz}"

  log_step "Collecting support bundle: ${output}"

  local tmpdir
  tmpdir=$(mktemp -d)
  trap "rm -rf $tmpdir" EXIT

  cd "$AGENTWORKS_DIR"
  local compose_cmd
  compose_cmd=$(get_compose_cmd)

  # Service logs (last 500 lines each)
  mkdir -p "$tmpdir/logs"
  for svc in agentos-d scanner-worker n8n postgres; do
    $compose_cmd logs --tail=500 "$svc" > "$tmpdir/logs/${svc}.log" 2>&1 || true
  done

  # Docker compose config (sanitized)
  $compose_cmd config > "$tmpdir/docker-compose.yml" 2>/dev/null || true

  # Health endpoint output
  curl -s http://localhost:7710/api/health > "$tmpdir/health.json" 2>/dev/null || true

  # Database stats (if accessible)
  $compose_cmd exec -T postgres psql -U agentworks -d agentworks -c "SELECT 1" &>/dev/null && \
    $compose_cmd exec -T postgres pg_dump -U agentworks &>/dev/null > "$tmpdir/db.sql" || true

  tar -czf "$output" -C "$tmpdir" .

  log_info "Support bundle saved to: ${output}"
}

# -----------------------------------------------------------------------------
# Command: install
# -----------------------------------------------------------------------------
cmd_install() {
  if is_installed; then
    log_warn "AgentWorks OS is already installed at ${AGENTWORKS_DIR}"
    log_info "Run 'agentworks status' to check services."
    return 0
  fi

  local installer_url="${INSTALLER_URL:-https://get.agentworks.os/install.sh}"
  log_info "Downloading installer from: ${installer_url}"

  if command -v curl &>/dev/null; then
    curl -fsSL "$installer_url" | bash -s -- --unattended
  else
    log_error "curl is required to install AgentWorks OS"
    exit 1
  fi
}

# -----------------------------------------------------------------------------
# Main dispatcher
# -----------------------------------------------------------------------------
show_help() {
  cat <<EOF
AgentWorks OS CLI — ${AGENTWORKS_VERSION}

Usage: agentworks <command> [options]

Commands:
  agentworks install            Download and run the installer
  agentworks status            Show service status
  agentworks logs [service]    Tail service logs (all or a specific service)
  agentworks update            Update to the latest version
  agentworks update --check    Check for available updates
  agentworks backup [file]     Create a backup tarball (default: agentworks-backup-YYYYMMDD.tar.gz)
  agentworks restore --input <file>   Restore from a backup tarball
  agentworks uninstall         Remove AgentWorks OS and all data
  agentworks mcp configure     Configure Claude Desktop MCP connection
  agentworks support-bundle [file]   Collect diagnostics bundle

Examples:
  agentworks install
  agentworks status
  agentworks logs agentos-d
  agentworks update --check
  agentworks backup
  agentworks restore --input agentworks-backup-20260427.tar.gz

For more help: https://docs.agentworks.os
EOF
}

main() {
  local cmd="${1:-}"
  shift 2>/dev/null || true

  case "$cmd" in
    status)       cmd_status "$@" ;;
    logs)         cmd_logs "$@" ;;
    update)       cmd_update "$@" ;;
    backup)       cmd_backup "$@" ;;
    restore)      cmd_restore "$@" ;;
    uninstall)    cmd_uninstall ;;
    mcp|configure) cmd_mcp_configure ;;
    support-bundle) cmd_support_bundle "$@" ;;
    install)      cmd_install ;;
    -h|--help|help) show_help ;;
    *)            show_help ;;
  esac
}

main "$@"
