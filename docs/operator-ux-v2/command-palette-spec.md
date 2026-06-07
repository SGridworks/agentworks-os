# Command Palette UX Specification

## Goal
Deliver a keyboard-driven command palette that lets operators invoke any substrate action without leaving the keyboard. The palette surfaces tenant-scoped actions, pre-fills context from the current view, and returns an RFC 001 ActionEnvelope ready for policy evaluation.

## Surfaces

### Modal UX
- **Trigger**: `Cmd+K` (macOS) / `Ctrl+K` (Linux/Win) from any admin-ui page.
- **Appearance**: Centered overlay, 600 px wide, 80 % viewport height, glassmorphic background (`bg-slate-900/70`).
- **Search box**: Auto-focused input, placeholder “Type a command or search…”, clears on `Escape`.
- **Results list**: Max 7 visible items, virtual-scroll if registry > 7. Each row shows:
  - Icon (20×20 px, monochrome)
  - Verb label (sentence-case)
  - Keyboard shortcut right-aligned (if bound)
  - One-line description (color `text-slate-400`, 14 px)
- **Selection**: Arrow keys move highlight; `Enter` executes; `Escape` closes without action.
- **Empty state**: “No commands match ‘foo’” with a “See all” link that clears the filter.

### Context pre-fill
When the palette opens we capture:
- `tenantId` from route param
- `page` token (`dashboard`, `approvals`, `vault`, `logs`)
- Any selected entity id(s) from the view (multi-select supported)

These values populate `context.meta` in the outgoing ActionEnvelope so rules can branch on UI state.

## Backend

### Action-registry shape (YAML, tenant-scoped)
```yaml
# /api/tenants/:id/actions registry entry
id: approve-selected-approvals
scope: tenant
verb: Approve selected
icon: check-circle
description: Approve all currently selected items in the queue
context:
  page: approvals
  requiresSelection: true
  minSelection: 1
parameters:
  - name: reason
    type: string
    required: false
    default: "Approved via palette"
route: /api/tenants/{tenantId}/approvals/bulk-approve
method: POST
```

Fields:
- `id` – unique within tenant, kebab-case
- `scope` – `tenant` (v1 only)
- `verb` – human label shown in palette
- `icon` – lucide name or custom svg id
- `description` – one-line help
- `context` – filters when the action is eligible
  - `page` – optional whitelist; omit = always eligible
  - `requiresSelection` – bool
  - `minSelection` – int, default 0
- `parameters` – ordered list; supports `string`, `number`, `boolean`, `enum`
- `route` – absolute path, may contain `{tenantId}` or `{selection}` tokens
- `method` – HTTP verb

### API endpoints
- `GET /api/tenants/:tenantId/actions`
  - Returns array of registry entries filtered by current page & selection state
  - 200: `{ actions: ActionRegistryEntry[] }`
- `POST /api/tenants/:tenantId/actions/invoke`
  - Body: `{ actionId, parameters, context }`
  - Returns RFC 001 ActionEnvelope (same shape scanner uses)
  - 200: `{ envelope: ActionEnvelope }`
  - 400: unknown action or missing param
  - 403: policy engine blocks (payload contains block reason)

### Persistence
Registry lives in SQLite table `tenant_actions`:
```sql
id TEXT PRIMARY KEY,
tenant_id TEXT NOT NULL,
scope TEXT NOT NULL,
verb TEXT NOT NULL,
icon TEXT,
description TEXT,
context_json TEXT,
parameters_json TEXT,
route TEXT NOT NULL,
method TEXT NOT NULL,
created_at TEXT DEFAULT CURRENT_TIMESTAMP
```

Seed rows are inserted per tenant on provisioning; operators may add rows via future UI (v1.1).

## Frontend

### React implementation sketch
- `<CommandPalette>` portal mounted in `_app.tsx`
- `useKeyboardShortcut(['cmd+k', 'ctrl+k'], open)`
- `useQuery(['actions', tenantId, page, selection], fetchActions)`
- Keyboard navigation with `useRef` list, `onKeyDown` handler
- `execute()` calls `POST /actions/invoke`, receives envelope, then:
  - If `allow` → POST to envelope.route with parameters
  - If `block` → toast error with reason
  - If `route_to_review` → navigate to `/approvals/new?envelope=...`

### Styling tokens (Tailwind)
- Overlay: `fixed inset-0 z-50 flex items-center justify-center`
- Modal: `w-[600px] h-4/5 rounded-xl bg-slate-900/70 backdrop-blur border border-slate-700`
- Search input: `w-full px-4 py-3 bg-slate-800 text-slate-100 placeholder-slate-400 border-0 focus:ring-0`
- Row hover: `bg-slate-800/60`
- Highlight: `bg-slate-700/80`

## Out of scope
- Global (cross-tenant) actions
- Custom operator-defined actions via UI (v1.1)
- Keyboard shortcut editor (v1.1)
- Voice invocation
- Mobile gesture trigger

## Open questions
1. Do we ship a default icon set or require every registry entry to supply an icon?
2. Should we support nested/grouped verbs (e.g., “Vault > Rotate keys”) in v1?
3. Do we stream partial parameter forms inside the palette (wizard style) or always open a secondary modal?

## v1 verb list (seed data)
| ID | Verb | Page | Description |
|----|------|------|-------------|
| approve-selected-approvals | Approve selected | approvals | Approve all selected approvals |
| deny-selected-approvals | Deny selected | approvals | Deny all selected approvals |
| export-approvals-csv | Export CSV | approvals | Download approvals as CSV |
| rotate-vault-key | Rotate vault key | vault | Rotate tenant master key |
| purge-vault-entries | Purge old entries | vault | Delete entries older than 90 days |
| reprocess-failed-scans | Re-process failed | logs | Retry policy evaluation for failed scans |
| toggle-maintenance-mode | Toggle maintenance | dashboard | Enable/disable maintenance mode |
| invite-operator | Invite operator | dashboard | Send invite to new operator |
| view-audit-log | View audit log | dashboard | Open full audit log |
| generate-compliance-report | Generate report | dashboard | Create compliance evidence report |
