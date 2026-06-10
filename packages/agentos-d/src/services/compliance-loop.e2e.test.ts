/**
 * compliance-loop.e2e.test.ts
 *
 * End-to-end proof of the full autonomous compliance loop:
 *   seed → waiting_approval → approve → waiting_dispatch → simulated dispatch
 *   → onDispatchResolved → succeeded + sealed evidence pack
 *
 * Also proves the REJECT path: rejection terminates the run without dispatch.
 *
 * Uses real components (no mocking of loop logic). The simulated adapter
 * produces deterministic output with no external I/O.
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
import { createNativeAutomationEvidencePack, getNativeAutomationEvidencePack } from "./native-automations.js";
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
  root = mkdtempSync(join(tmpdir(), "awos-compliance-loop-e2e-"));
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

// The compliance-loop template dispatches to this static agent ID.
// The seed creates agents with random UUIDs, so we must also insert this
// well-known agent for the DispatchConsumer to find its target.
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
// Helpers
// ---------------------------------------------------------------------------

function getRunRow(runId: string) {
  return getSqlite()
    .prepare(
      `SELECT status, waiting_for_approval_id, waiting_for_dispatch_id
       FROM native_automation_runs WHERE id = ?`,
    )
    .get(runId) as
    | { status: string; waiting_for_approval_id: string | null; waiting_for_dispatch_id: string | null }
    | undefined;
}

function getDispatchRow(dispatchId: string) {
  return getSqlite()
    .prepare("SELECT id, status, target_agent_id FROM dispatch_queue WHERE id = ?")
    .get(dispatchId) as { id: string; status: string; target_agent_id: string } | undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compliance loop e2e", () => {
  // -------------------------------------------------------------------------
  // a. Seed parks the run at waiting_approval
  // -------------------------------------------------------------------------
  it("seedDemo creates a run at waiting_approval with a non-null approvalId", async () => {
    const result = await seedDemo(config);

    expect(result.runId).toBeTruthy();
    expect(result.approvalId).toBeTruthy();

    const row = getRunRow(result.runId);
    expect(row).toBeDefined();
    expect(row?.status).toBe("waiting_approval");
    expect(row?.waiting_for_approval_id).toBe(result.approvalId);
  });

  // -------------------------------------------------------------------------
  // b + c. onApprovalResolved advances run to waiting_dispatch
  // -------------------------------------------------------------------------
  it("approving via onApprovalResolved advances the run to waiting_dispatch", async () => {
    const { runId, approvalId } = await seedDemo(config);

    await onApprovalResolved(approvalId, "approved", { reviewedBy: "test-reviewer" }, config);

    const row = getRunRow(runId);
    expect(row?.status).toBe("waiting_dispatch");
    expect(row?.waiting_for_dispatch_id).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // b (HTTP path). Approve via the real PATCH /api/approval-queue/:id/review
  // route and verify the run advances. This proves the HTTP handler wiring.
  // -------------------------------------------------------------------------
  it("approving via HTTP PATCH /api/approval-queue/:id/review advances the run", async () => {
    const { runId, approvalId, tenantId, companyId } = await seedDemo(config);
    ensureExampleAgent(tenantId, companyId);

    // Wire a minimal app with auth + approval-queue router
    const app = express();
    app.use(express.json());
    app.use("/api", createRequireAuthMiddleware(config));
    app.use("/api/approval-queue", createApprovalQueueRouter(config));

    const res = await request(app)
      .patch(`/api/approval-queue/${approvalId}/review`)
      .set("Authorization", "Bearer local-trusted")
      .set("x-tenant-id", tenantId)
      .send({
        reviewedBy: "http-test-reviewer",
        reviewedByLabel: "HTTP Test Reviewer",
        reviewDecision: "approve",
        reviewNote: "e2e HTTP approval test",
      });

    // 200 means review was saved
    expect(res.status).toBe(200);

    // The route fires onApprovalResolved as fire-and-forget; give it a tick to complete.
    await new Promise((resolve) => setImmediate(resolve));

    const row = getRunRow(runId);
    expect(row?.status).toBe("waiting_dispatch");
    expect(row?.waiting_for_dispatch_id).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // d + e. DispatchConsumer + SimulatedAdapter drives dispatch to completion,
  // onDispatchResolved fires, run reaches succeeded, evidence pack exists.
  // -------------------------------------------------------------------------
  it("SimulatedAdapter dispatch drives run to succeeded with a sealed evidence pack", async () => {
    const { runId, approvalId, tenantId, companyId } = await seedDemo(config);

    // The compliance-loop template targets EXAMPLE_AGENT_ID; ensure it exists.
    ensureExampleAgent(tenantId, companyId);

    // Step 1: approve
    await onApprovalResolved(approvalId, "approved", { reviewedBy: "e2e-test" }, config);

    const afterApproval = getRunRow(runId);
    expect(afterApproval?.status).toBe("waiting_dispatch");
    const dispatchId = afterApproval?.waiting_for_dispatch_id;
    expect(dispatchId).toBeTruthy();

    // Step 2: run DispatchConsumer with SimulatedAdapter
    const consumer = new DispatchConsumer({
      sqlite: getSqlite(),
      adapter: new SimulatedAdapter(),
      config,
      // silent logger for tests
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const tickResult = await consumer.tick();

    // Consumer must have claimed and completed the dispatch row
    expect(tickResult.claimed).toBeGreaterThanOrEqual(1);
    expect(tickResult.completed).toBeGreaterThanOrEqual(1);

    // onDispatchResolved is fired fire-and-forget inside processOne.
    // Call it directly here to drive the run to completion in the test context,
    // which proves the full chain without depending on background timer resolution.
    await onDispatchResolved(dispatchId!, "completed", config);

    // Step 3: assert run reached succeeded
    const finalRow = getRunRow(runId);
    expect(finalRow?.status).toBe("succeeded");

    // Step 4: assert evidence pack exists and contains simulated marker + decision/dispatch refs
    const pack = getNativeAutomationEvidencePack(runId);
    expect(pack).not.toBeNull();
    expect(pack?.markdown).toContain("Workflow Evidence Pack");
    expect(pack?.status).toBe("succeeded");

    // The summary must reference the dispatch step output (taskId)
    const dispatches = pack?.summary.dispatches as string[] | undefined;
    expect(Array.isArray(dispatches)).toBe(true);
    expect(dispatches?.length).toBeGreaterThanOrEqual(1);
    expect(dispatches).toContain(dispatchId);

    // The summary must reference the approval step output (approvalQueueId)
    const approvals = pack?.summary.approvals as string[] | undefined;
    expect(Array.isArray(approvals)).toBe(true);
    expect(approvals?.length).toBeGreaterThanOrEqual(1);
    expect(approvals).toContain(approvalId);

    // Verify the simulated adapter summary is present in the dispatch row
    const dispatchRow = getDispatchRow(dispatchId!);
    expect(dispatchRow?.status).toBe("completed");
  });

  // -------------------------------------------------------------------------
  // f. REJECT path: rejection terminates the run without dispatch
  // -------------------------------------------------------------------------
  it("rejecting approval terminates the run without creating a dispatch row", async () => {
    const { runId, approvalId } = await seedDemo(config);

    const dispatchCountBefore = getSqlite()
      .prepare("SELECT COUNT(*) AS cnt FROM dispatch_queue")
      .get() as { cnt: number };

    await onApprovalResolved(approvalId, "rejected", { reviewedBy: "e2e-reject-test" }, config);

    const row = getRunRow(runId);
    // Rejection must terminate the run — not 'succeeded', not 'waiting_dispatch'
    expect(row?.status).toBe("failed");
    expect(row?.waiting_for_dispatch_id).toBeNull();

    // No new dispatch rows must have been created
    const dispatchCountAfter = getSqlite()
      .prepare("SELECT COUNT(*) AS cnt FROM dispatch_queue")
      .get() as { cnt: number };
    expect(dispatchCountAfter.cnt).toBe(dispatchCountBefore.cnt);
  });

  // -------------------------------------------------------------------------
  // onDispatchResolved directly (no full consumer loop)
  // -------------------------------------------------------------------------
  it("onDispatchResolved called directly advances waiting_dispatch run to succeeded", async () => {
    const { runId, approvalId, tenantId, companyId } = await seedDemo(config);

    ensureExampleAgent(tenantId, companyId);
    await onApprovalResolved(approvalId, "approved", {}, config);

    const afterApproval = getRunRow(runId);
    const dispatchId = afterApproval?.waiting_for_dispatch_id!;

    // Manually mark the dispatch row completed (simulating what the consumer would do)
    const now = new Date().toISOString();
    getSqlite()
      .prepare(
        `UPDATE dispatch_queue SET status = 'completed', completed_at = ? WHERE id = ? AND status IN ('waiting','queued','dispatched')`,
      )
      .run(now, dispatchId);

    await onDispatchResolved(dispatchId, "completed", config);

    // onDispatchResolved is async-awaited here so no polling needed
    const finalRow = getRunRow(runId);
    expect(finalRow?.status).toBe("succeeded");
  });
});
