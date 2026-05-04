#!/usr/bin/env bash
#
# agentworks install — one-command setup for AgentWorks OS
# Usage:
#   curl -fsSL https://github.com/SGridworks/agentworks-os/releases/download/v0.1.2/install.sh | bash
#   curl -fsSL https://github.com/SGridworks/agentworks-os/releases/download/v0.1.2/install.sh | bash -s -- --unattended
#
# To install a different release, override INSTALLER_REF:
#   curl -fsSL https://github.com/SGridworks/agentworks-os/releases/download/v0.2.0/install.sh \
#     | INSTALLER_REF=v0.2.0 bash
#
set -euo pipefail

# -----------------------------------------------------------------------------
# Constants
# -----------------------------------------------------------------------------
readonly INSTALLER_VERSION="0.1.2"
readonly REPO="SGridworks/agentworks-os"
# Pin asset fetches to the release tag so v0.1.1 installer cannot silently
# pull future main-branch changes. Override with INSTALLER_REF=<branch|tag|sha>
# only for development.
readonly INSTALLER_REF="${INSTALLER_REF:-v${INSTALLER_VERSION}}"
readonly COMPOSE_URL="https://raw.githubusercontent.com/${REPO}/${INSTALLER_REF}/docker-compose.yml"
readonly GITHUB_API="https://api.github.com"
readonly AGENTWORKS_DIR="${AGENTWORKS_DIR:-$HOME/.agentworks}"
readonly DATA_DIR="${AGENTWORKS_DIR}/data"
readonly CONFIG_DIR="${AGENTWORKS_DIR}/config"
readonly LOG_DIR="${AGENTWORKS_DIR}/logs"
readonly ENV_FILE="${CONFIG_DIR}/.env"
readonly SECRETS_FILE="${CONFIG_DIR}/secrets.json"

# Color codes (disabled if not a TTY)
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
# Dependency checks
# -----------------------------------------------------------------------------
check_docker() {
  if ! command -v docker &>/dev/null; then
    log_error "Docker is not installed. Visit: https://docs.docker.com/get-docker/"
    exit 1
  fi

  local docker_version
  docker_version=$(docker version --format '{{.Server.Version}}' 2>/dev/null || docker --version | grep -oP '\d+\.\d+' | head -1)
  if [[ -z "$docker_version" ]]; then
    log_error "Could not determine Docker version. Is the Docker daemon running?"
    exit 1
  fi

  log_info "Docker version: ${docker_version}"
}

check_docker_compose() {
  if ! docker compose version &>/dev/null && ! command -v docker-compose &>/dev/null; then
    log_error "Docker Compose is not installed."
    exit 1
  fi
  local compose_version
  compose_version=$(docker compose version --short 2>/dev/null || docker-compose --version | grep -oP '\d+\.\d+' | head -1)
  log_info "Docker Compose version: ${compose_version}"
}

check_curl() {
  if ! command -v curl &>/dev/null; then
    log_error "curl is not installed."
    exit 1
  fi
}

# -----------------------------------------------------------------------------
# Pre-flight checks
# -----------------------------------------------------------------------------
preflight_check() {
  log_step "Running pre-flight checks..."
  check_curl
  check_docker
  check_docker_compose

  # Check Docker is actually running
  if ! docker info &>/dev/null; then
    log_error "Docker daemon is not running. Please start Docker Desktop."
    exit 1
  fi

  # Check platform
  local platform
  platform=$(uname -s)
  local arch
  arch=$(uname -m)
  log_info "Platform: ${platform}/${arch}"

  if [[ "$platform" == "Darwin" ]]; then
    log_info "Detected macOS. Ensure Docker Desktop is using Linux containers."
  fi

  log_info "Pre-flight checks passed."
}

# -----------------------------------------------------------------------------
# Create directories
# -----------------------------------------------------------------------------
create_directories() {
  log_step "Creating AgentWorks directories..."
  mkdir -p "${DATA_DIR}" "${CONFIG_DIR}" "${LOG_DIR}"
  log_info "Data directory: ${DATA_DIR}"
  log_info "Config directory: ${CONFIG_DIR}"
  log_info "Log directory: ${LOG_DIR}"
}

# -----------------------------------------------------------------------------
# Download docker-compose.yml
# -----------------------------------------------------------------------------
download_compose() {
  log_step "Downloading docker-compose.yml..."
  local compose_file="${AGENTWORKS_DIR}/docker-compose.yml"

  local http_code
  http_code=$(curl -o /dev/null -s -w "%{http_code}" \
    --fail-with-body \
    -L "${COMPOSE_URL}" \
    -o "${compose_file}" 2>/dev/null || echo "000")

  if [[ "$http_code" != "200" ]]; then
    log_error "Failed to download docker-compose.yml (HTTP ${http_code})"
    log_error "URL: ${COMPOSE_URL}"
    exit 1
  fi

  log_info "Downloaded docker-compose.yml"
}

