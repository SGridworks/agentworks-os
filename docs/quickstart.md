# Quickstart Guide

**Goal:** Get a fresh AgentWorks OS installation running in under 20 minutes and see a policy decision in the admin UI.

**Audience:** Developer or IT generalist. No prior AgentWorks OS experience required.

---

## Prerequisites

- macOS or Linux machine you control
- Docker Desktop (macOS) or Docker Engine (Linux), installed and running
- At least one agent to connect (Claude Desktop, Cursor, or Codex)

Check Docker:

```bash
docker --version   # should print a version
docker ps          # should run without error
```

---

## Step 1 — Install (one command)

```bash
curl -fsSL https://github.com/SGridworks/agentworks-os/releases/download/v0.1.4/install.sh | bash
```

The script creates `~/.agentworks/` with the Docker Compose configuration, starts all services, generates a tenant ID, and prints your admin password. Save the password.

Expected output (abbreviated):

```
AgentWorks OS installer
✓ Docker found
✓ Pulling images...
✓ Generating tenant ID: ...
✓ Starting services...
✓ Admin UI: http://localhost:7710
✓ Admin password: Aw-XXXXXXXXXXXX
```

If the script completes without error, the stack is running.

---

## Step 2 — Open the Admin UI

```
http://localhost:7710
```

Log in with:
- Username: `admin`
- Password: the password from Step 1

The onboarding wizard opens on first launch. You can walk through it or skip to Settings to fill it in later.

---

## Step 3 — Verify Services

In a terminal:

```bash
docker compose -f ~/.agentworks/docker-compose.yml ps
```

Expected:

| Service | Status | Port |
|---|---|---|
| `agentos-d` | Up | 7710 |
| `scanner-worker` | Up | 3101 |
| `n8n` | Up | 5678 |

`postgres` shows `Exit` — this is normal in v1.

---

## Step 4 — Test a Policy Decision

Find your tenant ID in the admin UI: **Settings → Tenant Info**.

Submit a test action via the REST API:

```bash
curl -X POST http://localhost:7710/api/actions \
  -H "Content-Type: application/json" \
  -d '{
    "actionKind": "outbound.sms",
    "actor": { "label": "quickstart-test" },
    "target": { "to": "5550001234", "body": "test" },
    "context": { "tenantId": "YOUR_TENANT_ID" }
  }'
```

The JSON response includes a `decision` field: `allow`, `block`, or `route_to_review`.

View the decision in the admin UI: **Activity → Recent Actions**. You should see a row for this test action.

---

## Step 5 — Connect Claude Desktop

Open `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `~/.config/Claude/claude_desktop_config.json` (Linux) and add:

```json
{
  "mcpServers": {
    "agentworks": {
      "url": "http://localhost:7710"
    }
  }
}
```

Restart Claude Desktop. In a new conversation:

```
/memory read
```

If connected, Claude will return vault content (empty on a fresh install — this is normal).

---

## Step 6 — Verify the Scanner

```bash
curl -X POST http://localhost:7710/api/scanner/submit \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "YOUR_TENANT_ID",
    "pasteContent": "# Test CLAUDE.md\n# No risky patterns here",
    "policyMode": "shadow"
  }'
```

Poll for results (replace `SCAN_ID`):

```bash
curl "http://localhost:7710/api/scanner/jobs/SCAN_ID?tenantId=YOUR_TENANT_ID"
```

A clean first scan shows zero findings.

---

## What's Next

| Task | Doc |
|---|---|
| Day-to-day operation, approval queue, vault | [User's Guide](./users-guide.md) |
| Bring existing vault or agent configs | [Migration Guide](./migration-guide.md) |
| Install for a new team from scratch | [Install Runbook](./install-runbook.md) |
| Write your own compliance rule packs | [Rule Pack Authoring](./rule-pack-authoring.md) |
| Operational patterns, vault hygiene, evidence | [Best Practices](./best-practices.md) |

---

*If a step fails, check `docker compose -f ~/.agentworks/docker-compose.yml logs` and confirm the relevant port isn't blocked by a firewall. For help, see [Support Bundle](./support-bundle.md).*
