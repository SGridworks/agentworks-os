# Spec C3 — Return-for-revision (return_to_author rework)

**Date:** 2026-06-10
**Status:** Design — pending review
**Target:** AgentWorks OS v0.3 line (`packages/agentos-d`, `packages/admin-ui`)
**Builds on:** the autonomous compliance loop (C1/C2) and the loop-driver auto-resume.

## Context

The approval gate already accepts three reviewer decisions — approve, reject, and
`return_to_author` (approval-queue.ts:39). Approve and reject work end-to-end, but `return_to_author`
currently sets the approval row to `returned` and then signals the parked run as `"rejected"`
(approval-queue.ts:285), so the run **halts** (recorded as `approval_returned`). There is no path for
a returned proposal to be revised and re-submitted — "send back for revision" is silently a dead end.

This spec makes `return_to_author` a real loop: the run parks in a non-terminal state, and an explicit
resubmit (by the author agent or a human reviewer) re-enters the approval gate with an optionally
revised proposal. This completes the human-in-the-loop story for the compliance loop without
introducing auto-churn.

## Decisions (locked)

1. **Re-park for explicit resubmit.** The run enters a new non-terminal `waiting_revision` state; an
   explicit resubmit re-enters the `approval.wait` step. (Not auto re-dispatch, not loop-back-to-step.)
2. **Include the admin-ui Resubmit button** in this spec (active-work page), alongside the
   owner-gated endpoint.
3. Resubmit accepts an **optional** input patch (re-submits as-is if omitted). A `revision_count` is
   recorded for audit. **No hard revision cap** in v1 — explicit resubmit is naturally bounded.

## Design

### State machine
- New non-terminal run status `waiting_revision`. The `native_automation_runs.status` column is
  free-text, so **no migration** is required.
- `approval-queue.ts` review handler: on `return_to_author`, keep setting the approval row to
  `returned`, but signal the loop-driver with a new `"returned"` decision (instead of mapping it to
  `"rejected"`).
- `loop-driver.ts` `onApprovalResolved`: extend the `decision` type to
  `"approved" | "rejected" | "returned"` and pass it through to `resumeNativeAutomationRun`.
- `resumeNativeAutomationRun` (native-automations.ts): add a `"returned"` branch in the
  `waiting_approval` handling. Instead of the fail path, it:
  - sets the run status to `waiting_revision` (keeps `waiting_for_approval_id` referencing the
    returned approval for the audit link; clears nothing that would orphan it),
  - records the reviewer note + a `revision` marker on the current step output,
  - returns the run parked at `waiting_revision` (does not advance, does not fail).
  The pre-claim terminal guard added earlier must treat `"returned"` as a valid progress decision so
  it claims and re-parks rather than no-op'ing.

### Resubmit
- New `resubmitNativeAutomationRun(runId, input?, config)` in native-automations.ts:
  - requires `run.status === "waiting_revision"`; otherwise returns the run unchanged (no claim).
  - atomically claims the run (CAS `WHERE status='waiting_revision'`) to prevent double-resubmit.
  - merges the optional `input` patch into the run's stored input/context (shallow merge; if omitted,
    re-submits the existing input).
  - re-executes the `approval.wait` step at the run's `currentStepIndex` — enqueues a **fresh**
    `pending` approval_queue entry — and sets the run to `waiting_approval` on the new approval id.
  - increments `revision_count` (derived from / recorded on the run; see Audit).
- New endpoint `POST /api/admin/automations/runs/:id/resubmit` (mounted with the other automations run
  endpoints in admin.ts): owner-gated via `requireLocalAdmin`, tenant-bound via
  `assertTenantAllowed(req.principal, run.tenantId)`. Body `{ input?: Record<string, unknown> }`.
  Returns the run (now `waiting_approval` on a fresh approval). 400/409 if the run isn't in
  `waiting_revision`.

### Admin-ui
- `packages/admin-ui/src/lib/api.ts`: add `resubmitAutomationRun(runId, input?)` →
  `POST /api/admin/automations/runs/:id/resubmit` through the daemon-fetch proxy.
- Active-work page (`packages/admin-ui/src/app/(redesigned)/active-work/...`): for runs in
  `waiting_revision`, surface the reviewer's return note and a **Resubmit** control with an optional
  edited-input textarea (JSON). On submit, call `resubmitAutomationRun` and refresh; the run moves back
  to `waiting_approval` and reappears in the approvals view. Match the existing resume/replay/cancel
  control styling on that page.

### Audit
- The accumulating approval_queue rows (`returned` then a fresh `pending` per cycle) are the primary
  audit trail. `revision_count` is recorded for display (derive from the count of `returned` outcomes
  in the run's step history, or store it on the run input/context to avoid a migration — implementer's
  choice, no schema change). The run never enters a terminal state during a revision cycle.

### Loop-safety
- Resubmit is only valid from `waiting_revision` and is atomically claimed, so concurrent resubmits
  collapse to one. `return_to_author` events originate only from the review handler, never from a
  workflow step, so there is no auto-churn. No cap needed in v1 (each cycle requires an explicit human
  or agent action).

## Files

**Modify (daemon):** `routes/approval-queue.ts` (map `return_to_author` → `"returned"` signal),
`services/loop-driver.ts` (decision type incl. `"returned"`), `services/native-automations.ts`
(`"returned"` → `waiting_revision`; new `resubmitNativeAutomationRun`; pre-claim guard accepts
`"returned"`), `routes/admin.ts` (resubmit endpoint).
**Modify (admin-ui):** `src/lib/api.ts` (`resubmitAutomationRun`), the active-work page (Resubmit
control + return-note display).

**Reuse:** the `approval.wait` step executor (`executeApprovalEnqueue`), the atomic-claim pattern in
`resumeNativeAutomationRun`, `requireLocalAdmin` + `assertTenantAllowed`, the daemon-fetch proxy.

## Verification

1. **Unit — return path**: `return_to_author` review parks the run in `waiting_revision` (not
   `failed`/`succeeded`); the returned approval row is `returned`; the reviewer note is recorded.
2. **Unit — resubmit**: `resubmitNativeAutomationRun` on a `waiting_revision` run creates a fresh
   `pending` approval and moves the run to `waiting_approval` on the new approval id; a revised `input`
   patch is reflected in the new run input; resubmit on a non-`waiting_revision` run returns unchanged;
   concurrent double-resubmit yields exactly one fresh approval (atomic claim).
3. **Endpoint**: `POST .../resubmit` is owner-gated (401/403 without owner token / wrong tenant),
   400/409 when the run isn't in `waiting_revision`, 200 + run on success.
4. **Integration e2e**: finding → loop parks at approval → reviewer returns (`waiting_revision`) →
   resubmit → fresh approval → approve → dispatch (simulated) → sealed evidence pack. Proves the full
   return→resubmit→approve→evidence cycle.
5. **admin-ui**: `pnpm --filter @agentworks/admin-ui build` passes; the Resubmit control calls the
   endpoint through the proxy.
6. **Regression**: full `pnpm --filter @agentworks/agentos-d test` green; tsc clean; release scanners
   green.

## Out of scope (future)

- Auto re-dispatch to the author agent (the hands-off variant) and loop-back-to-a-prior-step.
- A revision cap / escalation after N returns.
- Per-field structured proposal editing in the UI (v1 takes a JSON input patch).
