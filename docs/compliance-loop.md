# Autonomous Compliance Loop

AgentWorks OS includes a built-in compliance loop that runs end-to-end with a single human approval: a scanner finding drives policy evaluation, parks for operator review, dispatches remediation work to an agent, and seals a cryptographically-signed evidence pack — all without further manual steps.

```
scanner finding → policy check → approval (human) → dispatch → sealed evidence pack
```

Once you approve, the loop resumes itself: the loop driver wakes the waiting run, advances it to dispatch, waits for the dispatch result, then produces the evidence pack. Restart-safe: a reconciler re-wakes any run whose linked approval or dispatch resolved while the daemon was down.

---

## Fastest path: see it in 30 seconds

### 1. Seed the demo

Choose one of these three equivalent methods:

**Admin UI (empty-tenant state)**
Click **Load demo** on the initial screen. The UI routes you to the Approvals page when the seed completes.

**CLI**
```bash
agentos seed-demo
```

**REST API (owner-only, loopback-gated)**
```bash
curl -X POST http://localhost:7710/api/admin/demo/seed
```

All three are idempotent — re-running returns the existing IDs without creating duplicates.

The seed creates a "Demo Co (AWOS)" tenant, two agents (reviewer and engineer roles), a sample scanner finding (`high` severity), and the `compliance-loop` workflow. It then starts a run and parks it at `waiting_approval` so there is an item ready to approve.

### 2. Start the daemon with the simulated adapter

For realistic dispatch output without any external credentials, set `AWOS_ADAPTER=simulated`:

```bash
AWOS_ADAPTER=simulated agentos start
```

The simulated adapter returns deterministic, role-aware output and always marks results with `simulated: true` so they are never mistaken for real agent work.

### 3. Approve the pending item

Open the Approvals page (`/approvals`) and approve the seeded item. The loop driver picks up the decision, advances the run to dispatch, waits for the simulated adapter to complete, then seals the evidence pack.

Confirm the result on **Active Work** (run status `succeeded`) and **Evidence** (a sealed pack referencing the approval and dispatch IDs).

### Returning an item for revision

Instead of approving or rejecting, a reviewer can choose **return for revision** (`return_to_author`). The run does not fail — it parks in a non-terminal `waiting_revision` state carrying the reviewer's note. From **Active Work**, a `waiting_revision` run shows the note and a **Resubmit** control with an optional JSON input patch. Resubmitting (or `POST /api/admin/automations/runs/:id/resubmit`) re-enters the approval gate with the revised proposal, creating a fresh pending approval; approving it then continues the loop normally to dispatch and evidence. Each return → resubmit cycle is recorded in the approval history.

---

## Workflow event bus

The daemon ships a generic event bus (`workflow-events.ts`) that lets any producer start a workflow run by firing a named event. When an active event-triggered workflow whose `event_kind` matches is found for the tenant, the bus calls `runNativeAutomationWorkflow` for each match. Per-workflow errors are logged but do not abort sibling dispatches.

### Event kinds

| Event kind | Produced by | When |
|---|---|---|
| `scanner.finding` | Scanner route | A new finding row is inserted at or above the severity threshold |
| `dispatch.failed` | Dispatch consumer | A dispatch row transitions to `failed` |
| `provider.degraded` | Provider health check | A provider health metric crosses the degraded threshold |
| `approval.sla_breach` | Event-producer sweep | A pending approval queue item ages past the SLA window |
| `issue.stuck` | Event-producer sweep | An assigned in-progress or blocked issue has no fresh activity past the stuck threshold |

### Activating an event-triggered workflow

1. In the Automations view, find the template you want (e.g. `scanner-compliance-loop`, `approval-sla-watchdog`, `issue-stuck-escalator`, `failed-dispatch-recovery`, `provider-degradation-watch`).
2. Install it, then set its status to **Active**.
3. The **Active event subscriptions** panel in the Automations view shows every active event-triggered workflow and the event kind it listens on.

The `scanner-compliance-loop` template is the event-driven sibling of `compliance-loop`. Installing and activating it arms the auto-loop: high-severity findings automatically proceed through policy → approval → dispatch → evidence without any manual trigger.

---

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `AWOS_ADAPTER` | `router` | Dispatch adapter. Set to `simulated` for deterministic demo output (no external credentials). `stub` is a silent no-op. |
| `AGENTOS_SCANNER_AUTOLOOP_SEVERITIES` | `high,critical` | Comma-separated severity levels that trigger a `scanner.finding` event. Findings below this threshold are stored but do not fire the bus. |
| `AGENTOS_APPROVAL_SLA_HOURS` | `24` | Age in hours after which a pending approval queue item fires an `approval.sla_breach` event. |
| `AGENTOS_STUCK_ISSUE_THRESHOLD_HOURS` | `4` | Age in hours (since last update) after which an assigned in-progress or blocked issue fires an `issue.stuck` event. |
| `AGENTOS_EVENT_SWEEP_MS` | `900000` | Interval (ms) between event-producer sweeps (approval SLA + stuck issues). Default is 15 minutes. |
| `AGENTOS_LOOP_RECONCILE_MS` | `60000` | Interval (ms) for the loop-driver reconciler that re-wakes waiting runs whose linked approval or dispatch already resolved. Default is 1 minute. |
| `AGENTOS_PROVIDER_POLL_MS` | `300000` | Interval (ms) for the background provider-health poll that fires `provider.degraded` on a healthy-to-degraded transition. Default is 5 minutes; set `0` to disable. |

---

## How it's wired (contributors)

The loop spans three services and one adapter:

- **`services/workflow-events.ts`** — Generic event bus. `fireWorkflowEvent(eventKind, data, opts, config)` queries active event-triggered workflows for the tenant and starts a run for each match.
- **`services/loop-driver.ts`** — Auto-resume layer. `onApprovalResolved` and `onDispatchResolved` are called inline from the approval and dispatch completion paths respectively; `reconcileWaitingRuns` runs on the configured interval to catch any wakeups lost across restarts. Resume uses an atomic status claim so duplicate triggers from the inline hook and the reconciler are no-ops.
- **`services/native-automations.ts`** — Template library. The `compliance-loop` template (manual trigger) and `scanner-compliance-loop` template (event trigger on `scanner.finding`) define the `policy.check → approval.wait → dispatch → evidence.pack` step chain. The other event templates (`approval-sla-watchdog`, `issue-stuck-escalator`, `failed-dispatch-recovery`, `provider-degradation-watch`) follow the same pattern with lighter step chains.
- **`services/event-producer-sweeps.ts`** — Level-triggered producers for `approval.sla_breach` and `issue.stuck`. Emission dedup is enforced via `INSERT OR IGNORE` into `workflow_event_emissions` so a sweep never fires the same event for the same subject twice.

The demo seed entry point is `routes/admin/demo-seed.ts`. The `agentos seed-demo` CLI command calls the same `seedDemo` function.
