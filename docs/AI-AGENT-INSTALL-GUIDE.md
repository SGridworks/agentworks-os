# AI Agent Install Guide — AgentWorks OS

**Audience:** an AI coding agent (Claude Code, Codex, Cursor, etc.) that the operator has tasked with installing AgentWorks OS end-to-end, setting up the vault, and connecting at least one agent.

**Operator hand-off:** copy this entire file into the agent's session, or pass the path to it, and say *"follow this guide to install AgentWorks OS on this machine."*

**Target version:** v0.1.1
**Estimated wall-clock:** 15–30 minutes on a clean machine, mostly Docker pulls.

---

## How to read this guide

You are an autonomous agent. The operator has handed this document to you and expects you to:

1. **Run every numbered step in order.** Do not skip ahead.
2. **Verify each step before moving on.** Every step has a `Verify:` block with a command and the expected output. If verification fails, follow the `Fix:` block.
3. **Ask the operator for input only at the four marked decision points** (§2 install location, §3 tenant ID, §6 first MCP client, §8 vault sharing). Everything else has a documented default — pick the default.
4. **Do not modify host config outside the install directory** without telling the operator first. The install directory defaults to `~/.agentworks/`.
5. **Stop and ask** if any verification fails twice in a row. Don't keep retrying — the second failure means the diagnosis is wrong.
6. **Report back.** At the end, post the §11 Final Report to the operator verbatim, with your filled-in values.

Conventions in this guide:

- `$HOME` means the operator's home directory; you can resolve it with `echo $HOME`.
- Commands in fenced code blocks are meant to be run as-is. If a command needs a value substituted, the placeholder is in `<ANGLE_BRACKETS>`.
- "The daemon" means the `agentos-d` process. "The substrate" is the running stack as a whole.

---

## §0 — Preflight

Before installing, confirm the host meets the bar.

### 0.1 Operating system

Supported: macOS 12+ (Apple Silicon or Intel), Ubuntu 20.04+, Debian 11+.

```bash
uname -s        # Darwin or Linux
sw_vers 2>/dev/null || cat /etc/os-release | head -3
```

If neither macOS nor a supported Linux, **stop** and tell the operator the host is not supported.

### 0.2 Docker

```bash
docker --version
docker ps
```

