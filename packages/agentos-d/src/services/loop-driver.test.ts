/**
 * Unit tests for loop-driver.ts.
 *
 * Coverage:
 * - onApprovalResolved: resumes matching waiting_approval run; no-match is no-op.
 * - onDispatchResolved: resumes matching waiting_dispatch run; no-match is no-op.
 * - reconcileWaitingRuns: resumes an orphaned waiting run after restart.
 * - double-trigger (inline hook + reconciler) executes the workflow exactly once.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { initDb, resetDb, getSqlite } from "../db/index.js";
import { migrate } from "../db/migrations/index.js";
import { _resetVaultStoreForTesting } from "../routes/memory.js";
import {
  createNativeAutomationWorkflow,
  runNativeAutomationWorkflow,
  getNativeAutomationRun,
} from "./native-automations.js";
import { onApprovalResolved, onDispatchResolved, reconcileWaitingRuns } from "./loop-driver.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000011";
const COMPANY_ID = "00000000-0000-4000-8000-000000000012";

let root: string;
let config: Config;
let previousVaultRoot: string | undefined;

function makeConfig(dataDir: string): Config {
  return {
    companyId: COMPANY_ID,
    logLevel: "silent",
    dataDir,
    legacyBridgeUrl: "http://127.0.0.1:3100",
    legacyBridgeApiKey: "test",
    legacyBridgeEnabled: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Config;
}

function approvalWaitWorkflow() {
  return createNativeAutomationWorkflow({
    tenantId: TENANT_ID,
    companyId: COMPANY_ID,
    name: "Loop driver approval test",
    trigger: "manual",
    status: "active",
    definition: {
      trigger: "manual",
      steps: [
        {
          id: "gate",
          name: "Approval gate",
          type: "approval.wait",
          params: {
            proposedActionKind: "workflow.test",
            proposedActionSummary: "Loop driver test approval",
            decisionReason: "Testing",
          },
        },
        {
          id: "after",
          name: "After approval",
          type: "data.set",
          params: { value: { continued: true } },
        },
      ],
    },
  });
}

function dispatchWaitWorkflow(targetAgentId: string) {
  return createNativeAutomationWorkflow({
    tenantId: TENANT_ID,
    companyId: COMPANY_ID,
    name: "Loop driver dispatch test",
    trigger: "manual",
    status: "active",
    definition: {
      trigger: "manual",
      steps: [
        {
          id: "dispatch",
          name: "Dispatch step",
          type: "handoff.contract",
          params: {
            taskKind: "workflow.handoff",
            targetAgentId,
            contract: { objective: "Loop driver test dispatch" },
            waitForCompletion: true,
          },
        },
        {
          id: "after",
          name: "After dispatch",
          type: "data.set",
          params: { value: { dispatched: true } },
        },
      ],
    },
  });
}

describe("loop-driver", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "awos-loop-driver-"));
    config = makeConfig(join(root, "data"));
    previousVaultRoot = process.env.VAULT_ROOT;
    process.env.VAULT_ROOT = join(root, "vault");
    _resetVaultStoreForTesting();
    initDb({ config, migrations: migrate });
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
  // onApprovalResolved
  // ---------------------------------------------------------------------------

  it("onApprovalResolved resumes a waiting_approval run and advances it", async () => {
    const workflow = approvalWaitWorkflow();
    const waiting = await runNativeAutomationWorkflow(workflow.id, {}, config);
    expect(waiting.status).toBe("waiting_approval");
    const approvalId = waiting.waitingForApprovalId!;
    expect(approvalId).toBeTruthy();

    // Simulate the approval_queue row being updated to 'approved' (approval-queue
    // route does this before calling onApprovalResolved in production).
    const sqlite = getSqlite();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `UPDATE approval_queue SET status = 'approved', reviewed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, now, approvalId);

    await onApprovalResolved(approvalId, "approved", { reviewedBy: "test-user" }, config);

    const resumed = getNativeAutomationRun(waiting.id)!;
    expect(resumed.status).toBe("succeeded");
    expect(resumed.steps.find((s) => s.id === "gate")?.status).toBe("succeeded");
    expect(resumed.steps.find((s) => s.id === "after")?.status).toBe("succeeded");
  });

  it("onApprovalResolved with decision=rejected terminates the run without advancing", async () => {
    const workflow = approvalWaitWorkflow();
    const waiting = await runNativeAutomationWorkflow(workflow.id, {}, config);
    expect(waiting.status).toBe("waiting_approval");
    const approvalId = waiting.waitingForApprovalId!;

    const sqlite = getSqlite();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `UPDATE approval_queue SET status = 'rejected', reviewed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, now, approvalId);

    await onApprovalResolved(approvalId, "rejected", { reviewedBy: "test-user" }, config);

    const resumed = getNativeAutomationRun(waiting.id)!;
    expect(resumed.status).toBe("failed");
    expect(resumed.steps.find((s) => s.id === "after")).toBeUndefined();
  });

  it("onApprovalResolved with unknown approvalId is a no-op", async () => {
    // Should not throw and should not touch any runs
    await expect(
      onApprovalResolved("nonexistent-approval-id", "approved", {}, config),
    ).resolves.toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // onDispatchResolved
  // ---------------------------------------------------------------------------

  it("onDispatchResolved with unknown dispatchId is a no-op", async () => {
    await expect(
      onDispatchResolved("nonexistent-dispatch-id", "completed", config),
    ).resolves.toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // reconcileWaitingRuns
  // ---------------------------------------------------------------------------

  it("reconcileWaitingRuns resumes an orphaned waiting_approval run", async () => {
    const workflow = approvalWaitWorkflow();
    const waiting = await runNativeAutomationWorkflow(workflow.id, {}, config);
    expect(waiting.status).toBe("waiting_approval");
    const approvalId = waiting.waitingForApprovalId!;

    // Simulate the approval being stamped approved (as if the daemon restarted
    // and the inline hook never fired).
    const sqlite = getSqlite();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `UPDATE approval_queue SET status = 'approved', reviewed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, now, approvalId);

    // The run is still parked — no inline hook was called.
    expect(getNativeAutomationRun(waiting.id)!.status).toBe("waiting_approval");

    const result = await reconcileWaitingRuns(config);
    expect(result.resumed).toBe(1);
    expect(result.failed).toBe(0);

    const reconciled = getNativeAutomationRun(waiting.id)!;
    expect(reconciled.status).toBe("succeeded");
  });

  it("reconcileWaitingRuns returns {resumed:0, failed:0} when nothing is orphaned", async () => {
    const result = await reconcileWaitingRuns(config);
    expect(result).toEqual({ resumed: 0, failed: 0 });
  });

  // ---------------------------------------------------------------------------
  // Double-trigger safety: inline hook + reconciler = executes exactly once
  // ---------------------------------------------------------------------------

  it("double-trigger (onApprovalResolved + reconcileWaitingRuns) executes workflow exactly once", async () => {
    const workflow = approvalWaitWorkflow();
    const waiting = await runNativeAutomationWorkflow(workflow.id, {}, config);
    expect(waiting.status).toBe("waiting_approval");
    const approvalId = waiting.waitingForApprovalId!;

    const sqlite = getSqlite();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `UPDATE approval_queue SET status = 'approved', reviewed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, now, approvalId);

    // Fire both concurrently — atomic claim ensures only one wins.
    await Promise.all([
      onApprovalResolved(approvalId, "approved", {}, config),
      reconcileWaitingRuns(config),
    ]);

    const run = getNativeAutomationRun(waiting.id)!;
    // Status must be 'succeeded', not 'running' or anything duplicated.
    expect(run.status).toBe("succeeded");

    // Confirm the "after" step ran exactly once.
    const afterSteps = run.steps.filter((s) => s.id === "after");
    expect(afterSteps).toHaveLength(1);
    expect(afterSteps[0]?.status).toBe("succeeded");
  });
});
