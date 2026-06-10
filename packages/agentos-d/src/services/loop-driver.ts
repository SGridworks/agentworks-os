/**
 * Loop driver — closes the approval→dispatch→evidence join by resuming parked
 * native automation runs when the thing they are waiting on resolves.
 *
 * Two inline hooks (called from the review handler and the dispatch consumer)
 * provide immediate wakeups. The reconciler sweep provides self-healing for
 * wakeups that were missed after a daemon restart.
 *
 * Safety: resumeNativeAutomationRun already performs an atomic status claim
 * (UPDATE … WHERE status IN ('waiting_approval','waiting_dispatch')), so
 * calling both the inline hook and the reconciler for the same run is a
 * safe no-op for whichever call arrives second.
 */

import pino from "pino";
import { getSqlite } from "../db/index.js";
import { loadConfig, type Config } from "../config.js";
import { resumeNativeAutomationRun } from "./native-automations.js";

const logger = pino({ name: "loop-driver" });

interface WaitingApprovalRow {
  id: string;
  waiting_for_approval_id: string;
}

interface WaitingDispatchRow {
  id: string;
  waiting_for_dispatch_id: string;
}

interface ApprovalStatusRow {
  status: string;
}

interface DispatchStatusRow {
  status: string;
}

/**
 * Called after an approval_queue row is reviewed.
 *
 * Looks up all native_automation_runs parked on that approval and resumes
 * each with the review outcome. Errors per run are logged but never re-thrown
 * so the HTTP handler stays responsive.
 */
export async function onApprovalResolved(
  approvalId: string,
  decision: "approved" | "rejected",
  meta?: { reviewedBy?: string; reviewNote?: string },
  config?: Config,
): Promise<void> {
  const sqlite = getSqlite();
  const rows = sqlite
    .prepare(
      `SELECT id, waiting_for_approval_id
       FROM native_automation_runs
       WHERE waiting_for_approval_id = ? AND status = 'waiting_approval'`,
    )
    .all(approvalId) as WaitingApprovalRow[];

  if (rows.length === 0) return;

  const cfg = config ?? loadConfig();
  for (const row of rows) {
    try {
      await resumeNativeAutomationRun(
        row.id,
        {
          decision,
          ...(meta?.reviewedBy !== undefined ? { reviewedBy: meta.reviewedBy } : {}),
          ...(meta?.reviewNote !== undefined ? { reviewNote: meta.reviewNote } : {}),
        },
        cfg,
      );
    } catch (err) {
      logger.error(
        { runId: row.id, approvalId, err: err instanceof Error ? err.message : String(err) },
        "loop-driver: failed to resume run after approval resolved",
      );
    }
  }
}

/**
 * Called after a dispatch_queue row completes or fails.
 *
 * Looks up all native_automation_runs parked on that dispatch and resumes
 * each with the dispatch outcome.
 */
export async function onDispatchResolved(
  dispatchId: string,
  dispatchStatus: "completed" | "failed",
  config?: Config,
): Promise<void> {
  const sqlite = getSqlite();
  const rows = sqlite
    .prepare(
      `SELECT id, waiting_for_dispatch_id
       FROM native_automation_runs
       WHERE waiting_for_dispatch_id = ? AND status = 'waiting_dispatch'`,
    )
    .all(dispatchId) as WaitingDispatchRow[];

  if (rows.length === 0) return;

  const cfg = config ?? loadConfig();
  for (const row of rows) {
    try {
      await resumeNativeAutomationRun(row.id, { dispatchStatus }, cfg);
    } catch (err) {
      logger.error(
        { runId: row.id, dispatchId, err: err instanceof Error ? err.message : String(err) },
        "loop-driver: failed to resume run after dispatch resolved",
      );
    }
  }
}

export interface ReconcileResult {
  resumed: number;
  failed: number;
}

/**
 * Sweep: find waiting runs whose linked approval/dispatch already resolved and
 * resume them. This is the self-healing safety net for wakeups that were lost
 * across a daemon restart.
 *
 * Double-trigger with the inline hooks is safe — the atomic claim in
 * resumeNativeAutomationRun turns the second call into a no-op.
 */
export async function reconcileWaitingRuns(config: Config): Promise<ReconcileResult> {
  const sqlite = getSqlite();
  const result: ReconcileResult = { resumed: 0, failed: 0 };

  // --- approval side ---
  const waitingApproval = sqlite
    .prepare(
      `SELECT r.id, r.waiting_for_approval_id, aq.status AS approval_status
       FROM native_automation_runs r
       JOIN approval_queue aq ON aq.id = r.waiting_for_approval_id
       WHERE r.status = 'waiting_approval'
         AND aq.status IN ('approved', 'rejected')`,
    )
    .all() as Array<{ id: string; waiting_for_approval_id: string; approval_status: string }>;

  for (const row of waitingApproval) {
    const decision = row.approval_status === "approved" ? "approved" : "rejected";
    try {
      await resumeNativeAutomationRun(row.id, { decision }, config);
      result.resumed++;
    } catch (err) {
      logger.error(
        { runId: row.id, approvalId: row.waiting_for_approval_id, err: err instanceof Error ? err.message : String(err) },
        "loop-driver reconcile: failed to resume approval-waiting run",
      );
      result.failed++;
    }
  }

  // --- dispatch side ---
  const waitingDispatch = sqlite
    .prepare(
      `SELECT r.id, r.waiting_for_dispatch_id, dq.status AS dispatch_status
       FROM native_automation_runs r
       JOIN dispatch_queue dq ON dq.id = r.waiting_for_dispatch_id
       WHERE r.status = 'waiting_dispatch'
         AND dq.status IN ('completed', 'failed')`,
    )
    .all() as Array<{ id: string; waiting_for_dispatch_id: string; dispatch_status: string }>;

  for (const row of waitingDispatch) {
    const dispatchStatus = row.dispatch_status === "completed" ? "completed" : "failed";
    try {
      await resumeNativeAutomationRun(row.id, { dispatchStatus }, config);
      result.resumed++;
    } catch (err) {
      logger.error(
        { runId: row.id, dispatchId: row.waiting_for_dispatch_id, err: err instanceof Error ? err.message : String(err) },
        "loop-driver reconcile: failed to resume dispatch-waiting run",
      );
      result.failed++;
    }
  }

  logger.info(result, "loop-driver reconcile complete");
  return result;
}