# -----------------------------------------------------------------------------
# Generate secrets
# -----------------------------------------------------------------------------
generate_secrets() {
  log_step "Generating secrets..."

  # Admin password (32 chars, base64)
  local admin_password
  admin_password=$(openssl rand -base64 32 | tr -d '=\n/' | head -c 32)

  # Session secret (32 bytes, hex)
  local session_secret
  session_secret=$(openssl rand -hex 32)

  # Database password (32 chars)
  local db_password
  db_password=$(openssl rand -base64 32 | tr -d '=\n' | head -c 32)

  # Write .env file to AGENTWORKS_DIR root (where docker-compose.yml lives)
  # so docker compose can read these variables automatically.
  # Also write a copy to CONFIG_DIR for the agentworks CLI tool.
  cat > "${AGENTWORKS_DIR}/.env" <<EOF
# Auto-generated on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# DO NOT COMMIT THIS FILE
AGENTWORKS_VERSION=${INSTALLER_VERSION}
AGENTWORKS_DATA_DIR=${DATA_DIR}
AGENTWORKS_SESSION_SECRET=${session_secret}
POSTGRES_PASSWORD=${db_password}
POSTGRES_USER=agentworks
POSTGRES_DB=agentworks
AGENTOS_HOST=0.0.0.0
AGENTOS_PORT=7710
AGENTOS_LOG_LEVEL=info
AGENTOS_AWCP_VERSION=awcp/v0.1
EOF

  # Write .env copy to CONFIG_DIR
  cp "${AGENTWORKS_DIR}/.env" "${ENV_FILE}"

  # Write secrets to a separate file (chmod 600)
  cat > "${SECRETS_FILE}" <<EOF
{
  "admin_password": "${admin_password}",
  "session_secret": "${session_secret}",
  "db_password": "${db_password}"
}
EOF
  chmod 600 "${SECRETS_FILE}"

  log_info "Secrets written to ${SECRETS_FILE} (mode 600)"
  log_info ".env written to ${AGENTWORKS_DIR}/.env"
  chmod 600 "${AGENTWORKS_DIR}/.env" "${ENV_FILE}"
}

# -----------------------------------------------------------------------------
# Pull images
# -----------------------------------------------------------------------------
pull_images() {
  log_step "Pulling Docker images (this may take a few minutes)..."
  cd "${AGENTWORKS_DIR}"

  if ! docker compose pull 2>&1 | tee "${LOG_DIR}/docker-pull.log"; then
    log_error "Failed to pull Docker images. Check ${LOG_DIR}/docker-pull.log"
    exit 1
  fi

  log_info "Images pulled successfully."
}

# -----------------------------------------------------------------------------
# Start services
# -----------------------------------------------------------------------------
start_services() {
  log_step "Starting AgentWorks services..."
  cd "${AGENTWORKS_DIR}"

  # Create named volumes for persistence
  docker volume create agentworks-postgres-data &>/dev/null || true

  if ! docker compose up -d 2>&1 | tee "${LOG_DIR}/docker-up.log"; then
    log_error "Failed to start services. Check ${LOG_DIR}/docker-up.log"
    exit 1
  fi

  log_info "Services started."
}

# -----------------------------------------------------------------------------
# Wait for services to be healthy
# -----------------------------------------------------------------------------
wait_for_services() {
  log_step "Waiting for services to be healthy..."

  local max_wait=120
  local elapsed=0
  local interval=5

  while [[ $elapsed -lt $max_wait ]]; do
    # Check agentos-d health
    local health_status
    health_status=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:7710/api/health 2>/dev/null || echo "000")

    if [[ "$health_status" == "200" ]]; then
      log_info "agentos-d is healthy (HTTP ${health_status})"
      break
    fi

    echo -n "."
    sleep $interval
    elapsed=$((elapsed + interval))
  done
  echo ""

  if [[ $elapsed -ge $max_wait ]]; then
    log_warn "Services did not become healthy within ${max_wait} seconds."
    log_warn "Check status with: docker compose ps"
    log_warn "Logs: docker compose logs"
  fi
}

