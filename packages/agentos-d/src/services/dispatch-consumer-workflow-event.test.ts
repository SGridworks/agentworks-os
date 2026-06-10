/**
 * Tests for dispatch.failed workflow event integration in DispatchConsumer.
 *
 * Verifies that a dispatch failure fires fireWorkflowEvent("dispatch.failed")
 * when an active `failed-dispatch-recovery` workflow exists for the tenant,
 * resulting in a workflow run being created.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { initDb, resetDb, getSqlite } from "../db/index.js";
import { migrate } from "../db/migrations/index.js";
import { _resetVaultStoreForTesting } from "../routes/memory.js";
import { createNativeAutomationWorkflow } from "./native-automations.js";
import { DispatchConsumer, type AgentAdapter } from "./dispatch-consumer.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

let root: string;
let config: Config;
let previousVaultRoot: string | undefined;

function makeConfig(dataDir: string): Config {
  return {
    companyId: COMPANY,
    logLevel: "silent",
    dataDir,
    legacyBridgeUrl: "http://127.0.0.1:3100",
    legacyBridgeApiKey: "test",
    legacyBridgeEnabled: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Config;
}

function seedAgent(id: string): void {
  const sqlite = getSqlite();
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO execution_companies
         (id, tenant_id, name, status, metadata_json, source, created_at, updated_at)
       VALUES (?, ?, 'TestCo', 'active', '{}', 'awos', ?, ?)`,
    )
    .run(COMPANY, TENANT, now, now);
  sqlite
    .prepare(
      `INSERT INTO execution_agents
         (id, tenant_id, company_id, name, role, status, config_json, adapter_type, model, created_at, updated_at)
       VALUES (?, ?, ?, 'Agent', 'BackendEngineer', 'active', '{}', NULL, 'kimi-k2', ?, ?)`,
    )
    .run(id, TENANT, COMPANY, now, now);
}

function enqueue(id: string, targetAgentId: string): void {
  const now = new Date().toISOString();
  getSqlite()
    .prepare(
      `INSERT INTO dispatch_queue
         (id, tenant_id, task_kind, target_agent_id, input, status, created_at)
       VALUES (?, ?, 'test.task', ?, '{}', 'queued', ?)`,
    )
    .run(id, TENANT, targetAgentId, now);
}

function createFailedDispatchRecoveryWorkflow(tenantId: string, companyId: string) {
  return createNativeAutomationWorkflow({
    tenantId,
    companyId,
    name: "failed-dispatch-recovery",
    trigger: "event",
    eventKind: "dispatch.failed",
    status: "active",
    definition: {
      trigger: "event",
      steps: [
        {
          id: "create-issue",
          name: "Create recovery issue",
          type: "issue.create",
          params: { title: "Dispatch failed", description: "Recovery triggered." },
        },
      ],
    },
  });
}

function countRunsForWorkflow(workflowId: string): number {
  const row = getSqlite()
    .prepare("SELECT COUNT(*) AS c FROM native_automation_runs WHERE workflow_id = ?")
    .get(workflowId) as { c: number };
  return row.c;
}

describe("dispatch.failed workflow event", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "awos-dc-wf-event-"));
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

  it("fires a workflow run when an active failed-dispatch-recovery workflow exists for the tenant", async () => {
    const agentId = "aaaaaaaa-1111-1111-1111-000000000001";
    seedAgent(agentId);
    enqueue("d-fail-evt", agentId);

    const wf = createFailedDispatchRecoveryWorkflow(TENANT, COMPANY);

    const failing: AgentAdapter = {
      async run() {
        return { status: "failed", error: "adapter intentional failure" };
      },
    };

    const consumer = new DispatchConsumer({
      sqlite: getSqlite(),
      adapter: failing,
      config,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const result = await consumer.tick();
    expect(result.failed).toBe(1);

    // fireWorkflowEvent is fire-and-forget; give the microtask queue a tick.
    await new Promise((resolve) => setImmediate(resolve));

    const runCount = countRunsForWorkflow(wf.id);
    expect(runCount).toBe(1);
  });

  it("does not create a run when no failed-dispatch-recovery workflow exists", async () => {
    const agentId = "aaaaaaaa-1111-1111-1111-000000000002";
    seedAgent(agentId);
    enqueue("d-fail-no-wf", agentId);

    const failing: AgentAdapter = {
      async run() {
        return { status: "failed", error: "no workflow configured" };
      },
    };

    const consumer = new DispatchConsumer({
      sqlite: getSqlite(),
      adapter: failing,
      config,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const result = await consumer.tick();
    expect(result.failed).toBe(1);

    await new Promise((resolve) => setImmediate(resolve));

    const totalRuns = (
      getSqlite()
        .prepare("SELECT COUNT(*) AS c FROM native_automation_runs")
        .get() as { c: number }
    ).c;
    expect(totalRuns).toBe(0);
  });

  it("does not fire the event on a successful dispatch", async () => {
    const agentId = "aaaaaaaa-1111-1111-1111-000000000003";
    seedAgent(agentId);
    enqueue("d-success-no-evt", agentId);

    const wf = createFailedDispatchRecoveryWorkflow(TENANT, COMPANY);

    // default stub adapter always succeeds
    const consumer = new DispatchConsumer({
      sqlite: getSqlite(),
      config,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const result = await consumer.tick();
    expect(result.completed).toBe(1);

    await new Promise((resolve) => setImmediate(resolve));

    const runCount = countRunsForWorkflow(wf.id);
    expect(runCount).toBe(0);
  });

  it("does not emit without config (config omitted)", async () => {
    const agentId = "aaaaaaaa-1111-1111-1111-000000000004";
    seedAgent(agentId);
    enqueue("d-no-config", agentId);

    const wf = createFailedDispatchRecoveryWorkflow(TENANT, COMPANY);

    const failing: AgentAdapter = {
      async run() {
        return { status: "failed", error: "config absent" };
      },
    };

    // consumer created without config — event should not fire (guard in processOne)
    const consumer = new DispatchConsumer({
      sqlite: getSqlite(),
      adapter: failing,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const result = await consumer.tick();
    expect(result.failed).toBe(1);

    await new Promise((resolve) => setImmediate(resolve));

    const runCount = countRunsForWorkflow(wf.id);
    expect(runCount).toBe(0);
  });
});
