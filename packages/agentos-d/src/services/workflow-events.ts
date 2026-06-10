/**
 * Generic workflow event bus.
 *
 * fireWorkflowEvent dispatches an event to all active event-triggered workflows
 * for the given tenant that subscribe to the specified event_kind. Each matching
 * workflow gets its own run started with `data` as the input.
 *
 * Per-workflow errors are logged and do not abort sibling dispatches. The caller
 * receives the list of workflow IDs that were successfully triggered.
 *
 * Loop-safety: this function is the only place scanner.finding events originate.
 * Workflow steps never call back into fireWorkflowEvent, so self-retriggering is
 * structurally impossible.
 */

import pino from "pino";
import { getSqlite } from "../db/index.js";
import type { Config } from "../config.js";
import { runNativeAutomationWorkflow } from "./native-automations.js";

const logger = pino({ name: "workflow-events" });

interface ActiveEventWorkflowRow {
  id: string;
}

export async function fireWorkflowEvent(
  eventKind: string,
  data: Record<string, unknown>,
  opts: { tenantId: string },
  config: Config,
): Promise<{ triggered: string[] }> {
  const sqlite = getSqlite();

  const rows = sqlite
    .prepare(
      `SELECT id FROM native_automation_workflows
       WHERE status = 'active'
         AND trigger_kind = 'event'
         AND event_kind = ?
         AND tenant_id = ?`,
    )
    .all(eventKind, opts.tenantId) as ActiveEventWorkflowRow[];

  if (rows.length === 0) {
    return { triggered: [] };
  }

  const triggered: string[] = [];

  for (const row of rows) {
    try {
      await runNativeAutomationWorkflow(row.id, data, config);
      triggered.push(row.id);
    } catch (err) {
      logger.error(
        { workflowId: row.id, eventKind, tenantId: opts.tenantId, err },
        "workflow-events: failed to start run for event-triggered workflow",
      );
    }
  }

  return { triggered };
}
