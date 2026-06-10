# Spec C1 — Autonomous Compliance Loop (seeded & demoable)

**Date:** 2026-06-09
**Status:** Design — pending review
**Target:** AgentWorks OS v0.3 line (`packages/agentos-d`)

## Context

AWOS has broad, mostly-wired surface (~20 admin-ui pages render real daemon data), but the
*automated* compliance loop has three broken joins, and a fresh install shows lifeless dashboards
until a 20-minute setup. The intended loop is:

```
agent action → AgentGuard scan → policy evaluation → human approval → dispatch → sealed evidence pack
```

Confirmed gaps (file:line):
- **Approval → dispatch** is a dead-end: a workflow parked on `approval.wait` never resumes — nothing
  watches `approval_queue` review to continue the run (`native-automations.ts:2643`,
  `approval-queue.ts:205-282`).
- **Dispatch → evidence**: a completed dispatch doesn't resume the waiting run
  (`dispatch-consumer.ts:315-330`, no lookup of `waiting_for_dispatch_id`).
- **No end-to-end template**: no bundled workflow composes scan→policy→approval→dispatch→evidence.
- **No demo seed**: fresh install starts empty; nothing to approve, nothing to watch.

This spec closes those joins and makes the loop **demonstrable out of the box in ~30 seconds**, which
is simultaneously the "complete the core loop" and "open-source differentiation" goal: *approve once,
and the whole cryptographically-sealed compliance trail completes itself.*

## Goals / non-goals

**Goals:** (F1) approval/dispatch auto-resume the parked run; (F3) an opt-in simulated adapter so the
loop produces realistic, clearly-labeled output with no external credentials; (F4) an owner-only demo
seed; (F5) a golden-path template + e2e test proving the full chain.

**Non-goals (this spec):** admin-ui "Load demo" button (fast-follow), scanner→policy auto-evaluation
(F2, next spec), real LLM adapters, multi-tenant auth changes (covered by Spec B).

## Decisions (locked)

1. **Simulated adapter is opt-in** via `AWOS_ADAPTER=simulated`. The no-op `stubAdapter` remains the
   default; quickstart/demo docs instruct enabling simulated. Default behavior is unchanged.
2. **Demo seed ships as `POST /api/admin/demo/seed` + an `agentos seed-demo` CLI** only. No admin-ui
   work in this spec.

## Design

### F1 — Auto-resume (the spine)
New service `packages/agentos-d/src/services/loop-driver.ts`, notified at both seams, plus a reconciler:
- `onApprovalResolved(approvalId)`: looks up `native_automation_runs WHERE waiting_for_approval_id=?
  AND status='waiting_approval'` → `resumeNativeAutomationRun(run.id, {decision, reviewedBy,
  reviewNote})`. Resume advances to the `dispatch` step, which enqueues and returns quickly (does not
  block the HTTP response). Called from the review handler at `approval-queue.ts:281` **after** the DB
  update + WebSocket broadcast.
- `onDispatchResolved(dispatchId, outcome)`: looks up `native_automation_runs WHERE
  waiting_for_dispatch_id=? AND status='waiting_dispatch'` → `resumeNativeAutomationRun(run.id,
  {dispatchStatus})`. Called from `dispatch-consumer.ts` after `markCompleted`/`markFailed`.
- `reconcileWaitingRuns()`: a cron-registered sweep that resumes any waiting run whose linked
  approval/dispatch already resolved — closes the "lost wakeup after a restart" gap and makes the loop
  self-healing. Logs counts of resumed/failed (fail-loud).
- **Safety:** `resumeNativeAutomationRun` already performs an atomic status claim (added in the Spec-B
  fix work), so duplicate triggers from the inline hook + the reconciler are no-ops. Resume failures
  mark the run `failed` with a `terminal_reason` and surface on the existing `/active-work` page.
- **Migration `0043_loop_indexes.ts`:** indexes on `native_automation_runs(waiting_for_approval_id,
  status)` and `(waiting_for_dispatch_id, status)` for scan-free lookups.

Reuses: `resumeNativeAutomationRun` (`native-automations.ts:2175`), the cron registration pattern from
`evidence-report-cron.ts`.

### F3 — Simulated adapter (opt-in)
New `packages/agentos-d/src/adapters/simulated-adapter.ts` implementing the dispatch-consumer
`AgentAdapter` interface (`run(input): Promise<AdapterOutcome>`, `dispatch-consumer.ts:54-57`). It
returns **deterministic, role-aware, clearly-labeled** output:
- review role → a verdict + a couple of synthetic findings; engineer → a short diff/summary; default →
  a plausible completion note.
- Every outcome carries `simulated: true`, propagated into the dispatch result summary and the evidence
  pack, so simulated output is never mistaken for real agent work (fail-loud / surface uncertainty).
- Determinism: output varies by a hash of the input (agent id + task), no RNG — keeps the e2e test
  stable.
