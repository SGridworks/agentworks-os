/**
 * Tests for event-producer-sweeps.ts
 *
 * Verifies:
 *   - sweepApprovalSlaBreaches: stale pending approval fires once, re-sweep deduped, fresh approval skipped
 *   - sweepStuckIssues: stale in_progress assigned issue fires once, re-sweep deduped, recent/unassigned skipped
 *   - tenant isolation: tenant A's stale rows do not fire tenant B's workflow
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { initDb, resetDb, getSqlite, getDb } from "../db/index.js";
import { migrate } from "../db/migrations/index.js";
import { _resetVaultStoreForTesting } from "../routes/memory.js";
import { tenants } from "../db/schema.js";
import { installNativeAutomationTemplate } from "./native-automations.js";
import { sweepApprovalSlaBreaches, sweepStuckIssues } from "./event-producer-sweeps.js";

// ---------------------------------------------------------------------------
// Constants matching TEMPLATE_DEFINITIONS in native-automations.ts
// ---------------------------------------------------------------------------

const EXAMPLE_AGENT_ID = "00000000-0000-4000-8000-000000000004";
const EXAMPLE_PROJECT_ID = "00000000-0000-4000-8000-000000000003";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let root: string;
let config: Config;
let previousVaultRoot: string | undefined;

function makeConfig(dataDir: string): Config {
  return {
    host: "127.0.0.1",
    port: 7712,
    logLevel: "silent",
    awcpVersion: "awcp/v0.1",
    dataDir,
    scannerSidecarUrl: "http://127.0.0.1:3101",
    scannerPollIntervalMs: 30_000,
    auditLogRetentionDays: 30,
    companyId: "",
    standingIssueId: "standing",
    legacyBridgeUrl: "http://127.0.0.1:3100",
    legacyBridgeApiKey: "local-trusted",
    legacyBridgeEnabled: false,
    agentsRoot: "",
  } as unknown as Config;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "awos-event-sweeps-"));
  config = makeConfig(join(root, "data"));
  previousVaultRoot = process.env.VAULT_ROOT;
  process.env.VAULT_ROOT = join(root, "vault");
  _resetVaultStoreForTesting();
  initDb({ config: config as unknown as Parameters<typeof initDb>[0]["config"], migrations: migrate });
});

afterEach(() => {
  resetDb();
  _resetVaultStoreForTesting();
  if (previousVaultRoot === undefined) {
    delete process.env.VAULT_ROOT;
  } else {
    process.env.VAULT_ROOT = previousVaultRoot;
  }
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function seedTenant(label: string): { tenantId: string; companyId: string } {
  const sqlite = getSqlite();
  const db = getDb();
  const now = new Date().toISOString();

  const tenantId = randomUUID();
  const vaultRoot = join(process.env.VAULT_ROOT!, tenantId);
  mkdirSync(vaultRoot, { recursive: true });

  db.insert(tenants)
    .values({
      id: tenantId,
      name: `Event Sweeps Test Tenant ${label}`,
      description: "Synthetic test tenant — event-producer-sweeps tests.",
      industry: "other",
      vaultRoot,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const companyId = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO execution_companies
       (id, tenant_id, name, slug, slug_prefix, status, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'TST', 'active', '{}', ?, ?)`,
    )
    .run(companyId, tenantId, `Test Co ${label}`, `test-co-${label}`, now, now);
  sqlite
    .prepare("INSERT OR IGNORE INTO execution_company_issue_seq (company_id, next_seq) VALUES (?, 1)")
    .run(companyId);

  return { tenantId, companyId };
}

/** Ensure the well-known agent and project used by template definitions exist. */
function ensureExampleFixtures(tenantId: string, companyId: string): void {
  const sqlite = getSqlite();
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO execution_agents
       (id, tenant_id, company_id, name, role, status, config_json, created_at, updated_at)
       VALUES (?, ?, ?, 'example-agent', 'engineer', 'active', '{}', ?, ?)`,
    )
    .run(EXAMPLE_AGENT_ID, tenantId, companyId, now, now);
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO execution_projects
       (id, tenant_id, company_id, name, status, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, 'Example Project', 'active', '{}', ?, ?)`,
    )
    .run(EXAMPLE_PROJECT_ID, tenantId, companyId, now, now);
}