**Verify:** `docker --version` prints a version, and `docker ps` prints a header row (the container list may be empty — that's fine).

**Fix:**
- If `docker` is not found on macOS: tell the operator to install Docker Desktop from https://docs.docker.com/desktop/install/mac-install/ and restart it. Do not attempt to install Docker yourself.
- If `docker ps` errors with "Cannot connect to the Docker daemon": Docker Desktop is installed but not running. On macOS, ask the operator to open Docker Desktop. On Linux, run `sudo systemctl start docker`.
- Wait for Docker to come up (up to 60 seconds) and re-run `docker ps` before proceeding.

### 0.3 Disk and RAM

```bash
df -h $HOME | tail -1     # need >= 20 GB free
```

```bash
# macOS
sysctl hw.memsize 2>/dev/null
# Linux
free -h 2>/dev/null
```

**Verify:** at least 20 GB free on the volume holding `$HOME`, and at least 4 GB RAM (8 GB recommended).

If under either threshold, stop and tell the operator. Do not auto-clean disk.

### 0.4 Ports

The substrate binds three ports on `127.0.0.1`. Check none are already in use:

```bash
for port in 7710 3101 5678; do
  if lsof -i :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "PORT $port IN USE"
  else
    echo "port $port free"
  fi
done
```

**Verify:** all three say "free".

**Fix:** if a port is in use, ask the operator what's running on it. Do not kill processes you didn't start. The installer does not currently support remapping these ports — escalate to the operator.

### 0.5 Network

```bash
curl -fsSL -I https://github.com/SGridworks/agentworks-os/releases/download/v0.1.1/install.sh 2>&1 | head -1
```

**Verify:** `HTTP/2 200`.

**Fix:** if the operator is behind a corporate proxy, ask them to set `HTTPS_PROXY` before continuing. Do not bypass certificate validation.

---

## §1 — Decision: install location

**Default:** `$HOME/.agentworks/`

The installer reads `AGENTWORKS_DIR` from the environment. If unset, it uses `$HOME/.agentworks/`. This is where the docker-compose file, generated `.env`, secrets, and SQLite data live. The vault directory (markdown content) lives separately at the path the operator chooses in §8.

**Decision point:** ask the operator only if they have a non-default preference. Otherwise proceed with the default and skip ahead.

```bash
echo "Install dir will be: ${AGENTWORKS_DIR:-$HOME/.agentworks}"
```

---

## §2 — Run the installer

### 2.1 Fetch and run

```bash
curl -fsSL https://github.com/SGridworks/agentworks-os/releases/download/v0.1.1/install.sh -o /tmp/awos-install.sh
chmod +x /tmp/awos-install.sh
/tmp/awos-install.sh --unattended
```

The `--unattended` flag suppresses interactive prompts and uses safe defaults. If the operator wants the interactive flow, omit the flag.

The installer will:

1. Verify Docker is reachable (re-checks §0.2).
2. Create `$HOME/.agentworks/` (or `$AGENTWORKS_DIR` if set) with subdirs `data/`, `config/`, `logs/`.
3. Download `docker-compose.yml` pinned to v0.1.1.
4. Generate three secrets: admin password, session secret, database password (written to `$HOME/.agentworks/config/secrets.json`, mode 600).
5. Write `$HOME/.agentworks/.env` (mode 600) with non-secret config plus secret references.
6. `docker compose pull` to fetch container images from GHCR.
7. `docker compose up -d` to start `agentos-d`, `scanner-worker`, and `n8n`.
8. Print the admin password.

### 2.2 Capture the admin password

The installer prints the admin password once. **Capture it from `secrets.json` immediately**, do not parrot it back to the operator over the chat:

```bash
test -f $HOME/.agentworks/config/secrets.json && \
  echo "secrets.json exists, mode $(stat -f '%Lp' $HOME/.agentworks/config/secrets.json 2>/dev/null || stat -c '%a' $HOME/.agentworks/config/secrets.json)"
```

**Verify:** prints `secrets.json exists, mode 600`.

**Fix:** if the file is missing, the installer failed silently. Re-run with verbose logging: `bash -x /tmp/awos-install.sh --unattended 2>&1 | tee /tmp/awos-install.log` and surface the first non-zero exit to the operator.

---

## §3 — Decision: tenant ID

**Default:** the daemon auto-creates a tenant on first request and prints its UUID to the log.

A "tenant" in AgentWorks OS is an isolated subtree of the vault and an isolated row-set in the database. Solo operators get one tenant. Teams running for multiple business units pick one tenant per unit.

**Decision point:** ask the operator:

> *"Do you want to use the default auto-generated tenant ID, or do you have an existing tenant ID to keep using?"*

Almost everyone wants the default. Only override if the operator is reinstalling and points you at an existing data directory.

```bash
# Discover the auto-created tenant ID after first daemon boot:
TENANT_ID=$(docker compose -f $HOME/.agentworks/docker-compose.yml exec -T agentos-d \
  sh -c 'cat /app/data/tenant-bootstrap.json 2>/dev/null | grep -o "\"id\":\"[^\"]*\"" | head -1 | cut -d\" -f4' \
  2>/dev/null)
echo "TENANT_ID=$TENANT_ID"
```

If the command returns empty, the daemon hasn't bootstrapped yet — wait for §4 to pass first, then re-run.

---

## §4 — Verify services are healthy

### 4.1 All containers up

```bash
docker compose -f $HOME/.agentworks/docker-compose.yml ps --format "table {{.Service}}\t{{.Status}}"
```

**Verify:** `agentos-d`, `scanner-worker`, and `n8n` all show `Up` or `running`. The `postgres` row may show `Exit 0` — that is expected (v1 uses SQLite; postgres is a `legacy` profile only).

**Fix:** if any of the three is restarting or exited, dump the last 50 log lines and surface the error:

```bash
docker compose -f $HOME/.agentworks/docker-compose.yml logs --tail 50 <service-name>
```

The most common failure is a port conflict — re-check §0.4.

### 4.2 Daemon health endpoint

```bash
curl -sS http://127.0.0.1:7710/api/health | head -c 300
```

**Verify:** JSON response with `"status":"ok"` (or `"healthy"`).

**Fix:** if connection refused, the daemon is up but not yet listening. Wait 10 seconds and retry. If it still fails after 30 seconds, the daemon crashed silently — get logs:

```bash
docker compose -f $HOME/.agentworks/docker-compose.yml logs agentos-d --tail 100
```

### 4.3 Scanner sidecar

```bash
curl -sS http://127.0.0.1:3101/health | head -c 200
```

**Verify:** `{"status":"ok"}` or similar.

**Fix:** scanner failures don't block install — the substrate works without the scanner. Note this in the final report and continue.

---

## §5 — Admin UI smoke test

The Admin UI ships as a separate container (or as a Next.js server in dev). The installer wires it on port 3000 by default if available; otherwise it's reachable through the daemon.

```bash
# Check whether the Admin UI is exposed:
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/ 2>/dev/null
```

**Verify:** prints `200` or `307` (a redirect to the onboarding wizard).

**Fix:** if it prints `000` (refused), the Admin UI is not running standalone. That's fine for v0.1.1 — the operator can hit the daemon's REST surface directly. Note in the report.

If the Admin UI is up, tell the operator:

> *"Admin UI is at http://127.0.0.1:3000/. Your admin password is in `~/.agentworks/config/secrets.json` under `admin_password`. The first-time wizard will walk you through onboarding."*

Do **not** print the password value into chat. Refer the operator to the file.

---

## §6 — Decision: first MCP client

**Default:** Claude Desktop (most common).

The MCP (Model Context Protocol) bridge is what lets a coding agent read/write the vault and submit actions through the policy engine. Pick exactly one client to wire up first; the operator can wire others later.

**Decision point:** ask the operator:

> *"Which MCP client should I wire up first? Options: Claude Desktop, Cursor, Codex CLI. Default is Claude Desktop."*

### 6.1 Locate the MCP stdio bridge

The bridge ships inside the `agentos-d` container. Copy it out so the host MCP client can spawn it directly:

```bash
docker cp agentos-d:/app/dist/bin/mcp-stdio-bridge.js \
  $HOME/.agentworks/config/mcp-stdio-bridge.js
chmod +x $HOME/.agentworks/config/mcp-stdio-bridge.js
ls -l $HOME/.agentworks/config/mcp-stdio-bridge.js
```

**Verify:** the file exists and is at least 1 KB.

### 6.2 Claude Desktop

Edit `$HOME/Library/Application Support/Claude/claude_desktop_config.json` (macOS). If the file does not exist, create it with `{}` first.

Add an `mcpServers.agentworks` entry. **Read the existing file first** so you don't overwrite other servers:

```bash
test -f "$HOME/Library/Application Support/Claude/claude_desktop_config.json" || \
  echo '{}' > "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
cat "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
```

Then merge in:

```json
{
  "mcpServers": {
    "agentworks": {
      "command": "node",
      "args": ["<HOME>/.agentworks/config/mcp-stdio-bridge.js"],
      "env": {
        "AGENTOS_URL": "http://127.0.0.1:7710",
        "AGENTOS_TENANT_ID": "<TENANT_ID_FROM_§3>"
      }
    }
  }
}
```

Substitute `<HOME>` with the absolute path (Claude Desktop does not expand `~` or `$HOME`) and `<TENANT_ID_FROM_§3>` with the value you captured.

**Verify:** ask the operator to fully quit Claude Desktop (Cmd+Q, not just close window) and relaunch. Then in a Claude conversation, run `/mcp list`. The output should include `agentworks` as an active server.

### 6.3 Cursor

Edit `~/.cursor/mcp.json` (or via Cursor Settings → MCP). Same JSON shape as §6.2.

### 6.4 Codex CLI

Codex reads MCP config from `~/.codex/mcp.json`. Same shape.

---

## §7 — Smoke-test the policy engine

Before exposing the substrate to a real agent, run one canned policy check end-to-end.

```bash
curl -sS -X POST http://127.0.0.1:7710/api/policy/check \
  -H "content-type: application/json" \
  -d '{
    "tenantId": "'"$TENANT_ID"'",
    "action": {
      "kind": "email.send",
      "payload": { "to": "test@example.com", "subject": "smoke test", "body": "hi" }
    }
  }' | head -c 500
```

**Verify:** JSON response with a `decision` field — one of `allow`, `block`, or `route_to_review`.

**Fix:** if you get an HTTP 400, the request shape is wrong — re-check the JSON. If you get an HTTP 500, dump daemon logs:

```bash
docker compose -f $HOME/.agentworks/docker-compose.yml logs agentos-d --tail 100
```

If the response is `route_to_review` because no rule packs are loaded yet, that is expected on a fresh install. The operator will install rule packs in §9.

---

## §8 — Decision: vault setup

The vault is the markdown knowledge base your agents will read from and write to. AgentWorks OS uses a tenant-scoped `FileVaultStore`: each tenant's content lives at `<VAULT_ROOT>/<TENANT_ID>/`.

**Default `VAULT_ROOT`:** `$HOME/vault/wiki/` (the daemon falls back to this if `VAULT_ROOT` is unset).

**Default tenant directory:** `$HOME/vault/wiki/<TENANT_ID>/`.

**Decision point:** ask the operator:

> *"Three vault layouts. Which fits your situation?
>
> **A) Fresh vault, no shared content.** I'll create a clean `~/vault/wiki/<TENANT_ID>/` and that's it. Simplest. Pick this if you don't have an existing markdown knowledge base.
>
> **B) Existing vault, want to share it across tenants.** You already have markdown content at `~/vault/`. I'll symlink shared subdirs (like `wiki/concepts/`) into the tenant dir so they show up in the agent's context without duplication.
>
> **C) External vault path.** Vault lives somewhere else (e.g., `~/Documents/notes/`). I'll set `VAULT_ROOT` in the daemon's env and create the tenant subdir there.
>
> Default: A."*

