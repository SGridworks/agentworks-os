#!/usr/bin/env bash
#
# install.sh — bootstrap script for AgentWorks OS
# Usage: curl -fsSL https://get.agentworks.os/install.sh | bash
#        curl -fsSL https://get.agentworks.os/install.sh | bash -s -- --unattended
#
set -euo pipefail

INSTALLER_VERSION="0.3.0-alpha.1"  # BUMP ON RELEASE
AGENTWORKS_DIR="${AGENTWORKS_DIR:-$HOME/.agentworks}"
DATA_DIR="${AGENTWORKS_DIR}/data"
CONFIG_DIR="${AGENTWORKS_DIR}/config"
LOG_DIR="${AGENTWORKS_DIR}/logs"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
log_step() { echo -e "${BLUE}[STEP]${NC} $*"; }

check_docker() {
  if ! command -v docker &>/dev/null; then
    log_error "Docker is not installed. Visit: https://docs.docker.com/get-docker/"
    exit 1
  fi
  if ! docker info &>/dev/null; then
    log_error "Docker daemon is not running. Please start Docker Desktop."
    exit 1
  fi
  log_info "Docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
}

check_docker_compose() {
  if ! docker compose version &>/dev/null && ! command -v docker-compose &>/dev/null; then
    log_error "Docker Compose is not installed."
    exit 1
  fi
}

preflight() {
  log_step "Pre-flight checks..."
  check_docker
  check_docker_compose
  log_info "Pre-flight OK"
}

create_dirs() {
  log_step "Creating directories..."
  mkdir -p "$DATA_DIR" "$CONFIG_DIR" "$LOG_DIR"
  log_info "Data: $DATA_DIR"
  log_info "Config: $CONFIG_DIR"
}

download_compose() {
  log_step "Resolving docker-compose.yml..."
  local compose_file="$AGENTWORKS_DIR/docker-compose.yml"
  local scripts_dir="$AGENTWORKS_DIR/scripts"
  local workflows_dir="$AGENTWORKS_DIR/workflows"

  # If running from a checkout (repo root has docker-compose.yml), copy it and
  # use the local scripts + workflows directory.
  if [[ -f "$(pwd)/docker-compose.yml" ]] && grep -q "agentos-d:" "$(pwd)/docker-compose.yml" 2>/dev/null; then
    cp "$(pwd)/docker-compose.yml" "$compose_file"
    log_info "Using local checkout's docker-compose.yml"
    # Copy scripts directory if present
    if [[ -d "$(pwd)/scripts" ]]; then
      mkdir -p "$scripts_dir"
      cp "$(pwd)/scripts/"*.js "$scripts_dir/" 2>/dev/null || true
      log_info "Copied scripts/"
    fi
    # Copy workflows directory if present
    if [[ -d "$(pwd)/workflows" ]]; then
      mkdir -p "$workflows_dir"
      cp "$(pwd)/workflows/"*.json "$workflows_dir/" 2>/dev/null || true
      log_info "Copied workflows/"
    fi
    return 0
  fi

  # GitHub-based install: fetch docker-compose.yml, the seed script, and workflows
  local base_url="https://raw.githubusercontent.com/SGridworks/agentworks-os-v0.3/main"
  local ok=true

  if ! curl -fsSL -L "$base_url/docker-compose.yml" -o "$compose_file" 2>/dev/null; then
    log_error "Failed to download docker-compose.yml"
    ok=false
  else
    log_info "Downloaded docker-compose.yml"
  fi

  mkdir -p "$scripts_dir"
  if curl -fsSL -L "$base_url/scripts/n8n-workflow-seed.js" -o "$scripts_dir/n8n-workflow-seed.js" 2>/dev/null; then
    log_info "Downloaded n8n-workflow-seed.js"
  else
    log_warn "Could not download n8n-workflow-seed.js — n8n workflow seeding will be skipped"
  fi

  mkdir -p "$workflows_dir"
  for wf in 01-lead-intake 02-outbound-dispatch; do
    if curl -fsSL -L "$base_url/workflows/${wf}.json" -o "$workflows_dir/${wf}.json" 2>/dev/null; then
      log_info "Downloaded workflows/${wf}.json"
    fi
  done

  if [[ "$ok" != "true" ]]; then
    exit 1
  fi
}