/** Insert a pending approval with a specified created_at. */
function insertApproval(tenantId: string, createdAt: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  // policy_decision_id has no FK constraint — use a stub UUID.
  const policyDecisionId = randomUUID();
  getSqlite()
    .prepare(
      `INSERT INTO approval_queue
       (id, policy_decision_id, tenant_id, actor_label, proposed_action_kind,
        proposed_action_summary, decision_reason, status, created_at, updated_at)
       VALUES (?, ?, ?, 'test-actor', 'test.action', 'summary', 'sla-test', 'pending', ?, ?)`,
    )
    .run(id, policyDecisionId, tenantId, createdAt, now);
  return id;
}

/** Insert an execution_issue with given status, assignee, and updated_at. */
function insertIssue(opts: {
  tenantId: string;
  companyId: string;
  status: string;
  assigneeAgentId: string | null;
  updatedAt: string;
}): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  getSqlite()
    .prepare(
      `INSERT INTO execution_issues
       (id, tenant_id, company_id, project_id, identifier, title, description,
        status, priority, assignee_agent_id, parent_issue_id, blocked_on_json,
        metadata_json, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, NULL, 'Test issue', '', ?, 'medium', ?, NULL, '[]', '{}', ?, ?, NULL)`,
    )
    .run(
      id,
      opts.tenantId,
      opts.companyId,
      EXAMPLE_PROJECT_ID,
      opts.status,
      opts.assigneeAgentId,
      now,
      opts.updatedAt,
    );
  return id;
}

function getRunsForWorkflow(workflowId: string): Array<{ id: string; status: string }> {
  return getSqlite()
    .prepare("SELECT id, status FROM native_automation_runs WHERE workflow_id = ? ORDER BY started_at")
    .all(workflowId) as Array<{ id: string; status: string }>;
}

function emissionCount(eventKind: string, subjectId: string): number {
  const row = getSqlite()
    .prepare(
      "SELECT COUNT(*) AS cnt FROM workflow_event_emissions WHERE event_kind = ? AND subject_id = ?",
    )
    .get(eventKind, subjectId) as { cnt: number };
  return row.cnt;
}

// ---------------------------------------------------------------------------
// sweepApprovalSlaBreaches
// ---------------------------------------------------------------------------

