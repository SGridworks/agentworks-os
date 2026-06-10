# Spec C2 — Workflow Event Bus + Scanner-Driven Compliance Loop

**Date:** 2026-06-09
**Status:** Design — pending review
**Target:** AgentWorks OS v0.3 line (`packages/agentos-d`, `packages/admin-ui`)
**Builds on:** Spec C1 (autonomous compliance loop) — reuses auto-resume, the simulated adapter, and the demo seed.

## Context

C1 made the compliance loop self-drive *once a run exists*: approve → dispatch → sealed evidence,
hands-off. But the **front of the loop is still manual** — a new AgentGuard scanner finding persists
to the DB and then sits there. Nothing evaluates it against policy or starts a run.

Exploration found the real blocker: **there is no event→workflow dispatcher at all.** Workflow
templates declare `trigger: "event"` (`scanner-finding-triage`, `failed-dispatch-recovery`,
`issue-stuck-escalator`, `provider-degradation-watch`, `approval-sla-watchdog`), but nothing ever
fires them — they are dead. The only way a run starts today is an explicit
`runNativeAutomationWorkflow(...)` call (admin API, or the demo seed).

So C2 builds the missing event bus and makes scanner findings its first producer, completing the loop
end-to-end: **a risky finding autonomously drives policy → approval → dispatch → evidence.** This
serves both roadmap drivers — it completes the loop *and* is the differentiated "scan-to-sealed-
evidence, hands-off" story.

## Decisions (locked)

1. **Event-triggered workflow, full loop.** A new finding fires an event that starts a compliance
   workflow run, tying into C1's auto-resume — not a bare policy-enqueue (which wouldn't dispatch or
   produce evidence).
2. **Generic event bus.** Build a reusable `fireWorkflowEvent(eventKind, data, tenantId)` that any
   producer can call; scanner findings are the first. This also revives the other dead event templates.
3. **Severity gate (default high+critical, configurable).** Only high-signal findings auto-trigger, to
   avoid flooding the approval queue.
4. **Include the admin-ui "Load demo" button** (F4 fast-follow) so an evaluator can populate a live
   loop in one click.

## Design

### Generic event dispatcher
New `packages/agentos-d/src/services/workflow-events.ts`:
```
fireWorkflowEvent(eventKind: string, data: Record<string, unknown>,
                  opts: { tenantId: string }, config: Config): Promise<{ triggered: string[] }>
```
- Selects active event-triggered workflows for the tenant matching the event kind:
  `SELECT id FROM native_automation_workflows
   WHERE status='active' AND trigger_kind='event' AND event_kind=? AND tenant_id=?`
- For each, calls `runNativeAutomationWorkflow(workflow.id, data, config)` (the existing run
  entrypoint; `data` flows in as the run `input`). Per-workflow errors are caught and logged
  (fail-loud, never throw out to the producer). Returns the triggered run/workflow ids.
- **Migration `0044_workflow_event_kind.ts`:** add a nullable `event_kind TEXT` column to
  `native_automation_workflows` (+ index on `(trigger_kind, event_kind, status)`); event-triggered
  workflows set it (e.g. `"scanner.finding"`). Manual/webhook workflows leave it null.

### Scanner producer
In `packages/agentos-d/src/routes/scanner.ts`, immediately after a NEW finding row is inserted
(~line 355, inside the dedup loop — existing findings are skipped, so only new findings fire), call
`fireWorkflowEvent("scanner.finding", { finding: {...} }, { tenantId }, config)` **iff** the finding
severity is in the configured trigger set. Fire-and-forget with `.catch(log)` so the scan-job response
is not blocked. Severity set from `AGENTOS_SCANNER_AUTOLOOP_SEVERITIES` (default `"high,critical"`);
below-threshold findings persist but don't auto-trigger.

### Scanner-driven template
New event-triggered template `scanner-compliance-loop` in `TEMPLATE_DEFINITIONS`: `trigger: "event"`,
`event_kind: "scanner.finding"`, steps `policy.check → approval.wait → dispatch → evidence.pack`. The
`policy.check` step maps the finding (from run input) to a proposed action (kind
`"scanner.finding.remediate"`, summary from the finding title). This is the event-driven sibling of
C1's manual `compliance-loop`; **leave `compliance-loop` unchanged** (the demo + C1 e2e depend on it).
Installing + activating `scanner-compliance-loop` is what arms the auto-loop for a tenant.

### Loop-safety
- Findings are deduped at insert (scanner.ts skips existing rows), so re-scans don't re-fire.
- `scanner.finding` events originate only from scanner inserts, never from a workflow step, so no
  self-retriggering. The dispatcher only runs `status='active'` workflows with a matching `event_kind`.

### F4 — admin-ui "Load demo" button
- `packages/admin-ui/src/lib/api.ts`: add `seedDemo()` → `POST /api/admin/demo/seed` (through the
  existing daemon-fetch proxy so the owner token is forwarded).
- `packages/admin-ui/src/components/empty-tenant-state.tsx`: add a "Load demo" button beside the
  create-tenant form; on success route to `/approvals` so the seeded pending approval is visible, and
  surface a hint to start the daemon with `AWOS_ADAPTER=simulated` for realistic dispatch output.

## Files

**New:** `services/workflow-events.ts` (+test), `db/migrations/0044_workflow_event_kind.ts`,
`scanner-compliance-loop` template (in `native-automations.ts`), `services/scanner-loop.e2e.test.ts`.
**Modify:** `routes/scanner.ts` (fire event, severity-gated), `services/native-automations.ts`
(template + persist `event_kind` on install), `db/migrations/index.ts` (wire 0044),
`admin-ui/src/lib/api.ts` + `admin-ui/src/components/empty-tenant-state.tsx`.

**Reuse:** `runNativeAutomationWorkflow` / `installNativeAutomationTemplate`
(`native-automations.ts:1810`), `logDecision` enqueue (`services/policy/decisionLog.ts:143`), the C1
loop-driver auto-resume, the simulated adapter, the daemon-fetch proxy + `requireLocalAdmin`.

## Verification

1. **Unit — dispatcher**: `fireWorkflowEvent` runs only active, matching-`event_kind`, same-tenant
   workflows; ignores inactive/non-matching/other-tenant; returns triggered ids; a throwing workflow is
   logged and does not abort the others.
2. **Integration — `scanner-loop.e2e.test.ts`**: install+activate `scanner-compliance-loop`, insert a
   `high` finding via the scanner path → assert a run is created and parks at `waiting_approval` with
   the finding as input; a `low` finding → NO run (severity gate); re-inserting the same finding (dedup)
   → no second run. Then approve → C1 loop drives to `succeeded` + sealed evidence pack.
3. **Tenant isolation**: a finding for tenant A does not trigger tenant B's event workflow.
4. **admin-ui**: `pnpm --filter @agentworks/admin-ui build` passes; the Load-demo button calls the seed
   endpoint through the proxy.
5. **Regression**: full `pnpm --filter @agentworks/agentos-d test` green (914 baseline + new);
   `tsc --noEmit` clean; release scanners (`public-release`, `product-surfaces`, `version`) green.

## Out of scope (future)

- Wiring the *other* event producers (failed-dispatch, issue-stuck, provider-degradation,
  approval-sla) into `fireWorkflowEvent` — the bus supports them, but each producer's emit-site is a
  separate follow-up.
- A UI for authoring/activating event workflows (operators activate via API/seed for now).
- Real LLM remediation adapters (the simulated adapter remains the default demo path).