### 8.1 Layout A — fresh vault

```bash
mkdir -p $HOME/vault/wiki/$TENANT_ID
echo "# $TENANT_ID — vault root" > $HOME/vault/wiki/$TENANT_ID/README.md
ls $HOME/vault/wiki/$TENANT_ID
```

**Verify:** `README.md` is listed.

### 8.2 Layout B — shared content via symlinks

The v0.1.1 `FileVaultStore.list()` walks symlinks safely (cycle-detected via realpath dedup). You can symlink any subdir of `~/vault/` into the tenant dir and the substrate will index it.

```bash
mkdir -p $HOME/vault/wiki/$TENANT_ID
cd $HOME/vault/wiki/$TENANT_ID
# Replace 'concepts' with whatever shared subdir(s) the operator wants:
ln -s ../concepts concepts
ln -s ../people people
ls -la
```

**Verify:** the symlinks resolve (`ls -L` shows the target contents).

**Important:** do NOT symlink the operator's `~/.claude/projects/.../memory/` directory unless they ask. That folder contains operator-private memory and may include secrets.

### 8.3 Layout C — external VAULT_ROOT

Edit `$HOME/.agentworks/.env` and add (or update) `VAULT_ROOT`:

```bash
# Read the file first so you preserve other settings:
cat $HOME/.agentworks/.env
# Then append (or modify) VAULT_ROOT:
echo "VAULT_ROOT=/absolute/path/to/vault/wiki" >> $HOME/.agentworks/.env
```