describe("sweepApprovalSlaBreaches", () => {
  it("fires once for a stale pending approval; workflow run is created", async () => {
    const { tenantId, companyId } = seedTenant("SLA-A");
    ensureExampleFixtures(tenantId, companyId);

    const workflow = installNativeAutomationTemplate("approval-sla-watchdog", {
      tenantId,
      companyId,
    });

    // created_at 25 hours ago (past the default 24-hr SLA)
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const approvalId = insertApproval(tenantId, staleTime);

    const now = new Date();
    const result = await sweepApprovalSlaBreaches(config, now);

    expect(result.fired).toBe(1);
    expect(emissionCount("approval.sla_breach", approvalId)).toBe(1);

    const runs = getRunsForWorkflow(workflow.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
  });

  it("dedup: re-running the sweep does not fire again", async () => {
    const { tenantId, companyId } = seedTenant("SLA-B");
    ensureExampleFixtures(tenantId, companyId);

    installNativeAutomationTemplate("approval-sla-watchdog", { tenantId, companyId });

    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    insertApproval(tenantId, staleTime);

    const now = new Date();
    const first = await sweepApprovalSlaBreaches(config, now);
    expect(first.fired).toBe(1);

    const second = await sweepApprovalSlaBreaches(config, now);
    expect(second.fired).toBe(0);
  });

  it("does not fire for a fresh (non-stale) pending approval", async () => {
    const { tenantId, companyId } = seedTenant("SLA-C");
    ensureExampleFixtures(tenantId, companyId);

    installNativeAutomationTemplate("approval-sla-watchdog", { tenantId, companyId });

    // created_at only 1 hour ago — well within the 24-hr SLA
    const freshTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    insertApproval(tenantId, freshTime);

    const result = await sweepApprovalSlaBreaches(config, new Date());
    expect(result.fired).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// sweepStuckIssues
// ---------------------------------------------------------------------------

describe("sweepStuckIssues", () => {
  it("fires once for a stale in_progress assigned issue; workflow run is created", async () => {
    const { tenantId, companyId } = seedTenant("STUCK-A");
    ensureExampleFixtures(tenantId, companyId);

    const workflow = installNativeAutomationTemplate("issue-stuck-escalator", {
      tenantId,
      companyId,
    });

    // updated_at 5 hours ago (past the default 4-hr threshold)
    const staleTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const issueId = insertIssue({
      tenantId,
      companyId,
      status: "in_progress",
      assigneeAgentId: EXAMPLE_AGENT_ID,
      updatedAt: staleTime,
    });

    const now = new Date();
    const result = await sweepStuckIssues(config, now);

    expect(result.fired).toBe(1);
    expect(emissionCount("issue.stuck", issueId)).toBe(1);

    const runs = getRunsForWorkflow(workflow.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
  });

  it("dedup: re-running the sweep does not fire again", async () => {
    const { tenantId, companyId } = seedTenant("STUCK-B");
    ensureExampleFixtures(tenantId, companyId);

    installNativeAutomationTemplate("issue-stuck-escalator", { tenantId, companyId });

    const staleTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    insertIssue({
      tenantId,
      companyId,
      status: "in_progress",
      assigneeAgentId: EXAMPLE_AGENT_ID,
      updatedAt: staleTime,
    });

    const now = new Date();
    const first = await sweepStuckIssues(config, now);
    expect(first.fired).toBe(1);

    const second = await sweepStuckIssues(config, now);
    expect(second.fired).toBe(0);
  });

  it("does not fire for a recently-updated issue", async () => {
    const { tenantId, companyId } = seedTenant("STUCK-C");
    ensureExampleFixtures(tenantId, companyId);

    installNativeAutomationTemplate("issue-stuck-escalator", { tenantId, companyId });

    // updated_at only 1 hour ago — within the 4-hr threshold
    const recentTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    insertIssue({
      tenantId,
      companyId,
      status: "in_progress",
      assigneeAgentId: EXAMPLE_AGENT_ID,
      updatedAt: recentTime,
    });

    const result = await sweepStuckIssues(config, new Date());
    expect(result.fired).toBe(0);
  });

  it("does not fire for an unassigned stale issue", async () => {
    const { tenantId, companyId } = seedTenant("STUCK-D");
    ensureExampleFixtures(tenantId, companyId);

    installNativeAutomationTemplate("issue-stuck-escalator", { tenantId, companyId });

    const staleTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    insertIssue({
      tenantId,
      companyId,
      status: "in_progress",
      assigneeAgentId: null, // no assignee
      updatedAt: staleTime,
    });

    const result = await sweepStuckIssues(config, new Date());
    expect(result.fired).toBe(0);
  });

  it("also fires for blocked status (not just in_progress)", async () => {
    const { tenantId, companyId } = seedTenant("STUCK-E");
    ensureExampleFixtures(tenantId, companyId);

    installNativeAutomationTemplate("issue-stuck-escalator", { tenantId, companyId });

    const staleTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    insertIssue({
      tenantId,
      companyId,
      status: "blocked",
      assigneeAgentId: EXAMPLE_AGENT_ID,
      updatedAt: staleTime,
    });

    const result = await sweepStuckIssues(config, new Date());
    expect(result.fired).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Episode-level dedup: recovered subjects can re-breach
// ---------------------------------------------------------------------------

describe("sweepApprovalSlaBreaches — episode dedup", () => {
  it("fires once while in breach; after approval resolved emission row is deleted", async () => {
    const { tenantId, companyId } = seedTenant("SLA-EP-A");
    ensureExampleFixtures(tenantId, companyId);
    installNativeAutomationTemplate("approval-sla-watchdog", { tenantId, companyId });

    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const approvalId = insertApproval(tenantId, staleTime);

    const now = new Date();
    const first = await sweepApprovalSlaBreaches(config, now);
    expect(first.fired).toBe(1);
    expect(emissionCount("approval.sla_breach", approvalId)).toBe(1);

    // Resolve the approval — mark it approved so it leaves the breach set.
    getSqlite()
      .prepare("UPDATE approval_queue SET status = 'approved', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), approvalId);

    // Next sweep should remove the emission row for the resolved approval.
    const second = await sweepApprovalSlaBreaches(config, now);
    expect(second.fired).toBe(0);
    expect(emissionCount("approval.sla_breach", approvalId)).toBe(0);
  });

  it("re-breach fires again after recovery", async () => {
    const { tenantId, companyId } = seedTenant("SLA-EP-B");
    ensureExampleFixtures(tenantId, companyId);
    installNativeAutomationTemplate("approval-sla-watchdog", { tenantId, companyId });

    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const approvalId = insertApproval(tenantId, staleTime);

    const now = new Date();

    // First breach: fires.
    const first = await sweepApprovalSlaBreaches(config, now);
    expect(first.fired).toBe(1);

    // Resolve the approval.
    getSqlite()
      .prepare("UPDATE approval_queue SET status = 'approved', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), approvalId);

    // Sweep clears the emission row.
    await sweepApprovalSlaBreaches(config, now);
    expect(emissionCount("approval.sla_breach", approvalId)).toBe(0);

    // Simulate a new breach: re-insert a new pending approval with an old created_at.
    const newApprovalId = insertApproval(tenantId, staleTime);

    // Should fire for the new (re-breach) approval.
    const reBreachResult = await sweepApprovalSlaBreaches(config, now);
    expect(reBreachResult.fired).toBe(1);
    expect(emissionCount("approval.sla_breach", newApprovalId)).toBe(1);
  });

  it("persistently-breaching approval fires only once across N sweeps", async () => {
    const { tenantId, companyId } = seedTenant("SLA-EP-C");
    ensureExampleFixtures(tenantId, companyId);
    installNativeAutomationTemplate("approval-sla-watchdog", { tenantId, companyId });

    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const approvalId = insertApproval(tenantId, staleTime);

    const now = new Date();
    const first = await sweepApprovalSlaBreaches(config, now);
    expect(first.fired).toBe(1);

    // Multiple re-sweeps: approval stays pending and stale.
    for (let i = 0; i < 3; i++) {
      const result = await sweepApprovalSlaBreaches(config, now);
      expect(result.fired).toBe(0);
    }

    // Emission row persists throughout — no duplicate fires.
    expect(emissionCount("approval.sla_breach", approvalId)).toBe(1);
  });
});

describe("sweepStuckIssues — episode dedup", () => {
  it("fires once while stuck; after recovery emission row is deleted", async () => {
    const { tenantId, companyId } = seedTenant("STUCK-EP-A");
    ensureExampleFixtures(tenantId, companyId);
    installNativeAutomationTemplate("issue-stuck-escalator", { tenantId, companyId });

    const staleTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const issueId = insertIssue({
      tenantId,
      companyId,
      status: "in_progress",
      assigneeAgentId: EXAMPLE_AGENT_ID,
      updatedAt: staleTime,
    });

    const now = new Date();
    const first = await sweepStuckIssues(config, now);
    expect(first.fired).toBe(1);
    expect(emissionCount("issue.stuck", issueId)).toBe(1);

    // Issue recovers — mark it done.
    getSqlite()
      .prepare("UPDATE execution_issues SET status = 'done', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), issueId);

    // Next sweep removes the emission row for the recovered issue.
    const second = await sweepStuckIssues(config, now);
    expect(second.fired).toBe(0);
    expect(emissionCount("issue.stuck", issueId)).toBe(0);
  });

  it("re-stuck issue fires again after recovery", async () => {
    const { tenantId, companyId } = seedTenant("STUCK-EP-B");
    ensureExampleFixtures(tenantId, companyId);
    installNativeAutomationTemplate("issue-stuck-escalator", { tenantId, companyId });

    const staleTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const issueId = insertIssue({
      tenantId,
      companyId,
      status: "in_progress",
      assigneeAgentId: EXAMPLE_AGENT_ID,
      updatedAt: staleTime,
    });

    const now = new Date();

    // First breach fires.
    const first = await sweepStuckIssues(config, now);
    expect(first.fired).toBe(1);

    // Issue recovers.
    getSqlite()
      .prepare("UPDATE execution_issues SET status = 'done', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), issueId);

    // Sweep clears the emission row.
    await sweepStuckIssues(config, now);
    expect(emissionCount("issue.stuck", issueId)).toBe(0);

    // Issue goes stuck again: revert to in_progress with the old stale updated_at.
    getSqlite()
      .prepare("UPDATE execution_issues SET status = 'in_progress', updated_at = ? WHERE id = ?")
      .run(staleTime, issueId);

    // Re-breach fires again.
    const reBreachResult = await sweepStuckIssues(config, now);
    expect(reBreachResult.fired).toBe(1);
    expect(emissionCount("issue.stuck", issueId)).toBe(1);
  });

  it("persistently-stuck issue fires only once across N sweeps", async () => {
    const { tenantId, companyId } = seedTenant("STUCK-EP-C");
    ensureExampleFixtures(tenantId, companyId);
    installNativeAutomationTemplate("issue-stuck-escalator", { tenantId, companyId });

    const staleTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const issueId = insertIssue({
      tenantId,
      companyId,
      status: "in_progress",
      assigneeAgentId: EXAMPLE_AGENT_ID,
      updatedAt: staleTime,
    });

    const now = new Date();
    const first = await sweepStuckIssues(config, now);
    expect(first.fired).toBe(1);

    // Multiple re-sweeps: issue stays stuck.
    for (let i = 0; i < 3; i++) {
      const result = await sweepStuckIssues(config, now);
      expect(result.fired).toBe(0);
    }

    // Emission row persists — no duplicate fires.
    expect(emissionCount("issue.stuck", issueId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe("tenant isolation", () => {
  it("stale approval for tenant A does not fire tenant B's watchdog", async () => {
    const tenantA = seedTenant("ISO-SLA-A");
    const tenantB = seedTenant("ISO-SLA-B");
    ensureExampleFixtures(tenantA.tenantId, tenantA.companyId);
    ensureExampleFixtures(tenantB.tenantId, tenantB.companyId);

    const wfA = installNativeAutomationTemplate("approval-sla-watchdog", {
      tenantId: tenantA.tenantId,
      companyId: tenantA.companyId,
    });
    const wfB = installNativeAutomationTemplate("approval-sla-watchdog", {
      tenantId: tenantB.tenantId,
      companyId: tenantB.companyId,
    });

    // Insert stale approval only for tenant A
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    insertApproval(tenantA.tenantId, staleTime);

    const result = await sweepApprovalSlaBreaches(config, new Date());
    expect(result.fired).toBe(1);

    // Tenant A gets a run; tenant B does not
    const runsA = getRunsForWorkflow(wfA.id);
    const runsB = getRunsForWorkflow(wfB.id);
    expect(runsA.length).toBeGreaterThanOrEqual(1);
    expect(runsB).toHaveLength(0);
  });

  it("stale issue for tenant A does not fire tenant B's escalator", async () => {
    const tenantA = seedTenant("ISO-STUCK-A");
    const tenantB = seedTenant("ISO-STUCK-B");
    ensureExampleFixtures(tenantA.tenantId, tenantA.companyId);
    ensureExampleFixtures(tenantB.tenantId, tenantB.companyId);

    const wfA = installNativeAutomationTemplate("issue-stuck-escalator", {
      tenantId: tenantA.tenantId,
      companyId: tenantA.companyId,
    });
    const wfB = installNativeAutomationTemplate("issue-stuck-escalator", {
      tenantId: tenantB.tenantId,
      companyId: tenantB.companyId,
    });

    const staleTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    insertIssue({
      tenantId: tenantA.tenantId,
      companyId: tenantA.companyId,
      status: "in_progress",
      assigneeAgentId: EXAMPLE_AGENT_ID,
      updatedAt: staleTime,
    });

    const result = await sweepStuckIssues(config, new Date());
    expect(result.fired).toBe(1);

    const runsA = getRunsForWorkflow(wfA.id);
    const runsB = getRunsForWorkflow(wfB.id);
    expect(runsA.length).toBeGreaterThanOrEqual(1);
    expect(runsB).toHaveLength(0);
  });
});
