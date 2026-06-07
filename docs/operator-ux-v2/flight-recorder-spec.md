# Flight Recorder UX Specification

## Goal
Provide operators with a chronological timeline of every agent action, policy evaluation, and system event that occurred during a flight (agent run). The recorder surfaces the "why" behind every decision and maintains an immutable audit trail for compliance review.

## Surfaces

### 1. Flight Timeline View (Admin UI)
- **Route**: `/flights/{flightId}/timeline`
- **Layout**: Vertical, newest-first scroll with auto-scroll during live flights
- **Event cards**:
  - **Action Proposed**: agent name, action summary, timestamp, expandable payload
  - **Policy Evaluated**: rule pack(s), verdict (allow/block/route_to_review), severity, expandable evidence
  - **Human Review**: reviewer identity, decision, rationale, timestamp
  - **Action Executed**: final action taken, outcome status
  - **System Events**: daemon restarts, rule pack reloads, scanner errors

### 2. "Why?" Popover Contract
Every policy verdict card exposes a "Why?" button that opens a popover containing:
- Matched rule name and ID
- Triggering condition (human-readable)
- Evidence snippets from action envelope (payload + context.meta)
- Severity justification
- Link to full rule pack documentation

### 3. Chronological Merge Order
Events appear in strict timestamp order (RFC 3339 nanosecond precision). When multiple events share identical timestamps:
1. Action Proposed
2. Policy Evaluated  
3. Human Review
4. Action Executed
5. System Events

## Backend

### file_access_log Table Schema
```sql
CREATE TABLE file_access_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  flight_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type VARCHAR(50) NOT NULL, -- 'action_proposed', 'policy_evaluated', 'human_review', 'action_executed', 'system'
  event_subtype VARCHAR(50), -- 'allow', 'block', 'route_to_review', 'daemon_restart', etc.
  severity VARCHAR(20), -- 'critical', 'high', 'medium', 'low', 'info'
  actor VARCHAR(100), -- agent name, reviewer email, 'system'
  action_envelope JSONB, -- full RFC 001 ActionEnvelope when relevant
  policy_verdict JSONB, -- {rule_pack, rule_id, verdict, evidence}
  human_review JSONB, -- {reviewer_id, decision, rationale}
  outcome VARCHAR(50), -- 'success', 'failure', 'timeout', 'blocked'
  metadata JSONB, -- arbitrary additional context
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_file_access_log_tenant_flight ON file_access_log(tenant_id, flight_id);
CREATE INDEX idx_file_access_log_timestamp ON file_access_log(tenant_id, timestamp DESC);
```

### API Endpoints
- `GET /api/flights/{flightId}/timeline`
  - Returns chronologically ordered events for the flight
  - Supports `?limit=` and `?after=` pagination
  - Enforces tenant isolation

- `GET /api/flights/{flightId}/timeline/{eventId}/why`
  - Returns structured rationale for policy verdicts
  - Includes matched rule, evidence, severity justification

## Frontend

### Timeline Component Architecture
- **Virtual scrolling** for flights with >1000 events
- **Live updates** via Server-Sent Events during active flights
- **Event filtering** by type, severity, actor
- **Export** to CSV/JSON for compliance audit
- **Keyboard navigation** (up/down arrows, expand/collapse)

### State Management
- Timeline state stored in URL params for shareability
- Client-side cache with 5-minute TTL
- Optimistic updates for human review actions

## Out of Scope
- State-snapshot replay (deferred to v2)
- Real-time collaboration on reviews
- Advanced search across flights
- Performance analytics beyond basic counts
- Mobile-responsive timeline (desktop-first for v1)

## Open Questions
1. Should we truncate very large action envelopes in the UI by default?
2. Do we need a separate index for full-text search across event metadata?
3. How long should completed flight timelines be retained?
4. Should system events be collapsible by default to reduce noise?