gen_secrets() {
  log_step "Generating secrets..."
  local env_file="$CONFIG_DIR/.env"

  local admin_pw
  admin_pw=$(openssl rand -base64 32 | tr -d '=\n/' | head -c 32)
  local session_secret
  session_secret=$(openssl rand -hex 32)
  local db_pw
  db_pw=$(openssl rand -base64 32 | tr -d '=\n' | head -c 32)

  # Resolve the installed version: prefer the release tag fetched at runtime,
  # fall back to the compiled-in INSTALLER_VERSION constant.
  local resolved_version
  resolved_version=$(curl -s "https://api.github.com/repos/SGridworks/agentworks-os-v0.3/releases/latest" 2>/dev/null \
    | sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v?([^"]+)".*/\1/p' | head -1 || true)
  [[ -z "$resolved_version" ]] && resolved_version="${INSTALLER_VERSION}"

  cat > "$env_file" <<EOF
AGENTWORKS_VERSION=${resolved_version}
AGENTWORKS_DATA_DIR=${DATA_DIR}
AGENTWORKS_ADMIN_PASSWORD=${admin_pw}
AGENTWORKS_SESSION_SECRET=${session_secret}
POSTGRES_PASSWORD=${db_pw}
POSTGRES_USER=agentworks
POSTGRES_DB=agentworks
EOF
  chmod 600 "$env_file"
  log_info "Secrets written"
}

pull_images() {
  log_step "Pulling images (or building locally if not published yet)..."
  cd "$AGENTWORKS_DIR"
  # Try pull first; fall through to build on miss. v0.1 publishes nothing yet,
  # so a fresh local install will build from source.
  docker compose pull 2>&1 | while IFS= read -r line; do
    echo "  $line"
  done || true
}

start_services() {
  log_step "Starting services..."
  cd "$AGENTWORKS_DIR"
  # --build forces a fresh build of any image with a `build:` directive that
  # isn't pullable (true for v0.1 agentos-d / scanner-worker).
  docker compose up -d --build
  log_info "Services started"
}

wait_healthy() {
  log_step "Waiting for agentos-d to be healthy..."
  local max_wait=120
  local waited=0
  while [[ $waited -lt $max_wait ]]; do
    if curl -sf http://localhost:7710/api/health > /dev/null 2>&1; then
      log_info "agentos-d is healthy"
      return 0
    fi
    echo -n "."
    sleep 5
    waited=$((waited + 5))
  done
  echo ""
  log_warn "agentos-d did not become healthy within ${max_wait}s"
  log_warn "Run 'docker compose logs' for details"
}

verify() {
  log_step "Verifying..."
  local ok=true

  if curl -sf http://localhost:7710/api/health > /dev/null 2>&1; then
    log_info "agentos-d: UP"
  else
    log_error "agentos-d: DOWN"
    ok=false
  fi

  # postgres runs only with --profile legacy in v0.1 (sqlite is the v1 store)
  if docker compose ps postgres 2>/dev/null | grep -q "running\|Up"; then
    if docker compose exec -T postgres pg_isready -U agentworks &>/dev/null; then
      log_info "postgres: UP"
    else
      log_warn "postgres: DOWN"
    fi
  else
    log_info "postgres: not started (sqlite mode)"
  fi

  if curl -sf http://localhost:5678/healthz > /dev/null 2>&1; then
    log_info "n8n: UP"
  else
    log_warn "n8n: DOWN (will retry after seed step)"
  fi

  if [[ "$ok" != "true" ]]; then
    log_error "Some services failed"
    return 1
  fi
  log_info "All critical services UP"
}

seed_n8n_workflows() {
  log_step "Seeding starter workflows into n8n..."
  local seed_script="$AGENTWORKS_DIR/scripts/n8n-workflow-seed.js"

  if [[ ! -f "$seed_script" ]]; then
    log_warn "Seed script not found at $seed_script — skipping workflow seed"
    log_warn "To seed manually: node $seed_script"
    return 0
  fi

  # Wait for n8n to be fully up (n8n takes longer than agentos-d on first boot)
  local max_wait=180
  local waited=0
  while [[ $waited -lt $max_wait ]]; do
    if curl -sf http://localhost:5678/healthz > /dev/null 2>&1; then
      break
    fi
    echo -n "."
    sleep 5
    waited=$((waited + 5))
  done

  if ! curl -sf http://localhost:5678/healthz > /dev/null 2>&1; then
    log_warn "n8n did not become healthy within ${max_wait}s — skipping workflow seed"
    return 0
  fi

  # Give n8n a moment more on first boot (it initialises its SQLite DB)
  sleep 5

  if node "$seed_script" 2>&1; then
    log_info "n8n workflows seeded"
  else
    log_warn "Workflow seed failed — n8n is up; import workflows manually at http://localhost:5678"
  fi
}

scaffold_workspace() {
  local tenant_id="${1:-}"
  log_step "Scaffolding agent workspace..."

  if [[ -z "$tenant_id" ]]; then
    log_warn "No tenant_id — skipping workspace scaffold"
    return 0
  fi

  local scaffold_script="$AGENTWORKS_DIR/scripts/scaffold-workspace.sh"
  local workspace_dir="${AGENTWORKS_WORKSPACE_DIR:-$HOME/agentworks-workspace}"

  # If running from a checkout, prefer the local script
  if [[ -f "$(pwd)/apps/installer/scripts/scaffold-workspace.sh" ]]; then
    scaffold_script="$(pwd)/apps/installer/scripts/scaffold-workspace.sh"
  fi

  if [[ ! -f "$scaffold_script" ]]; then
    log_warn "scaffold-workspace.sh not found — skipping workspace scaffold"
    return 0
  fi

  bash "$scaffold_script" "$workspace_dir" \
    --tenant-id="$tenant_id" \
    --daemon-url="http://localhost:7710" 2>&1 | while IFS= read -r line; do
    echo "  $line"
  done

  log_info "Workspace: $workspace_dir"
}

create_tenant() {
  log_step "Registering first tenant with agentos-d..."

  local daemon_url="http://localhost:7710"
  local max_wait=120
  local waited=0

  # Wait for daemon to be up
  while [[ $waited -lt $max_wait ]]; do
    if curl -sf "$daemon_url/api/health" > /dev/null 2>&1; then
      break
    fi
    echo -n "."
    sleep 5
    waited=$((waited + 5))
  done

  if ! curl -sf "$daemon_url/api/health" > /dev/null 2>&1; then
    log_error "agentos-d did not respond at $daemon_url/api/health"
    return 1
  fi

  # POST /api/tenants creates the tenant row and seeds smb-starter pack
  local tenant_resp
  tenant_resp=$(curl -sf -X POST "$daemon_url/api/tenants" \
    -H "Content-Type: application/json" \
    -d '{"name":"First Tenant","description":"Initial tenant created by install.sh"}' 2>&1) || {
    log_error "Failed to create tenant: $tenant_resp"
    return 1
  }

  local tenant_id
  tenant_id=$(echo "$tenant_resp" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null) || {
    log_error "Could not parse tenant ID from response: $tenant_resp"
    return 1
  }

  log_info "Tenant registered: $tenant_id"

  # Write ~/.agentworks/config.yaml
  local config_yaml="$HOME/.agentworks/config.yaml"
  mkdir -p "$(dirname "$config_yaml")"
  cat > "$config_yaml" <<EOF
# AgentWorks OS — agent config
# Generated by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
daemon:
  url: "$daemon_url"
  health: "$daemon_url/api/health"
tenant:
  id: "$tenant_id"
  name: "First Tenant"
paths:
  data: "$AGENTWORKS_DIR/data"
  config: "$CONFIG_DIR"
  logs: "$LOG_DIR"
  workspace: "${AGENTWORKS_WORKSPACE_DIR:-$HOME/agentworks-workspace}"
EOF
  chmod 600 "$config_yaml"
  log_info "Wrote config.yaml: $config_yaml"

  echo "$tenant_id"
}

run_smoke_test() {
  local tenant_id="${1:-}"
  log_step "Running smoke tests..."

  if [[ -z "$tenant_id" ]]; then
    log_warn "No tenant_id — skipping smoke test"
    return 0
  fi

  # MCP smoke via python -m agentos_d.mcp_test_client
  if command -v python3 &>/dev/null; then
    if python3 -m agentos_d.mcp_test_client \
      --url http://localhost:7710/api/mcp \
      --tenant-id "$tenant_id" &>/dev/null; then
      log_info "MCP smoke: PASS"
    else
      log_warn "MCP smoke: FAIL — policy engine or rule packs may need attention"
      log_warn "  Run manually: python3 -m agentos_d.mcp_test_client --tenant-id $tenant_id"
    fi
  else
    log_info "python3 not found — skipping MCP smoke test"
  fi
}

print_next_steps() {
  local admin_pw
  admin_pw=$(grep AGENTWORKS_ADMIN_PASSWORD "$CONFIG_DIR/.env" | cut -d= -f2-)

  echo ""
  echo "=============================================================================="
  echo -e "${GREEN}AgentWorks OS installed successfully!${NC}"
  echo "=============================================================================="
  echo ""
  echo "Admin UI:      http://localhost:3000"
  echo "API:           http://localhost:7710"
  echo "n8n:           http://localhost:5678"
  echo ""
  echo "Admin password: $admin_pw"
  echo "(also in $CONFIG_DIR/.env)"
  echo ""
  echo "Agent workspace: ${AGENTWORKS_WORKSPACE_DIR:-$HOME/agentworks-workspace}"
  echo "  → Read AGENTS.md there to brief any connected agent."
  echo ""
  echo "Next steps:"
  echo "  1. Open http://localhost:7710/onboarding  (or http://localhost:3000 for admin UI)"
  echo "  2. Log in with the admin password above"
  echo "  3. Complete the onboarding wizard"
  echo "  4. Run: agentworks mcp configure  (to connect Claude Desktop)"
  echo "  5. Point your agent at the workspace AGENTS.md for context"
  echo ""
  echo "Commands:"
  echo "  agentworks status    # Service status"
  echo "  agentworks logs -f   # Follow logs"
  echo "  agentworks update    # Update to latest"
  echo "  agentworks uninstall # Remove everything"
  echo ""
  echo "=============================================================================="
}

main() {
  echo ""
  echo "AgentWorks OS Installer v${INSTALLER_VERSION}"
  echo "============================================="
  echo ""

  local unattended=false
  local dry_run=false
  if [[ "${1:-}" == "--unattended" ]]; then
    unattended=true
  fi
  if [[ "${1:-}" == "--dry-run" ]]; then
    dry_run=true
  fi

  if [[ "$dry_run" == "true" ]]; then
    echo "Dry-run mode — validating script logic without executing"
    echo ""
    echo "[DRY-RUN] Would run: preflight (docker detection)"
    echo "[DRY-RUN] Would run: create_dirs"
    echo "[DRY-RUN] Would run: download_compose"
    echo "[DRY-RUN] Would run: gen_secrets"
    echo "[DRY-RUN] Would run: pull_images"
    echo "[DRY-RUN] Would run: start_services"
    echo "[DRY-RUN] Would run: wait_healthy"
    echo "[DRY-RUN] Would run: verify"
    echo "[DRY-RUN] Would run: seed_n8n_workflows"
    echo "[DRY-RUN] Would run: create_tenant -> POST /api/tenants"
    echo "[DRY-RUN] Would run: scaffold_workspace"
    echo "[DRY-RUN] Would run: run_smoke_test"
    echo ""
    echo "Dry-run complete."
    return 0
  fi

  if [[ "$unattended" != "true" ]]; then
    echo "This will install AgentWorks OS on this machine."
    echo "Docker is required. Services: agentos-d, scanner-worker, n8n, postgres"
    echo ""
    echo -n "Press Enter to continue, or Ctrl+C to cancel: "
    read -r
  fi

  preflight
  create_dirs
  download_compose
  gen_secrets
  pull_images
  start_services
  wait_healthy
  verify
  seed_n8n_workflows

  # Create tenant (which also writes ~/.agentworks/config.yaml) then scaffold workspace
  local tenant_id=""
  if tenant_id=$(create_tenant 2>&1); then
    scaffold_workspace "$tenant_id"
    # MCP smoke test: policy.check via JSON-RPC 2.0 against real tenant
    run_smoke_test "$tenant_id"
  else
    log_warn "Tenant creation failed — skipping workspace scaffold and smoke test"
  fi

  print_next_steps
}

main "$@"
