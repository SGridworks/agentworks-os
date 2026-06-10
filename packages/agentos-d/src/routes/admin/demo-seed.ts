/**
 * demo-seed.ts — Demo tenant seed for AgentWorks OS.
 *
 * Exports `seedDemo` (callable from this route and from cli.ts) and mounts
 * the `POST /api/admin/demo/seed` route (owner-only, loopback-gated).
 *
 * Idempotent: detects an existing demo tenant by the stable name marker and
 * returns its existing IDs rather than creating duplicates.
 */

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../config.js";
import { getDb, getSqlite } from "../../db/index.js";
import { tenants, scannerFindings } from "../../db/schema.js";
import { assignPackToTenant } from "../../rule-pack-assignments.js";
import {
  installNativeAutomationTemplate,
  runNativeAutomationWorkflow,
} from "../../services/native-automations.js";
import { requireLocalAdmin } from "../admin.js";

// Stable marker used to detect and deduplicate the demo tenant across runs.
const DEMO_TENANT_NAME = "Demo Co (AWOS)";

export interface SeedDemoResult {
  tenantId: string;
  companyId: string;
  workflowId: string;
  runId: string;
  approvalId: string;
}

/**
 * Seed a neutral synthetic demo tenant, two agents (review / engineer), sample
 * issues + scanner findings, the `compliance-loop` workflow, and run it until
 * it parks at `waiting_approval`.
 *
 * Safe to call repeatedly — re-running returns existing IDs without creating
 * duplicate rows.
 */
