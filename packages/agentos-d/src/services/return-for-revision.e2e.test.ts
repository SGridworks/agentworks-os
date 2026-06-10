/**
 * return-for-revision.e2e.test.ts
 *
 * End-to-end proof of the return_to_author loop:
 *   seed → waiting_approval → return → waiting_revision → resubmit
 *   → waiting_approval (fresh approval) → approve → dispatch (simulated)
 *   → onDispatchResolved → succeeded + sealed evidence pack
 *
 * Five proofs:
 *   1. Return parks run in waiting_revision (not failed/succeeded).
 *   2. Resubmit creates a fresh pending approval and re-parks at waiting_approval.
 *   3. Approve-after-resubmit drives the run through dispatch to succeeded + evidence.
 *   4. HTTP return path (PATCH /api/approval-queue/:id/review with return_to_author).
 *   5. Resubmit guard: resubmit on a non-waiting_revision run is a no-op.
 *
 * Uses real components. No mocking of loop logic. SimulatedAdapter for dispatch.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import type { Config } from "../config.js";
import { initDb, resetDb, getSqlite } from "../db/index.js";
import { migrate } from "../db/migrations/index.js";
import { _resetVaultStoreForTesting } from "../routes/memory.js";
import { seedDemo } from "../routes/admin/demo-seed.js";
import { onApprovalResolved, onDispatchResolved } from "./loop-driver.js";
import { getNativeAutomationEvidencePack } from "./native-automations.js";
import { resubmitNativeAutomationRun } from "./native-automations.js";
import { DispatchConsumer } from "./dispatch-consumer.js";
import { SimulatedAdapter } from "../adapters/simulated-adapter.js";
import { createApprovalQueueRouter } from "../routes/approval-queue.js";
import { createRequireAuthMiddleware } from "../middleware/require-auth.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let root: string;
let config: Config;
let previousVaultRoot: string | undefined;

function makeConfig(dataDir: string): Config {
  return {
    host: "127.0.0.1",
    port: 7710,
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
  root = mkdtempSync(join(tmpdir(), "awos-return-revision-e2e-"));
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

// The compliance-loop template targets this well-known agent ID.
const EXAMPLE_AGENT_ID = "00000000-0000-4000-8000-000000000004";

function ensureExampleAgent(tenantId: string, companyId: string): void {
  const sqlite = getSqlite();
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO execution_agents
       (id, tenant_id, company_id, name, role, status, config_json, created_at, updated_at)
       VALUES (?, ?, ?, 'example-agent', 'engineer', 'active', '{}', ?, ?)`,
    )
    .run(EXAMPLE_AGENT_ID, tenantId, companyId, now, now);
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

function getRunRow(runId: string) {
  return getSqlite()
    .prepare(
      `SELECT status, waiting_for_approval_id, waiting_for_dispatch_id, input_json
       FROM native_automation_runs WHERE id = ?`,
    )
    .get(runId) as
    | {
        status: string;
        waiting_for_approval_id: string | null;
        waiting_for_dispatch_id: string | null;
        input_json: string;
      }
    | undefined;
}

function getApprovalRow(approvalId: string) {
  return getSqlite()
    .prepare("SELECT id, status, review_note FROM approval_queue WHERE id = ?")
    .get(approvalId) as { id: string; status: string; review_note: string | null } | undefined;
}

function getDispatchRow(dispatchId: string) {
  return getSqlite()
    .prepare("SELECT id, status FROM dispatch_queue WHERE id = ?")
    .get(dispatchId) as { id: string; status: string } | undefined;
}

function getRunStepOutput(runId: string, stepIndex: number): Record<string, unknown> | null {
  const row = getSqlite()
    .prepare("SELECT output_json FROM native_automation_run_steps WHERE run_id = ? AND step_index = ?")
    .get(runId, stepIndex) as { output_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.output_json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function countApprovalRows(runId: string): number {
  // Count approval_queue rows referenced by this run's step output (the union of
  // waiting_for_approval_id across history is not directly stored; instead we count
  // pending+returned approvals linked in run_steps output for the approval step index).
  const rows = getSqlite()
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM native_automation_run_steps nars
       JOIN approval_queue aq
         ON json_extract(nars.output_json, '$.approvalQueueId') = aq.id
       WHERE nars.run_id = ?`,
    )
    .get(runId) as { cnt: number };
  return rows.cnt;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("return-for-revision e2e", () => {
  // -------------------------------------------------------------------------
  // Proof 1: return_to_author parks run in waiting_revision
  // -------------------------------------------------------------------------
  it("return via onApprovalResolved parks run in waiting_revision with reviewNote in step output", async () => {
    const { runId, approvalId } = await seedDemo(config);

    // Pre-condition: run is at waiting_approval
    const before = getRunRow(runId);
    expect(before?.status).toBe("waiting_approval");
    expect(before?.waiting_for_approval_id).toBe(approvalId);

    await onApprovalResolved(
      approvalId,
      "returned",
      { reviewedBy: "reviewer-1", reviewNote: "tighten the wording" },
      config,
    );

    // Run must be waiting_revision — not failed, not succeeded
    const after = getRunRow(runId);
    expect(after?.status).toBe("waiting_revision");

    // The original approval row must be 'returned'
    const approvalRow = getApprovalRow(approvalId);
    expect(approvalRow?.status).toBe("returned");

    // The approval step output must carry the reviewNote
    // approval step is index 1 in the compliance-loop (policy=0, approval=1, dispatch=2, evidence=3)
    const stepOutput = getRunStepOutput(runId, 1);
    expect(stepOutput).not.toBeNull();
    expect(stepOutput?.reviewNote).toBe("tighten the wording");
    expect(stepOutput?.revision).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Proof 2: resubmit creates a fresh pending approval and re-parks run
  // -------------------------------------------------------------------------
  it("resubmitNativeAutomationRun creates a fresh pending approval and moves run to waiting_approval", async () => {
    const { runId, approvalId } = await seedDemo(config);

    // Return first
    await onApprovalResolved(approvalId, "returned", { reviewNote: "needs revision" }, config);
    expect(getRunRow(runId)?.status).toBe("waiting_revision");

    // Resubmit with a revised input patch
    const revisedPatch = { revisedAt: "2026-06-10", revisedBy: "author-agent" };
    await resubmitNativeAutomationRun(runId, revisedPatch, config);

    const afterResubmit = getRunRow(runId);

    // Run must be waiting_approval again
    expect(afterResubmit?.status).toBe("waiting_approval");

    // Must have a NEW approval id (distinct from the returned one)
    const newApprovalId = afterResubmit?.waiting_for_approval_id;
    expect(newApprovalId).toBeTruthy();
    expect(newApprovalId).not.toBe(approvalId);

    // New approval must be pending
    const newApproval = getApprovalRow(newApprovalId!);
    expect(newApproval?.status).toBe("pending");

    // Input patch must be reflected in the run
    const storedInput = JSON.parse(afterResubmit?.input_json ?? "{}") as Record<string, unknown>;
    expect(storedInput.revisedAt).toBe("2026-06-10");
    expect(storedInput.revisedBy).toBe("author-agent");
  });

  // -------------------------------------------------------------------------
  // Proof 3: approve-after-resubmit drives run to succeeded + evidence pack
  // -------------------------------------------------------------------------
  it("approving after resubmit drives run through dispatch to succeeded with a sealed evidence pack", async () => {
    const { runId, approvalId, tenantId, companyId } = await seedDemo(config);
    ensureExampleAgent(tenantId, companyId);

    // Step 1: return
    await onApprovalResolved(approvalId, "returned", { reviewNote: "revise please" }, config);
    expect(getRunRow(runId)?.status).toBe("waiting_revision");

    // Step 2: resubmit
    await resubmitNativeAutomationRun(runId, { resubmitted: true }, config);
    const afterResubmit = getRunRow(runId);
    expect(afterResubmit?.status).toBe("waiting_approval");
    const newApprovalId = afterResubmit?.waiting_for_approval_id!;
    expect(newApprovalId).toBeTruthy();

    // Step 3: approve the NEW approval
    await onApprovalResolved(newApprovalId, "approved", { reviewedBy: "reviewer-2" }, config);

    const afterApprove = getRunRow(runId);
    expect(afterApprove?.status).toBe("waiting_dispatch");
    const dispatchId = afterApprove?.waiting_for_dispatch_id;
    expect(dispatchId).toBeTruthy();

    // Step 4: run DispatchConsumer with SimulatedAdapter
    const consumer = new DispatchConsumer({
      sqlite: getSqlite(),
      adapter: new SimulatedAdapter(),
      config,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const tickResult = await consumer.tick();
    expect(tickResult.claimed).toBeGreaterThanOrEqual(1);
    expect(tickResult.completed).toBeGreaterThanOrEqual(1);

    // Step 5: resolve dispatch
    await onDispatchResolved(dispatchId!, "completed", config);

    // Run must be succeeded
    const finalRow = getRunRow(runId);
    expect(finalRow?.status).toBe("succeeded");

    // Evidence pack must exist, be sealed, and reference dispatch + approval
    const pack = getNativeAutomationEvidencePack(runId);
    expect(pack).not.toBeNull();
    expect(pack?.status).toBe("succeeded");
    expect(pack?.markdown).toContain("Workflow Evidence Pack");

    const dispatches = pack?.summary.dispatches as string[] | undefined;
    expect(Array.isArray(dispatches)).toBe(true);
    expect(dispatches?.length).toBeGreaterThanOrEqual(1);
    expect(dispatches).toContain(dispatchId);

    const approvals = pack?.summary.approvals as string[] | undefined;
    expect(Array.isArray(approvals)).toBe(true);
    expect(approvals?.length).toBeGreaterThanOrEqual(1);
    // The NEW approval that was actually approved must be in the pack
    expect(approvals).toContain(newApprovalId);

    // Dispatch row must be completed
    expect(getDispatchRow(dispatchId!)?.status).toBe("completed");
  });

  // -------------------------------------------------------------------------
  // Proof 4: HTTP return path drives run to waiting_revision
  // -------------------------------------------------------------------------
  it("PATCH /api/approval-queue/:id/review with return_to_author advances run to waiting_revision", async () => {
    const { runId, approvalId, tenantId, companyId } = await seedDemo(config);
    ensureExampleAgent(tenantId, companyId);

    const app = express();
    app.use(express.json());
    app.use("/api", createRequireAuthMiddleware(config));
    app.use("/api/approval-queue", createApprovalQueueRouter(config));

    const res = await request(app)
      .patch(`/api/approval-queue/${approvalId}/review`)
      .set("Authorization", "Bearer local-trusted")
      .set("x-tenant-id", tenantId)
      .send({
        reviewedBy: "http-return-reviewer",
        reviewedByLabel: "HTTP Return Reviewer",
        reviewDecision: "return_to_author",
        reviewNote: "please revise the scope section",
      });

    // 200 = review was saved
    expect(res.status).toBe(200);

    // The approval row in the response body must show 'returned'
    expect(res.body.status).toBe("returned");

    // Fire-and-forget: give the async resume a tick to complete
    await new Promise((resolve) => setImmediate(resolve));

    // Run must be at waiting_revision
    const row = getRunRow(runId);
    expect(row?.status).toBe("waiting_revision");

    // The approval row in the DB must be 'returned'
    const approvalRow = getApprovalRow(approvalId);
    expect(approvalRow?.status).toBe("returned");
  });

  // -------------------------------------------------------------------------
  // Proof 5: resubmit guard — non-waiting_revision run is unchanged
  // -------------------------------------------------------------------------
  it("resubmitNativeAutomationRun on a waiting_approval run returns it unchanged with no new approval", async () => {
    const { runId, approvalId } = await seedDemo(config);

    // Run is waiting_approval — not waiting_revision
    expect(getRunRow(runId)?.status).toBe("waiting_approval");

    const approvalCountBefore = (
      getSqlite().prepare("SELECT COUNT(*) AS cnt FROM approval_queue").get() as { cnt: number }
    ).cnt;

    // Resubmit on a non-waiting_revision run must be a no-op
    const result = await resubmitNativeAutomationRun(runId, { shouldNotMatter: true }, config);

    // Run status unchanged
    expect(result.status).toBe("waiting_approval");
    expect(getRunRow(runId)?.status).toBe("waiting_approval");
    // Still waiting on the original approval
    expect(getRunRow(runId)?.waiting_for_approval_id).toBe(approvalId);

    // No new approval_queue rows created
    const approvalCountAfter = (
      getSqlite().prepare("SELECT COUNT(*) AS cnt FROM approval_queue").get() as { cnt: number }
    ).cnt;
    expect(approvalCountAfter).toBe(approvalCountBefore);
  });
});