- Selection: extend `buildAdapter` in `cli.ts:28-48` so `AWOS_ADAPTER=simulated` returns the new
  adapter; `stub`/unset → existing no-op (unchanged default); `router`/`kimi` → real adapters.

### F4 — Demo seed (endpoint + CLI)
New `packages/agentos-d/src/routes/admin/demo-seed.ts`: `POST /api/admin/demo/seed`, owner-only (reuses
Spec-B `requireScope("admin")` / `requireLocalAdmin`). It creates, idempotently and flagged as demo:
- a synthetic demo tenant (neutral name, public-safe) via the onboarding init path
  (`onboarding.ts:179`),
- two agents (review, engineer roles),
- a few sample issues + scanner findings,
- the `compliance-loop` workflow (F5) plus a **run executed up to `waiting_approval`** (call
  `runNativeAutomationWorkflow` — it parks at `approval.wait`).
Result: the operator opens `/approvals`, sees a pending item, approves once, and — with
`AWOS_ADAPTER=simulated` — watches F1 drive dispatch → sealed evidence pack. Re-running the seed is
idempotent (skip/replace); the demo tenant is flagged for easy deletion. The `agentos seed-demo` CLI
calls the same service and prints the "start with AWOS_ADAPTER=simulated" hint and the approvals URL.

### F5 — Golden-path template + e2e test
- New `compliance-loop` template in `TEMPLATE_DEFINITIONS` (`native-automations.ts:258-583`):
  **trigger `manual`**, steps `policy.check → approval.wait → dispatch → evidence.pack`, evaluated
  against a sample action/finding supplied in the run **input** (so the demo is self-contained and does
  not depend on the live scanner sidecar — the scanner→policy auto-trigger is F2, out of scope). No
  bundled template composes the full chain today; this is the canonical one.
- `packages/agentos-d/src/services/compliance-loop.e2e.test.ts`: seeds the workflow, runs it (parks at
  approval), drives an approval through the review path, asserts it advances to dispatch, the simulated
  adapter completes it, dispatch-completion auto-resumes the run, and `evidence.pack` produces a
  **sealed** pack referencing the decision + dispatch ids. This is both the regression proof and the
  demo script.

## Files

**New:** `services/loop-driver.ts`, `adapters/simulated-adapter.ts`, `routes/admin/demo-seed.ts`,
`db/migrations/0043_loop_indexes.ts`, `services/compliance-loop.e2e.test.ts`, plus unit tests for
loop-driver and simulated-adapter.
**Modify:** `routes/approval-queue.ts` (call `onApprovalResolved` post-broadcast),
`services/dispatch-consumer.ts` (call `onDispatchResolved` post-complete/fail), `cli.ts` (simulated
adapter selection + register reconciler cron), `services/native-automations.ts` (add `compliance-loop`
template; ensure `simulated` flag flows into the evidence pack), `db/migrations/index.ts` (wire 0043),
`docs/quickstart.md` (demo seed + `AWOS_ADAPTER=simulated` walkthrough).

**Reuse:** `resumeNativeAutomationRun` + its atomic claim, `createNativeAutomationEvidencePack`
(`native-automations.ts:2445`), `generateEvidenceReport`/`signPdf` (`evidence-report.ts:66,103`),
onboarding tenant-seed (`onboarding.ts:179`), the `evidence-report-cron` registration pattern, Spec-B
`requireScope`/`requireLocalAdmin`.

## Verification

1. **Unit — loop-driver**: `onApprovalResolved` resumes exactly the matching run; no match → no-op;
   `reconcileWaitingRuns` resumes an orphaned waiting run; double-trigger (hook + reconciler) runs the
   workflow once (atomic-claim guard).
2. **Unit — simulated adapter**: deterministic output for a fixed input; `simulated:true` present;
   role-specific shapes.
3. **Integration — `compliance-loop.e2e.test.ts`**: full chain produces a sealed evidence pack;
   reject path terminates the run without dispatch.
4. **Seed**: `POST /api/admin/demo/seed` is owner-gated (401/403 without owner principal), idempotent,
   and leaves a run at `waiting_approval`; `agentos seed-demo` produces the same state.
5. **Regression**: full `pnpm --filter @agentworks/agentos-d test` stays green (876 today); default
   `AWOS_ADAPTER` behavior unchanged (stub) — confirm no existing dispatch test flips.
6. **Manual demo**: fresh DB → `agentos seed-demo` → start daemon with `AWOS_ADAPTER=simulated` → open
   `/approvals` → approve → confirm `/active-work` shows the run completing and `/evidence` shows a
   sealed pack, end-to-end, no external credentials.
7. **Release safety**: `pnpm check:public-release` / `check:product-surfaces` / `check:version` stay
   green (no private strings in the seed data or template).

## Out of scope (future)

- Admin-ui one-click "Load demo" button (fast-follow on F4).
- F2 scanner→policy auto-evaluation (next spec).
- Real LLM adapters / credential management.