export async function seedDemo(config: Config): Promise<SeedDemoResult> {
  const sqlite = getSqlite();
  const db = getDb();
  const now = new Date().toISOString();

  // ---- 1. Tenant (idempotent) -----------------------------------------------
  const existing = sqlite
    .prepare("SELECT id FROM tenants WHERE name = ? LIMIT 1")
    .get(DEMO_TENANT_NAME) as { id: string } | undefined;

  let tenantId: string;

  if (existing) {
    tenantId = existing.id;
  } else {
    tenantId = randomUUID();
    const vaultRoot = join(
      process.env.VAULT_ROOT ?? join(homedir(), "vault", "wiki"),
      tenantId,
    );
    mkdirSync(vaultRoot, { recursive: true });

    db.insert(tenants)
      .values({
        id: tenantId,
        name: DEMO_TENANT_NAME,
        description: "Synthetic demo tenant — safe to delete.",
        industry: "other",
        vaultRoot,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // Assign the starter rule pack in shadow mode (non-fatal on failure).
    try {
      assignPackToTenant(tenantId, "smb-starter", "shadow");
    } catch {
      // Pack may be absent in minimal installs; continue.
    }
  }

  // ---- 2. Company (idempotent) -----------------------------------------------
  const existingCompany = sqlite
    .prepare(
      "SELECT id FROM execution_companies WHERE tenant_id = ? AND name = ? LIMIT 1",
    )
    .get(tenantId, "Demo Co") as { id: string } | undefined;

  let companyId: string;

  if (existingCompany) {
    companyId = existingCompany.id;
  } else {
    companyId = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO execution_companies
         (id, tenant_id, name, slug, slug_prefix, status, metadata_json, created_at, updated_at)
         VALUES (?, ?, 'Demo Co', 'demo-co', 'DEM', 'active', '{}', ?, ?)`,
      )
      .run(companyId, tenantId, now, now);
    sqlite
      .prepare(
        "INSERT OR IGNORE INTO execution_company_issue_seq (company_id, next_seq) VALUES (?, 1)",
      )
      .run(companyId);
  }

  // ---- 3. Project (idempotent) -----------------------------------------------
  const existingProject = sqlite
    .prepare(
      "SELECT id FROM execution_projects WHERE company_id = ? AND name = ? LIMIT 1",
    )
    .get(companyId, "Demo Project") as { id: string } | undefined;

  let projectId: string;

  if (existingProject) {
    projectId = existingProject.id;
  } else {
    projectId = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO execution_projects
         (id, tenant_id, company_id, name, status, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, 'Demo Project', 'active', '{}', ?, ?)`,
      )
      .run(projectId, tenantId, companyId, now, now);
  }

  // ---- 4. Agents (idempotent) ------------------------------------------------
  function ensureAgent(name: string, role: string): string {
    const row = sqlite
      .prepare(
        "SELECT id FROM execution_agents WHERE tenant_id = ? AND name = ? LIMIT 1",
      )
      .get(tenantId, name) as { id: string } | undefined;
    if (row) return row.id;

    const id = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO execution_agents
         (id, tenant_id, company_id, name, role, status, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', '{}', ?, ?)`,
      )
      .run(id, tenantId, companyId, name, role, now, now);
    return id;
  }

  ensureAgent("reviewer", "review");
  const engineerId = ensureAgent("engineer", "engineer");

  // ---- 4. Sample issue + scanner finding (idempotent) -----------------------
  const existingIssue = sqlite
    .prepare(
      "SELECT id FROM execution_issues WHERE tenant_id = ? AND title = ? LIMIT 1",
    )
    .get(tenantId, "Demo: Review flagged outbound message") as
    | { id: string }
    | undefined;

  if (!existingIssue) {
    const issueId = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO execution_issues
         (id, tenant_id, company_id, project_id, identifier, title, description,
          status, priority, assignee_agent_id, parent_issue_id,
          blocked_on_json, metadata_json, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, 'DEM-1',
          'Demo: Review flagged outbound message',
          'Sample issue created by the demo seed to demonstrate the compliance loop.',
          'todo', 'high', ?, NULL, '[]', '{}', ?, ?, NULL)`,
      )
      .run(issueId, tenantId, companyId, projectId, engineerId, now, now);

    // Sample scanner finding that the compliance-loop workflow will evaluate.
    const findingId = randomUUID();
    db.insert(scannerFindings)
      .values({
        id: findingId,
        tenantId,
        originKind: "scanner_finding",
        originId: findingId,
        severity: "high",
        ruleId: "demo-outbound-001",
        title: "Demo: Unreviewed outbound message detected",
        description:
          "A sample outbound message finding injected by the demo seed. No real data was scanned.",
        remediation: "Review, approve, or reject the message in the approvals queue.",
        affectedEndpoint: null,
        status: "open",
        resolvedBy: null,
        resolvedAt: null,
        resolutionNote: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  // ---- 5. Install + run the compliance-loop workflow (idempotent) -----------
  const workflow = installNativeAutomationTemplate("compliance-loop", {
    tenantId,
    companyId,
  });

  // Check if there is already a waiting_approval run for this workflow so we
  // do not create a second one on repeated calls.
  const existingRun = sqlite
    .prepare(
      `SELECT id, waiting_for_approval_id
       FROM native_automation_runs
       WHERE workflow_id = ? AND status = 'waiting_approval'
       LIMIT 1`,
    )
    .get(workflow.id) as
    | { id: string; waiting_for_approval_id: string | null }
    | undefined;

  if (existingRun) {
    return {
      tenantId,
      companyId,
      workflowId: workflow.id,
      runId: existingRun.id,
      approvalId: existingRun.waiting_for_approval_id ?? "",
    };
  }

  const run = await runNativeAutomationWorkflow(
    workflow.id,
    {
      finding: {
        id: "demo-finding-001",
        title: "Demo: Unreviewed outbound message detected",
        severity: "high",
        description:
          "Sample finding: an agent attempted to send an outbound message without prior review.",
        simulated: true,
      },
    },
    config,
  );

  if (run.status !== "waiting_approval" || !run.waitingForApprovalId) {
    throw new Error(
      `demo seed: expected run to park at waiting_approval, got ${run.status}`,
    );
  }

  return {
    tenantId,
    companyId,
    workflowId: workflow.id,
    runId: run.id,
    approvalId: run.waitingForApprovalId,
  };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export function createDemoSeedRouter(config: Config): Router {
  const router = Router();

  router.post("/demo/seed", async (req, res) => {
    if (!requireLocalAdmin(req, res, config)) return;

    try {
      const result = await seedDemo(config);
      res.status(200).json({
        ...result,
        message:
          "Demo seed complete. Open /approvals to approve the pending item. " +
          "Start the daemon with AWOS_ADAPTER=simulated to watch the full loop complete.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: "seed_failed", message });
    }
  });

  return router;
}
