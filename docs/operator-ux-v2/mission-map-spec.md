# Mission Map – design spec

## Goal
Give operators a single, zoom-able graph that shows how work actually flows inside AgentWorks: companies → projects → issues → agents → runs → evidence/memory. Every node is clickable; every edge tells you why it exists. The map is generated from the live database—no manual layout, no static files.

## Surfaces

### 1. Graph canvas (admin-ui)
- Full-screen route `/mission-map` mounted in the Next.js app.
- React-Flow canvas with mini-map, zoom-to-fit, and search box (filters on title or id).
- Node kinds rendered as fixed-size shapes with brand palette (see Color rules).
- Edges are simple bezier lines with labels on hover.
- Clicking a node opens a slide-over panel that lists the drill-down targets (see Drill-down targets).

### 2. API endpoint (agentos-d)
`GET /api/mission-map/graph`

Returns
```json
{
  "nodes": [
    {
      "id": "<pk>",
      "kind": "company|project|issue|agent|run|evidence|memory",
      "title": "human label",
      "status": "active|done|failed|paused",
      "createdAt": "ISO",
      "drillDown": ["url", ...]
    }
  ],
  "edges": [
    {
      "id": "<uuid>",
      "source": "<node.id>",
      "target": "<node.id>",
      "kind": "owns|blocks|runs|produces|references",
      "label": "short verb"
    }
  ]
}
```

No pagination—graph is limited to 5 000 nodes; beyond that return 409 + message “Scope filter required”.

## Backend

### Node kinds & SQL provenance
| kind     | primary table         | title column               | status column |
|----------|-----------------------|----------------------------|---------------|
| company  | companies             | name                       | active        |
| project  | projects              | name                       | status        |
| issue    | issues                | title                      | status        |
| agent    | agents                | name                       | status        |
| run      | runs                  | ‘Run #’ || id              | status        |
| evidence | policy_violations     | rule_name + ‘ violation’   | severity      |
| memory   | vault_pages           | page_title                 | —             |

### Edge kinds & generation rule
- **owns** – parent → child FK: company → projects, project → issues, issue → runs.
- **blocks** – issue ← → issue via issue_dependencies.
- **runs** – agent → run (runs.agent_id).
- **produces** – run → evidence (policy_violations.run_id).
- **references** – vault_pages.issue_id → issue (bidirectional).

All edges are directed. Cycles (blocks) are rendered but highlighted in red.

### Color rules (hex)
- company  #0F172A  (slate-900)
- project  #1E293B  (slate-800)
- issue    #3B82F6  (blue-500)  if status=todo/in_progress, #10B981 (emerald-500) if done
- agent    #F59E0B  (amber-500)
- run      #8B5CF6  (violet-500) if running, #EF4444 (red-500) if failed, #6B7280 (gray-500) if done
- evidence #DC2626  (red-600)
- memory   #14B8A6  (teal-500)

Status color override wins over kind color.

### Performance guard-rails
- Hard LIMIT 5 000 nodes per response.
- Query window: only entities touched in last 90 days unless query param `?all=1`.
- Materialized view `mission_map_nodes` refreshed every 5 min by daemon cron.
- Edge selection uses indexed FK columns only—no joins heavier than two tables.

## Frontend

React-Flow v11 with TypeScript. Components live in `packages/admin-ui/components/mission-map/`:
- `GraphPage.tsx` – route container, fetches `/api/mission-map/graph`.
- `nodeTypes.ts` – maps node.kind to React component (shape + color).
- `edgeTypes.ts` – maps edge.kind to label and stroke style.
- `DrillDownPanel.tsx` – slide-over that renders `drillDown` urls as list of links.

No external graph layout engines—React-Flow’s built-in force layout is sufficient for <5k nodes.

## Drill-down targets
Each node exposes an array of absolute urls the operator can jump to:
- company – `/admin/companies/{id}`, `/admin/companies/{id}/billing`
- project – `/admin/projects/{id}`, `/admin/projects/{id}/issues`
- issue – `/admin/issues/{id}`, `/admin/issues/{id}/timeline`
- agent – `/admin/agents/{id}`, `/admin/agents/{id}/runs`
- run – `/admin/runs/{id}`, `/admin/runs/{id}/log`
- evidence – `/admin/violations/{id}`, `/admin/runs/{runId}/log`
- memory – `/admin/vault/{tenantId}/{pageId}`

The list is included in the JSON so the UI is free of hard-coded routes.

## Out of scope
- Real-time updates (websocket) – refresh button only.
- Filtering by date, agent, or status – v1.1.
- Saving or sharing custom layouts.
- 3-D or WebGL rendering.
- Editing nodes or edges.

## Open questions
1. Do we add a “collapse” feature to hide done projects? (wait for user feedback)
2. Should memory nodes show a snippet of text on hover? (may leak PII—needs redaction)
3. Multi-tenant view: one graph per company or one global graph with tenant filter? (start with per-company, add global later)