# -----------------------------------------------------------------------------
# Verify installation
# -----------------------------------------------------------------------------
verify_install() {
  log_step "Verifying installation..."

  local all_up=true

  # Check agentos-d
  local agentos_health
  agentos_health=$(curl -s http://localhost:7710/api/health 2>/dev/null || true)
  if [[ -n "$agentos_health" ]] && echo "$agentos_health" | grep -q '"status"'; then
    log_info "agentos-d: ${GREEN}UP${NC}"
  else
    log_error "agentos-d: ${RED}DOWN${NC}"
    all_up=false
  fi

  # Check postgres — only if the legacy profile is active (not running in v1 by default)
  if docker compose ps postgres 2>/dev/null | grep -q "Up"; then
    if docker compose exec -T postgres pg_isready &>/dev/null; then
      log_info "postgres: ${GREEN}UP${NC}"
    else
      log_warn "postgres: ${YELLOW}DOWN${NC} (legacy profile)"
    fi
  else
    log_info "postgres: ${YELLOW}NOT STARTED${NC} (legacy profile — not used in v1)"
  fi

  # Check scanner-worker
  if docker compose ps scanner-worker 2>/dev/null | grep -q "Up"; then
    log_info "scanner-worker: ${GREEN}UP${NC}"
  else
    log_warn "scanner-worker: ${YELLOW}DOWN or not running${NC}"
  fi

  # Check n8n
  local n8n_status
  n8n_status=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5678 2>/dev/null || echo "000")
  if [[ "$n8n_status" == "200" ]] || [[ "$n8n_status" == "302" ]]; then
    log_info "n8n: ${GREEN}UP${NC} (HTTP ${n8n_status})"
  else
    log_warn "n8n: ${YELLOW}DOWN${NC} (HTTP ${n8n_status})"
  fi

  if [[ "$all_up" == "false" ]]; then
    log_error "Some services failed to start. Run 'docker compose logs' for details."
    return 1
  fi

  log_info "All critical services are up."
}

# -----------------------------------------------------------------------------
# Print next steps
# -----------------------------------------------------------------------------
print_next_steps() {
  # Retrieve admin password from secrets file
  local admin_password
  admin_password=$(cat "${SECRETS_FILE}" 2>/dev/null | grep -o '"admin_password"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "unknown")

  echo ""
  echo "=============================================================================="
  echo -e "${GREEN}AgentWorks OS installation complete!${NC}"
  echo "=============================================================================="
  echo ""
  echo "Admin UI:       http://localhost:3000"
  echo "API:            http://localhost:7710"
  echo "n8n Workflow:   http://localhost:5678"
  echo ""
  echo "NOTE: n8n is self-hosted only. Commercial SaaS use requires a paid license."
  echo "      See licenses/SUL_NOTICE.md for details."
  echo ""
  echo "Admin password: ${admin_password}"
  echo "(also saved in ${SECRETS_FILE})"
  echo ""
  echo "Next steps:"
  echo "  1. Open http://localhost:3000 in your browser"
  echo "  2. Log in with the admin password above"
  echo "  3. Complete the onboarding wizard"
  # Auto-open admin UI in default browser if possible
  if command -v open >/dev/null 2>&1; then
    open http://localhost:3000 &>/dev/null &
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open http://localhost:3000 &>/dev/null &
  fi
  echo "  4. Configure Claude Desktop MCP: agentworks mcp configure"
  echo ""
  echo "Commands:"
  echo "  agentworks status    # Show service status"
  echo "  agentworks logs      # Tail service logs"
  echo "  agentworks update    # Update to latest version"
  echo "  agentworks uninstall # Remove AgentWorks"
  echo ""
  echo "=============================================================================="
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
  echo ""
  echo "AgentWorks OS Installer v${INSTALLER_VERSION}"
  echo "============================================="
  echo ""

  # Check for --unattended flag (skip prompts)
  local unattended=false
  if [[ "${1:-}" == "--unattended" ]]; then
    unattended=true
  fi

  if [[ "$unattended" != "true" ]]; then
    echo "This will install AgentWorks OS on this machine."
    echo "Docker is required. The installer will:"
    echo "  1. Create ~/.agentworks/ directory"
    echo "  2. Download docker-compose.yml"
    echo "  3. Generate secure credentials"
    echo "  4. Start 3 Docker services (agentos-d, scanner-worker, n8n)"
    echo "     Note: postgres is in legacy profile (not started — v1 uses SQLite)"
    echo ""
    echo -n "Press Enter to continue, or Ctrl+C to cancel: "
    read -r
  fi

  preflight_check
  create_directories
  download_compose
  generate_secrets
  pull_images
  start_services
  wait_for_services
  verify_install || true
  print_next_steps
}

main "$@"
