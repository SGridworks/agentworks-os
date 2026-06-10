/**
 * Unit tests for workflow-events.ts — fireWorkflowEvent.
 *
 * Coverage:
 * - triggers only active + matching event_kind + same-tenant workflows
 * - ignores paused workflows (wrong status)
 * - ignores workflows with a different event_kind
 * - ignores workflows belonging to a different tenant
 * - returns the triggered workflow IDs
 * - a throwing run does not abort sibling dispatches (error isolation)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { initDb, resetDb, getSqlite } from "../db/index.js";
import { migrate } from "../db/migrations/index.js";
import { _resetVaultStoreForTesting } from "../routes/memory.js";
import { createNativeAutomationWorkflow } from "./native-automations.js";
import { fireWorkflowEvent } from "./workflow-events.js";

const TENANT_A = "00000000-0000-4000-8000-aaaaaaaaaaaa";
const TENANT_B = "00000000-0000-4000-8000-bbbbbbbbbbbb";
const COMPANY_A = "00000000-0000-4000-8000-cccccccccccc";
const COMPANY_B = "00000000-0000-4000-8000-dddddddddddd";

let root: string;
let config: Config;
let previousVaultRoot: string | undefined;

function makeConfig(dataDir: string): Config {
  return {
    companyId: COMPANY_A,
    logLevel: "silent",
    dataDir,
    legacyBridgeUrl: "http://127.0.0.1:3100",
    legacyBridgeApiKey: "test",
    legacyBridgeEnabled: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Config;
}

function makeEventWorkflow(opts: {
  tenantId: string;
  companyId: string;
  eventKind: string;
  status: "active" | "paused";
}) {
  return createNativeAutomationWorkflow({
    tenantId: opts.tenantId,
    companyId: opts.companyId,
    name: `Event workflow (${opts.eventKind})`,
    trigger: "event",
    eventKind: opts.eventKind,
    status: opts.status,
    definition: {
      trigger: "event",
      steps: [
        {
          id: "noop",
          name: "No-op step",
          type: "data.set",
          params: { value: { triggered: true } },
        },
      ],
    },
  });
}

describe("fireWorkflowEvent", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "awos-workflow-events-"));
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
    vi.restoreAllMocks();
  });

  it("triggers an active matching workflow and returns its id", async () => {
    const wf = makeEventWorkflow({
      tenantId: TENANT_A,
      companyId: COMPANY_A,
      eventKind: "scanner.finding",
      status: "active",
    });

    const result = await fireWorkflowEvent(
      "scanner.finding",
      { finding: { id: "f1", severity: "high", title: "Test" } },
      { tenantId: TENANT_A },
      config,
    );

    expect(result.triggered).toContain(wf.id);
    expect(result.triggered).toHaveLength(1);
  });

  it("does not trigger a paused workflow", async () => {
    makeEventWorkflow({
      tenantId: TENANT_A,
      companyId: COMPANY_A,
      eventKind: "scanner.finding",
      status: "paused",
    });

    const result = await fireWorkflowEvent(
      "scanner.finding",
      { finding: { id: "f2", severity: "high", title: "Test" } },
      { tenantId: TENANT_A },
      config,
    );

    expect(result.triggered).toHaveLength(0);
  });

  it("does not trigger a workflow with a different event_kind", async () => {
    makeEventWorkflow({
      tenantId: TENANT_A,
      companyId: COMPANY_A,
      eventKind: "other.event",
      status: "active",
    });

    const result = await fireWorkflowEvent(
      "scanner.finding",
      { finding: { id: "f3", severity: "high", title: "Test" } },
      { tenantId: TENANT_A },
      config,
    );

    expect(result.triggered).toHaveLength(0);
  });

  it("does not trigger a workflow belonging to a different tenant", async () => {
    makeEventWorkflow({
      tenantId: TENANT_B,
      companyId: COMPANY_B,
      eventKind: "scanner.finding",
      status: "active",
    });

    const result = await fireWorkflowEvent(
      "scanner.finding",
      { finding: { id: "f4", severity: "high", title: "Test" } },
      { tenantId: TENANT_A },
      config,
    );

    expect(result.triggered).toHaveLength(0);
  });

  it("triggers all matching active workflows and returns all their ids", async () => {
    const wf1 = makeEventWorkflow({
      tenantId: TENANT_A,
      companyId: COMPANY_A,
      eventKind: "scanner.finding",
      status: "active",
    });
    const wf2 = makeEventWorkflow({
      tenantId: TENANT_A,
      companyId: COMPANY_A,
      eventKind: "scanner.finding",
      status: "active",
    });
    // paused — should not trigger
    makeEventWorkflow({
      tenantId: TENANT_A,
      companyId: COMPANY_A,
      eventKind: "scanner.finding",
      status: "paused",
    });

    const result = await fireWorkflowEvent(
      "scanner.finding",
      { finding: { id: "f5", severity: "critical", title: "Multi test" } },
      { tenantId: TENANT_A },
      config,
    );

    expect(result.triggered).toHaveLength(2);
    expect(result.triggered).toContain(wf1.id);
    expect(result.triggered).toContain(wf2.id);
  });

  it("a throwing run does not abort sibling dispatches", async () => {
    // Create two active matching workflows. We simulate a run failure for wfBad
    // by deleting its row from the DB right after the fireWorkflowEvent SELECT
    // snapshot is taken but before the run loop executes. We achieve this via
    // a SQLite UPDATE trigger that changes wfBad's id to a sentinel AFTER the
    // first read, which is not possible with standard SQLite. Instead we use
    // the simpler approach: insert wfBad as a raw row that satisfies the SELECT
    // filter but whose id won't be found by runNativeAutomationWorkflow because
    // we DELETE it immediately after creating it, then re-insert a stub at the
    // DB level with the original id deleted, making the dispatcher SELECT return
    // the id but the run find no row (workflow_not_found). This is achievable:
    //
    // 1. Create wfBad normally (creates workflow + version rows).
    // 2. Note its id.
    // 3. DELETE its native_automation_workflow_versions rows.
    // 4. DELETE its native_automation_workflows row.
    // 5. Re-insert wfBad with the SAME id via raw SQL with status='active' and
    //    event_kind='scanner.finding' AND tenant_id=TENANT_A, but WITHOUT the
    //    trigger_kind='event' change needed (we need all SELECT fields to match).
    //    Since we deleted it and re-inserted it without version rows, the SELECT
    //    returns it, but runNativeAutomationWorkflow calls ensureMappedWorkflowVersion
    //    which calls ensureWorkflowVersion (INSERT OR IGNORE = no error) and then
    //    the run proceeds normally. So this doesn't throw either.
    //
    // The ONLY way to get workflow_not_found is to delete the row AFTER the
    // SELECT inside fireWorkflowEvent but BEFORE the SELECT inside
    // runNativeAutomationWorkflow. Since both are synchronous reads of the same
    // in-process DB, we would need to intercept between them.
    //
    // PRAGMATIC SOLUTION: test the error-isolation property by directly calling
    // the underlying logic. We create a minimal test helper that exercises the
    // same for/try/catch loop as fireWorkflowEvent using an in-memory array,
    // verifying that one thrown item doesn't abort the others. This is redundant
    // with reading the source, so instead we assert via the DB manipulation
    // that IS possible: make a workflow that will throw by ensuring
    // executeWorkflowRun fails due to a FK violation on the run INSERT.
    //
    // The native_automation_runs INSERT has: workflow_id TEXT NOT NULL
    // REFERENCES native_automation_workflows(id) ON DELETE CASCADE.
    // If we delete wfBad from native_automation_workflows AFTER the SELECT
    // inside runNativeAutomationWorkflow finds it (line: `if (!workflowRow)`)
    // but BEFORE the INSERT into native_automation_runs...
    // Again impossible to synchronise.
    //
    // FINAL PRACTICAL ANSWER: use getSqlite() to install a SQLite AFTER INSERT
    // trigger on native_automation_runs that raises an error when run.workflow_id
    // = wfBad.id. This is doable with "SELECT RAISE(ABORT, 'test_failure')".

    const wfGood = makeEventWorkflow({
      tenantId: TENANT_A,
      companyId: COMPANY_A,
      eventKind: "scanner.finding",
      status: "active",
    });

    const wfBad = makeEventWorkflow({
      tenantId: TENANT_A,
      companyId: COMPANY_A,
      eventKind: "scanner.finding",
      status: "active",
    });

    // Install a BEFORE INSERT trigger on native_automation_runs that raises
    // an abort error when the workflow_id matches wfBad.id. This simulates
    // a DB-level failure mid-run and is the only reliable mock-free way to
    // inject a per-workflow error inside the run loop.
    getSqlite().exec(`
      CREATE TEMP TRIGGER trig_fail_bad_workflow
      BEFORE INSERT ON native_automation_runs
      WHEN NEW.workflow_id = '${wfBad.id}'
      BEGIN
        SELECT RAISE(ABORT, 'test_simulated_run_failure');
      END;
    `);

    const result = await fireWorkflowEvent(
      "scanner.finding",
      { finding: { id: "f6", severity: "high", title: "Sibling test" } },
      { tenantId: TENANT_A },
      config,
    );

    // Drop the trigger to avoid affecting subsequent tests in this describe block.
    getSqlite().exec("DROP TRIGGER IF EXISTS trig_fail_bad_workflow;");

    // wfBad's run threw (trigger abort); wfGood's run succeeded.
    expect(result.triggered).toContain(wfGood.id);
    expect(result.triggered).not.toContain(wfBad.id);
    expect(result.triggered).toHaveLength(1);
  });

  it("returns empty triggered list when no matching workflows exist", async () => {
    const result = await fireWorkflowEvent(
      "scanner.finding",
      { finding: { id: "f7", severity: "high", title: "No match" } },
      { tenantId: TENANT_A },
      config,
    );

    expect(result.triggered).toHaveLength(0);
  });
});
