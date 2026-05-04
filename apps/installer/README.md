# AgentWorks OS — Installer

One-command bootstrap for AgentWorks OS. Works on any machine with Docker installed.

## Requirements

- **Docker** 20.10+ (with docker compose plugin or standalone `docker-compose`)
- **curl** (to fetch the installer)
- **Internet access** (to pull Docker images on first run)
- macOS, Linux, or Windows with WSL2

## Quick Install

Run this in your terminal:

```bash
curl -fsSL https://get.agentworks.os/install.sh | bash
```

For non-interactive (CI/CD) use:

```bash
curl -fsSL https://get.agentworks.os/install.sh | bash -s -- --unattended
```

## What the Installer Does

1. **Checks Docker** — verifies Docker is installed and the daemon is running
2. **Creates `~/.agentworks/`** — data, config, and log directories
3. **Generates secrets** — `AGENTWORKS_SESSION_SECRET`, admin password, DB password
4. **Writes `~/.agentworks/.env`** — consumed by `docker compose`
5. **Seeds rule-packs** — copies the default compliance packs into the volume
6. **Starts services** — `agentos-d`, `scanner-worker`, `n8n`
7. **Waits for health** — polls `http://localhost:7710/api/health` (up to 60s)
8. **Creates default tenant** — via `POST /api/tenants`
9. **Prints next steps** — URLs, credentials, and CLI commands

## Services

| Service | Port | Description |
|---------|------|-------------|
| `agentos-d` | 7710 | Main substrate daemon (REST + MCP) |
| `scanner-worker` | 3101 | Compliance scanner sidecar |
| `n8n` | 5678 | Workflow automation |

## Post-Install

1. Open **http://localhost:3000** (Admin UI)
2. Log in with the admin password printed at the end of install
3. Complete the onboarding wizard
4. Connect Claude Desktop:

   ```bash
   agentworks mcp configure
   ```

## Managing Services

```bash
# Navigate to the install directory
cd ~/.agentworks

# View status
docker compose ps

# View logs
docker compose logs -f

# Stop services
docker compose down

# Restart services
docker compose up -d

# Update to latest
docker compose pull && docker compose up -d
```

## Uninstall

```bash
cd ~/.agentworks
docker compose down -v      # removes containers + named volumes
rm -rf ~/.agentworks        # removes data, config, logs
```

## Local Checkout Development

If you are running the installer from a repo checkout, the script detects the local `docker-compose.yml` and rule-packs directory and uses them instead of downloading from GitHub:

```bash
cd ~/Projects/agentworks-os
./apps/installer/bin/install.sh
```

## Troubleshooting

### "Docker daemon is not running"

Start Docker Desktop (or `sudo systemctl start docker` on Linux).

### "agentos-d did not respond within 60s"

Check if the container started correctly:

```bash
cd ~/.agentworks
docker compose logs agentos-d
```

### Services start but n8n is slow

n8n initialises its internal SQLite DB on first boot and may take up to 2 minutes. The installer does not block on n8n.

### Rule-packs not loading

Rule-packs are copied to `${AGENTWORKS_DATA_DIR}/rule-packs/` and mounted into the `agentos-d` container at `/opt/agentworks/rule-packs`. Verify:

```bash
ls ~/.agentworks/rule-packs/
docker exec agentos-d ls /opt/agentworks/rule-packs/
```

## Architecture

```
~/.agentworks/
├── .env                 # Generated secrets + config (mode 600)
├── config/
│   └── secrets.json     # Plain-text secrets for installer use
├── data/
│   ├── agentworks.db    # SQLite database
│   ├── vault/           # Encrypted tenant vault
│   └── rule-packs/     # Copied compliance packs
├── logs/                # docker compose logs output
└── docker-compose.yml  # Downloaded by installer
```
