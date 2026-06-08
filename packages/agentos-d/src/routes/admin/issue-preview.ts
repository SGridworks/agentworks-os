/**
 * GET /api/admin/issue-preview?tenantId=<uuid>
 *
 * Read-only endpoint. Classifies issues for the given tenant into keep vs
 * candidate buckets without mutating any data.
 *
 * Response shape:
 *   { keep: [...], candidates: [...], counts: { keep, candidate } }
 *
 * NOTE: alwaysKeepIssueIds in the profile uses identifier strings
 * (e.g. "AWOS-STANDING") or UUIDs. Both are resolved to UUIDs before
 * classification so the classifier always works on execution_issues.id.
 */

import { Router } from "express";
import Database from "better-sqlite3";
import { getProfile } from "../../config/local-profile.js";
import { classify } from "../../services/issue-classifier.js";

export const issuePreviewRouter = Router();

interface IssueRow {
  id: string;
  metadata_json: string;
  assignee_heartbeat: string | null;
}

interface DispatchRow {
  issue_id: string | null;
}

interface IdentifierLookupRow {
  id: string;
}

issuePreviewRouter.get("/", async (_req, res) => {
  const rawTenantId = _req.query["tenantId"];
  if (typeof rawTenantId !== "string" || rawTenantId.trim() === "") {
    res
      .status(400)
      .json({ error: "invalid_request", message: "tenantId query param is required" });
    return;
  }
  const tenantId = rawTenantId.trim();

  let db: InstanceType<typeof Database> | null = null;
  try {
    const profile = await getProfile();
    db = new Database(profile.dbPath, { readonly: true, fileMustExist: true });

    // Resolve alwaysKeepIssueIds: entries may be UUIDs or identifier strings
    // (e.g. "AGE-277"). Look up each in execution_issues by id OR identifier.
    const alwaysKeepUuids = new Set<string>();
    for (const entry of profile.alwaysKeepIssueIds) {
      const rows = db
        .prepare<[string, string, string], IdentifierLookupRow>(
          `SELECT id FROM execution_issues
           WHERE tenant_id = ? AND (id = ? OR identifier = ?)
           LIMIT 1`,
        )
        .all(tenantId, entry, entry);
      for (const row of rows) {
        alwaysKeepUuids.add(row.id);
      }
      // If entry is already a UUID but not found in DB, keep it anyway so
      // a freshly created issue referenced before import is preserved.
      if (rows.length === 0) {
        alwaysKeepUuids.add(entry);
      }
    }

    // Fetch issues, joining assignee agent for heartbeat proxy.
    // last_heartbeat_at lives on execution_agents, not on execution_issues.
    const issueRows = db
      .prepare<string, IssueRow>(
        `SELECT
           ei.id,
           ei.metadata_json,
           ea.last_heartbeat_at AS assignee_heartbeat
         FROM execution_issues ei
         LEFT JOIN execution_agents ea ON ei.assignee_agent_id = ea.id
         WHERE ei.tenant_id = ?
           AND ei.status IN ('todo', 'in_progress', 'blocked', 'review')`,
      )
      .all(tenantId);

    // Collect issueIds referenced in dispatch_queue for this tenant.
    // input is JSON-TEXT; issueId lives at $.issueId (top-level) or
    // $.payload.issueId (nested) per the memory reference.
    const dispatchRows = db
      .prepare<string, DispatchRow>(
        `SELECT
           COALESCE(
             json_extract(input, '$.issueId'),
             json_extract(input, '$.payload.issueId')
           ) AS issue_id
         FROM dispatch_queue
         WHERE tenant_id = ?`,
      )
      .all(tenantId);

    const dispatchQueueIssueIds = new Set(
      dispatchRows
        .map((r) => r.issue_id)
        .filter((id): id is string => typeof id === "string"),
    );

    const issues = issueRows.map((row) => {
      let metadata: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(row.metadata_json);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, unknown>;
        }
      } catch {
        // malformed JSON — treat as null
      }
      return {
        id: row.id,
        metadata,
        lastHeartbeatAt: row.assignee_heartbeat,
      };
    });

    const output = classify({
      alwaysKeepIssueIds: [...alwaysKeepUuids],
      issues,
      dispatchQueueIssueIds,
    });

    res.json({
      keep: output.keep,
      candidates: output.candidates,
      counts: {
        keep: output.keep.length,
        candidate: output.candidates.length,
      },
    });
  } catch (err) {
    res.status(500).json({
      error: "internal_error",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    db?.close();
  }
});