The path must exist and be readable by the Docker container. If using Docker Desktop on macOS, the path must be inside one of the configured shared paths (Settings → Resources → File Sharing).

Restart the daemon so it picks up the new env:

```bash
docker compose -f $HOME/.agentworks/docker-compose.yml restart agentos-d
```

**Verify (any layout):** the graph endpoint sees the directory:

```bash
curl -sS "http://127.0.0.1:7710/api/memory/graph?tenantId=$TENANT_ID" | head -c 300
```

You should see at least one node (the README from §8.1, or whatever was already in the vault).

### 8.4 Frontmatter convention

Every markdown file in the vault should have YAML frontmatter. The operator's vault may already follow a convention; if you're authoring new pages, use:

```markdown
---
title: Page Title
tags: [tag1, tag2]
created: 2026-05-04
updated: 2026-05-04
---

# Page Title

Body...
```

Cross-references use `[[wikilinks]]`. The graph route uses these to build edges.

---

## §9 — Install at least one rule pack

A fresh install has no rule packs loaded, so every action returns `route_to_review`. Install the SMB starter pack so the policy engine has something to evaluate against.

```bash
docker compose -f $HOME/.agentworks/docker-compose.yml exec -T agentos-d \
  agentos rule-packs install smb-starter
```

**Verify:**

