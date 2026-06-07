# Autopilot With Guardrails – Design Spec

**Project:** F7 · Autopilot With Guardrails  
**Wave:** 3  
**Author:** CEO  
**Status:** Draft → Review → Locked  
**File:** `docs/operator-ux-v2/autopilot-spec.md`

## Goal

Give regulated-SMB operators a single “Autopilot” toggle that lets the substrate automatically execute low-risk agent actions while keeping humans in the loop for anything that could create compliance exposure.  
The feature surfaces three buckets—`safe`, `needsApproval`, `risky`—and a deterministic `riskScore` (0..1) plus machine-readable `reasons[]` so the admin UI can render concise explanations and bulk-dispatch controls.

## Surfaces (user-visible)

1. **Admin UI / Settings / Autopilot**
   - Toggle: “Enable Autopilot” (tenant-scoped, default OFF)
   - Read-only summary card when ON:
     - Last 30 days: N actions auto-executed, M routed for approval
     - Highest risk score seen: 0.73 (example)
   - No per-rule-pack knobs in v1; one global toggle only.

2. **Approval Queue (existing page)**
   - New chip filter: “Autopilot routed” vs “Manual review”
   - Batch actions: “Approve all safe”, “Reject all risky”
   - Column addition: “Risk score” + hover tooltip showing `reasons[]`

3. **Activity Log (existing page)**
   - New column: “Autopilot decision” (safe | needsApproval | risky)
   - Click-through to see full `riskScore` & `reasons[]`

## Backend (substrate changes)

### 1. Bucketing rules (deterministic, order matters)

```yaml
# pseudocode – lives in policy-engine, not YAML
if any rule-pack returns BLOCK:
    bucket = risky
    riskScore = max(0.7, 0.9 if PII-leak OR fair-housing-violation else 0.8)
    reasons += rule.reasons
elif any rule-pack returns ROUTE_TO_REVIEW:
    bucket = needsApproval
    riskScore = max(0.4, 0.6 if TCPA-violation else 0.5)
    reasons += rule.reasons
elif tenant.autopilotEnabled and all packs return ALLOW:
    bucket = safe
    riskScore = 0.0
    reasons = ["within policy"]
else
    bucket = needsApproval   # human must decide
    riskScore = 0.3
    reasons = ["autopilot disabled or mixed signals"]
```

Hard constants are version-locked; no ML in v1.

### 2. Risk-score formula (0..1 continuous)

```
riskScore = clamp(0, 1, base + Σ pack_contribution)
base = 0.0 if all ALLOW else 0.3
pack_contribution:
  BLOCK   → +0.6 (fair-housing) | +0.5 (PII-leak) | +0.4 (other)
  ROUTE   → +0.2 (TCPA) | +0.1 (other)
```

Rounding: two decimals stored, two decimals surfaced.

### 3. Reasons vocabulary (machine-readable, never user-facing raw)

| reason code | human template (en) |
|-------------|---------------------|
| `fair-housing-discrimination` | Fair Housing: discriminatory language detected |
| `tcpa-no-consent` | TCPA: missing documented consent |
| `pii-leak-ssn` | PII: Social Security number exposure |
| `within-policy` | Within allowed policy |
| `autopilot-off` | Autopilot disabled by administrator |

Admin UI maps code → template at render time; no i18n in v1.

### 4. Bulk-dispatch contract (HTTP POST)

**Endpoint:** `POST /api/tenants/:id/autopilot/dispatch`  
**Auth:** same JWT as policy check  
**Body:**

```json
{
  "actionIds": ["uuid", ...],
  "decision": "approve|reject"   // applies only to needsApproval bucket
}
```

**Response:**

```json
{
  "processed": 15,
  "skipped": 2,   // already decided or bucket=safe/risky
  "errors": []
}
```

Idempotent: duplicate calls return same counts.

### 5. DB schema additions (forward-only migration)

```sql
ALTER TABLE action_log ADD COLUMN autopilot_bucket   text;   -- safe|needsApproval|risky
ALTER TABLE action_log ADD COLUMN risk_score         numeric(3,2);
ALTER TABLE action_log ADD COLUMN reasons            text[]; -- array of reason codes
ALTER TABLE tenants    ADD COLUMN autopilot_enabled  boolean default false;
```

## Frontend (admin-ui)

- No new pages; reuse existing Approval & Activity pages.
- Chips and tooltips use the mapping table above.
- Batch toolbar disabled until ≥1 needsApproval row selected.
- Toggle switch hits `PATCH /api/tenants/:id` `{autopilotEnabled: boolean}`.

## Out of scope (v2)

- Rollback / undo of auto-executed actions
- Per-rule-pack autopilot knobs
- ML-based risk-score tuning
- Email digest of autopilot activity
- Time-based autopilot schedules

## Open questions

1. Do we cap the number of safe actions a single agent can trigger per hour? (CEO: defer to v1.1)
2. Do we expose the raw numeric constants to tenants? (CEO: no, keep opaque)
3. Do we allow attorneys to add custom reason codes? (CEO: no, locked enum)

## Milestone linkage

- Blocked by: F4 policy-engine severity aggregation (must land first)
- Blocks: F8 bulk-approval UI polish
- Ship criterion: substrate E2E test `autopilot-bucket-flow.test.ts` passes

## Revision history

| date | author | change |
|------|--------|--------|
| 2026-05-19 | CEO | initial spec |
