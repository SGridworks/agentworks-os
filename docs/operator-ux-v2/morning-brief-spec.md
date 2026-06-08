# Morning Brief – Design Spec

## Goal
Give the operator a 30-second scan of everything that needs their eyes before coffee: overnight agent activity, policy hits, approval queue depth, vault anomalies, and any substrate health issues. One card, zero clicks required, dismissible until next sunrise.

## Surfaces
- **Card placement**: top of the admin-ui dashboard, full-width, pinned above the fold.
- **Trigger**: daily at 06:00 tenant-local time, or on first dashboard load after 06:00 if the daemon was offline.
- **Dismissal**: “Got it” button stores a per-tenant `dismissed_at` timestamp in `tenant_preferences`; card stays hidden until the next calendar day after 06:00.
- **Re-surface**: manual “Show morning brief” link in the account menu (respects same day-boundary).

## Backend

### 1. Data collation (daemon, `/api/morning-brief`)
```ts
GET /api/tenants/:id/morning-brief
Returns 200
{
  "generated_at": "2026-05-20T06:00:00Z",
  "period": {
    "from": "2026-05-19T18:00:00Z",  // 12 h look-back, configurable
    "to":   "2026-05-20T06:00:00Z"
  },
  "summary": {
    "agents_active": 7,              // unique agents that proposed ≥1 action
    "actions_proposed": 124,
    "actions_allowed": 119,
    "actions_blocked": 3,
    "actions_routed": 2,             // pending human review
    "vault_writes": 18,
    "vault_anomalies": 1             // writes that tripped integrity checksum
  },
  "approval_queue": {
    "depth": 2,                      // still pending right now
    "oldest_human_age_hours": 4.2
  },
  "health": {
    "scanner_worker_ok": true,
    "policy_engine_ok": true,
    "vault_ok": true,
    "alerts": ["Scanner-worker high memory usage 94 %"]
  },
  "recommendations": [               // max 3, ordered by severity
    {
      "id": "approve_oldest",
      "priority": "high",
      "message": "Oldest human review is 4 h old — approve or escalate?",
      "action_url": "/approvals?sort=age"
    },
    {
      "id": "inspect_anomaly",
      "priority": "medium",
      "message": "One vault anomaly detected — inspect hash mismatch.",
      "action_url": "/vault/events?anomaly=true"
    }
  ]
}
```

### 2. Generation heuristic
- Run as a scheduled cron inside `agentos-d` (06:00 per tenant TZ).
- Cache result in SQLite table `morning_brief` (`tenant_id`, `generated_at`, `json_blob`) with 24 h TTL so dashboard can poll idempotently.
- If daemon was offline at 06:00, generate on first dashboard hit after 06:00 and cache immediately.

### 3. Recommendation engine (lo-fi)
```
IF approval_queue.depth > 0 AND oldest_human_age_hours > 3 → recommend "approve_oldest" high
IF vault_anomalies > 0 → recommend "inspect_anomaly" medium
IF health.alerts length > 0 → recommend "check_system_health" low
ELSE → no recommendation
```
Future iterations can plug in a proper ruleset; for v1 we hard-code the three cases above.

## Frontend

### Card layout (Next.js server component)
- **Header row**: icon + "Morning Brief – 20 May 06:00" + “Got it” button (primary sm).
- **Three columns** (responsive stacks on mobile):
  1. **Activity** (pie mini-chart + counts: proposed / allowed / blocked / routed).
  2. **Queue** (big number + subtitle: "2 pending approvals, oldest 4 h").
  3. **Health** (green / amber / red badge + first alert line).
- **Recommendations** (below columns): outlined cards with priority badge and link button.

### Accessibility
- aria-live="polite" on the whole card so screen readers announce it once on load.
- Keyboard-focus trap avoided — “Got it” is reachable with one Tab.

### Styling tokens
Use existing Tailwind set: bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100.

## Out of scope
- Real-time push (websocket or SSE) – dashboard polls on mount.
- Customizable briefing time or look-back window – fixed 06:00 / 12 h.
- Email or Slack delivery – UI surface only.
- Click-through analytics – no tracking beyond existing route logs.
- Multi-language copy – English only for v1.

## Open questions
1. Do we surface agent *names* in summary or keep it aggregate? (Privacy vs utility)
2. Should we cap the recommendation list to 2 on mobile to avoid scroll? (To be usability-tested with pilot)
3. Do we need a separate permission `morning_brief:read` or reuse `dashboard:read`? (ComplianceConsultant input required)

## API contract touches (for issue tracking)
- New route: `GET /api/tenants/:id/morning-brief`
- New DB table: `morning_brief`
- New UI component: `packages/admin-ui/src/components/MorningBriefCard.tsx`
- New preference key: `tenant_preferences.dismissed_morning_brief_at`