```bash
curl -sS http://127.0.0.1:7710/api/policy/packs/stats | head -c 500
```

`smb-starter` should appear with a non-zero `rulesCount`.

**Fix:** if the `agentos rule-packs install` command is not found, the CLI may not be wired in v0.1.1. Fall back to copying the pack YAML into the rule-packs directory mounted into the container, then call `POST /api/policy/packs/reload`.

Tell the operator:

> *"`smb-starter` is a generic compliance baseline. For your industry, you'll want to add `tcpa-real-estate`, `fair-housing`, or another pack from `rule-packs/`. The Admin UI's onboarding wizard at `/onboarding` will walk you through this."*

---

## §10 — Backup and update procedure

### 10.1 First backup

Take a baseline backup so the operator has a known-good state to roll back to:

```bash
docker compose -f $HOME/.agentworks/docker-compose.yml exec -T agentos-d \
  agentos backup --output /app/data/backups/baseline-$(date +%Y%m%d).tar.gz
ls $HOME/.agentworks/data/backups/
```

**Verify:** a `baseline-YYYYMMDD.tar.gz` file exists and is at least a few KB.

### 10.2 Update procedure (for the operator's reference)

Tell the operator that future updates follow this pattern:

```bash
# 1. Backup
docker compose -f $HOME/.agentworks/docker-compose.yml exec -T agentos-d \
  agentos backup --output /app/data/backups/pre-update-$(date +%Y%m%d).tar.gz

# 2. Pull new images (operator runs this with the new release tag)
INSTALLER_REF=v0.1.2 curl -fsSL \
  https://github.com/SGridworks/agentworks-os/releases/download/v0.1.2/install.sh | bash -s -- --update

# 3. The installer pulls new images and runs forward-only migrations.
```

Do not auto-update during install — that's the operator's call.

---

## §11 — Final report

Post this back to the operator, filling in the bracketed values from your run:

