/**
 * Level-triggered event producer sweeps.
 *
 * Queries stale rows in approval_queue and execution_issues, then emits
 * workflow events for newly-breached subjects. Dedup is enforced atomically
 * via INSERT OR IGNORE into workflow_event_emissions: only a row whose
 * changes===1 (i.e. it was freshly inserted, not silently skipped) proceeds
 * to fireWorkflowEvent. This makes sweeps idempotent and restart-safe.
 */

import { randomUUID } from "node:crypto";
import { getSqlite } from "../db/index.js";
import type { Config } from "../config.js";
import { fireWorkflowEvent } from "./workflow-events.js";

const DEFAULT_APPROVAL_SLA_HOURS = 24;
const DEFAULT_STUCK_ISSUE_HOURS = 4;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function subtractHours(from: Date, hours: number): string {
  return new Date(from.getTime() - hours * 60 * 60 * 1000).toISOString();
}

interface ApprovalRow {
  id: string;
  tenant_id: string;
  created_at: string;
}

interface IssueRow {
  id: string;
  tenant_id: string;
  status: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Sweep 1: approval SLA breaches
// ---------------------------------------------------------------------------

export async function sweepApprovalSlaBreaches(
  config: Config,
  now: Date = new Date(),
): Promise<{ fired: number }> {
  const slaHours = Number(process.env.AGENTOS_APPROVAL_SLA_HOURS) || DEFAULT_APPROVAL_SLA_HOURS;
  const cutoff = subtractHours(now, slaHours);
  const sqlite = getSqlite();

  const rows = sqlite
    .prepare(
      `SELECT id, tenant_id, created_at
       FROM approval_queue
       WHERE status = 'pending'
         AND created_at < ?`,
    )
    .all(cutoff) as ApprovalRow[];

  let fired = 0;

  for (const row of rows) {
    const emissionId = randomUUID();
    const info = sqlite
      .prepare(
        `INSERT OR IGNORE INTO workflow_event_emissions
         (id, event_kind, subject_id, tenant_id, emitted_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(emissionId, "approval.sla_breach", row.id, row.tenant_id, now.toISOString());

    if (info.changes !== 1) continue;

    try {
      await fireWorkflowEvent(
        "approval.sla_breach",
        { approval: { id: row.id, tenantId: row.tenant_id, createdAt: row.created_at } },
        { tenantId: row.tenant_id },
        config,
      );
      fired++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[event-producer-sweeps] approval.sla_breach fireWorkflowEvent failed for approval ${row.id}: ${msg}`,
      );
    }
  }

  return { fired };
}

// ---------------------------------------------------------------------------
// Sweep 2: stuck issues
// ---------------------------------------------------------------------------

export async function sweepStuckIssues(
  config: Config,
  now: Date = new Date(),
): Promise<{ fired: number }> {
  const stuckHours = Number(process.env.AGENTOS_STUCK_ISSUE_THRESHOLD_HOURS) || DEFAULT_STUCK_ISSUE_HOURS;
  const cutoff = subtractHours(now, stuckHours);
  const sqlite = getSqlite();

  const rows = sqlite
    .prepare(
      `SELECT id, tenant_id, status, updated_at
       FROM execution_issues
       WHERE status IN ('in_progress', 'blocked')
         AND assignee_agent_id IS NOT NULL
         AND updated_at < ?`,
    )
    .all(cutoff) as IssueRow[];

  let fired = 0;

  for (const row of rows) {
    const emissionId = randomUUID();
    const info = sqlite
      .prepare(
        `INSERT OR IGNORE INTO workflow_event_emissions
         (id, event_kind, subject_id, tenant_id, emitted_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(emissionId, "issue.stuck", row.id, row.tenant_id, now.toISOString());

    if (info.changes !== 1) continue;

    try {
      await fireWorkflowEvent(
        "issue.stuck",
        { issue: { id: row.id, tenantId: row.tenant_id, status: row.status, updatedAt: row.updated_at } },
        { tenantId: row.tenant_id },
        config,
      );
      fired++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[event-producer-sweeps] issue.stuck fireWorkflowEvent failed for issue ${row.id}: ${msg}`,
      );
    }
  }

  return { fired };
}

// ---------------------------------------------------------------------------
// Combined runner
// ---------------------------------------------------------------------------

export async function runEventProducerSweeps(config: Config): Promise<void> {
  try {
    const sla = await sweepApprovalSlaBreaches(config);
    console.log(`[event-producer-sweeps] approval.sla_breach fired=${sla.fired}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[event-producer-sweeps] sweepApprovalSlaBreaches failed: ${msg}`);
  }

  try {
    const stuck = await sweepStuckIssues(config);
    console.log(`[event-producer-sweeps] issue.stuck fired=${stuck.fired}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[event-producer-sweeps] sweepStuckIssues failed: ${msg}`);
  }
}
