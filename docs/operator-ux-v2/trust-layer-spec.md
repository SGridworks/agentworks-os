# Trust Layer – design spec

## Goal
Surface real-time trust signals for every external dependency the substrate touches (LLM provider, scanner sidecar, vault store, rule-pack loader). The UI shows a compact topbar badge that is green when every provider reports healthy, yellow when any dependency degrades, red when any is down. Admins can open a tray to see per-provider status, last-seen timestamp, and a one-click “re-check” button. The backend polls each provider on a configurable cadence (default 30 s) and exposes the aggregated view at `GET /api/admin/trust`.

## Surfaces
1. Topbar badge (always visible while admin-ui is open)
2. Trust tray (slide-out panel triggered by badge click)
3. `GET /api/admin/trust` – JSON contract consumed by admin-ui
4. `POST /api/admin/trust/refresh` – on-demand re-poll (idempotent)

## Backend

### Provider inventory (hard-coded list v1)
- `openai` – OpenAI API (chat completions endpoint HEAD)
- `anthropic` – Anthropic API (messages endpoint HEAD)
- `scanner` – AgentGuard sidecar (`/health` on internal port 8001)
- `vault` – local FileVaultStore (stat `$VAULT_ROOT/.aw-ok`)
- `rules` – rule-pack loader (verify every pack dir has valid `manifest.yaml`)

### Poll cadence
- Default 30 s, override via `TRUST_POLL_SEC` env var
- Jitter ±10 % to avoid thundering herd after restart
- Failed polls back-off 2× up to 5 min, reset on success

### Aggregate rules
- `status: "healthy"` – every provider last poll == 200/OK
- `status: "degraded"` – ≥1 provider non-critical failure (4xx, timeout ≤10 s)
- `status: "down"` – ≥1 provider critical failure (5xx, timeout >10 s, unreachable)
- `lastUpdated` – ISO-8601 timestamp of most recent finished poll round

### JSON contract – `GET /api/admin/trust`
```json
{
  "status": "healthy | degraded | down",
  "lastUpdated": "2026-05-20T17:04:33Z",
  "providers": [
    {
      "id": "openai",
      "displayName": "OpenAI",
      "category": "llm",
      "status": "healthy",
      "lastSeen": "2026-05-20T17:04:31Z",
      "latencyMs": 123,
      "error": null
    },
    {
      "id": "scanner",
      "displayName": "AgentGuard Scanner",
      "category": "sidecar",
      "status": "degraded",
      "lastSeen": "2026-05-20T17:03:58Z",
      "latencyMs": 5020,
      "error": "timeout after 5 s"
    }
  ]
}
```

### Idempotent refresh – `POST /api/admin/trust/refresh`
- Returns same shape as GET
- Triggers immediate poll round, waits for completion, then responds
- No-op if another poll is already running (returns current data)

## Frontend

### Topbar badge component
- Icon: shield-check (healthy), shield-alert (degraded), shield-xmark (down)
- Color: green-500, yellow-500, red-500 (Tailwind)
- Badge shows dot only; no text to conserve space
- Hover tooltip: “Trust status: healthy” (or degraded/down)
- Click opens trust tray (slide-out from right, 320 px wide)

### Trust tray contents
- Header: “Trust Layer” + close (×) button
- List of providers (same order as backend JSON)
- Each row: provider displayName, status pill (colored), lastSeen relative time (“30 s ago”), latency badge (“123 ms”), refresh spinner while polling
- Footer: “Last updated: <absolute timestamp>” + “Re-check now” button (triggers POST refresh, disables while in-flight)
- Auto-refreshes every poll cadence via SWR `refreshInterval` set to value returned in `Cache-Control: max-age=<trust-poll-sec>` header

### State management
- SWR key: `/api/admin/trust`
- Mutate key after manual refresh or when WebSocket push arrives (v1.1)
- Tray mounts/unmounts → no persistent state beyond SWR cache

## Out of scope
- WebSocket push of status changes (v1.1)
- Provider config UI (add/remove/edit endpoints) – static list for v1
- PagerDuty/Slack alerting on state changes – pilot uses UI only
- Historical metrics or uptime graphs – v1.1
- Non-admin visibility – trust layer is admin-only

## Open questions
1. Do we need a “maintenance mode” flag that forces status to degraded regardless of polls?
2. Should latencyMs be median of last N polls instead of latest?
3. Do we expose raw error message to UI or sanitize (leak risk)?
   → Decision: sanitize; show generic message, log full error server-side
4. Vault health check on Windows with locked files – alternate signal?
5. Rule-pack loader health – rescan on every poll or watch fs?
   → Decision: rescan on poll; fs-watch adds complexity for v1