```
AgentWorks OS v0.1.1 install complete.

Install location:  [PATH from §1, default $HOME/.agentworks]
Tenant ID:         [UUID from §3]
Daemon URL:        http://127.0.0.1:7710
Admin UI:          [http://127.0.0.1:3000 / not exposed standalone — see §5]
Admin password:    saved in ~/.agentworks/config/secrets.json (mode 600)
Vault layout:      [A / B / C from §8]
Vault root:        [PATH from §8]
MCP client wired:  [Claude Desktop / Cursor / Codex from §6]
MCP bridge path:   ~/.agentworks/config/mcp-stdio-bridge.js
Rule packs loaded: [list from §9, e.g. "smb-starter (12 rules)"]
Baseline backup:   ~/.agentworks/data/backups/baseline-YYYYMMDD.tar.gz

Verifications passed:
  [✓] §0 preflight (OS, Docker, ports, network)
  [✓] §4.1 docker compose ps — all 3 services Up
  [✓] §4.2 /api/health returns ok
  [✓] §4.3 scanner /health returns ok    [or: skipped — scanner failed, non-blocking]
  [✓] §7 policy check returns a decision
  [✓] §8 graph endpoint returns vault nodes
  [✓] §9 rule-pack stats show smb-starter loaded
  [✓] §10.1 baseline backup exists

What you should do next:
  1. Open the Admin UI and complete the onboarding wizard at /onboarding.
  2. Pick rule packs that match your industry (real estate, healthcare, etc.).
  3. In your MCP client, run a small test action and watch it appear in the audit log.
  4. Read the User's Guide at docs/users-guide.md for the full feature tour.

Notes / caveats:
  [Anything that didn't go cleanly — e.g. "Admin UI not exposed; using REST directly".
   "scanner-worker restarted twice during boot but is healthy now". Be specific. If
   nothing went wrong, write "None."]
```

---

## Reference: common errors

### "Cannot connect to the Docker daemon"

Docker Desktop is not running, or on Linux the docker service is stopped. See §0.2 fix.

### "Port 7710 already in use"

Something else is bound to the daemon port. The installer doesn't currently support port remapping — surface to operator and ask what's running.

### "/api/health returns 404"

The daemon is up but the route is wrong. You're likely talking to a stale image. Run `docker compose pull && docker compose up -d` and retry.

### "Memory graph shows zero nodes"

Either the tenant directory is empty (write a README — see §8.1) or `VAULT_ROOT` is misconfigured. Check `docker compose exec agentos-d env | grep VAULT_ROOT`.

### "MCP server not showing in Claude /mcp list"

Most common cause: relative path in `claude_desktop_config.json`. Claude Desktop does not expand `~` or `$HOME`. Use the absolute path (`echo $HOME` and substitute manually). Second cause: Claude Desktop wasn't fully quit (Cmd+Q) before relaunch — closing the window is not enough.

### "Admin password is in chat history"

Don't put it there. Always refer the operator to the secrets file path. If you accidentally printed it, tell the operator and rotate immediately:

```bash
docker compose -f $HOME/.agentworks/docker-compose.yml exec -T agentos-d \
  agentos admin rotate-password
```

### "Daemon SQLite empty after restart"

Known v0.1.x risk. Always run §10.1 backup before restarting the daemon, and never `rm -rf` `~/.agentworks/data/` without confirming with the operator first.

---

## Reference: paths and ports cheat sheet

| Thing | Where |
|---|---|
| Install dir | `$HOME/.agentworks/` |
| docker-compose.yml | `$HOME/.agentworks/docker-compose.yml` |
| .env (mode 600) | `$HOME/.agentworks/.env` |
| Secrets (mode 600) | `$HOME/.agentworks/config/secrets.json` |
| SQLite DB | `$HOME/.agentworks/data/agentworks.db` |
| Backups | `$HOME/.agentworks/data/backups/` |
| Logs | `$HOME/.agentworks/logs/` |
| MCP bridge | `$HOME/.agentworks/config/mcp-stdio-bridge.js` |
| Vault (default) | `$HOME/vault/wiki/<TENANT_ID>/` |
| Daemon | `http://127.0.0.1:7710` |
| Scanner | `http://127.0.0.1:3101` |
| n8n | `http://127.0.0.1:5678` |
| Admin UI | `http://127.0.0.1:3000` (if exposed) |

---

## See also

- [README.md](../README.md) — product overview
- [docs/install-runbook.md](./install-runbook.md) — human-oriented version of this guide
- [docs/users-guide.md](./users-guide.md) — full feature tour, post-install
- [docs/mcp-integration.md](./mcp-integration.md) — deeper MCP setup detail
- [docs/rule-pack-authoring.md](./rule-pack-authoring.md) — write your own rule packs
- [docs/backup-restore.md](./backup-restore.md) — recovery procedures
- [CHANGELOG.md](../CHANGELOG.md) — release notes
