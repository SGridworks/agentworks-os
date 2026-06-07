import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { initDb, resetDb } from "../db/index.js";
import { getSqlite } from "../db/index.js";
import { migrate } from "../db/migrations/index.js";
import { _resetVaultStoreForTesting } from "../routes/memory.js";
import {
  createNativeAutomationEvidencePack,
  createNativeAutomationTemplate,
  createNativeAutomationWorkflow,
  createWorkflowSelfHealProposal,
  installNativeAutomationTemplate,
  listNativeAutomationWorkflowVersions,
  listNativeAutomationRuns,
  listNativeAutomationTemplates,
  listNativeAutomationWorkflows,
  replayNativeAutomationRun,
  resumeNativeAutomationRun,
  runNativeAutomationWorkflow,
  simulateNativeAutomationWorkflow,
  updateNativeAutomationWorkflow,
} from "./native-automations.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const COMPANY_ID = "1c626d50-0698-46d9-aed5-aed0df87dced";

let root: string;
let config: Config;
let previousVaultRoot: string | undefined;

function makeConfig(dataDir: string): Config {
  return {
    companyId: COMPANY_ID,
    logLevel: "silent",
    sessionSecret: "test-secret",
    listenPort: 0,
    vaultDir: join(dataDir, "vault"),
    dataDir,
    legacyBridgeUrl: "http://127.0.0.1:3100",
    legacyBridgeApiKey: "test",
    legacyBridgeEnabled: false,
    jwtSecret: "test",
    googleClientId: "",
    googleClientSecret: "",
    redirectUrl: "",
    allowedOrigins: ["http://localhost:3000"],
    costMeterUrl: "",
    costMeterApiKey: "",
  };
}

describe("native automations", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "awos-native-automations-"));
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

  it("installs a template once and marks it installed", () => {
    const workflow = installNativeAutomationTemplate("vault-intake", {
      tenantId: TENANT_ID,
      companyId: COMPANY_ID,
    });

    const second = installNativeAutomationTemplate("vault-intake", {
      tenantId: TENANT_ID,
      companyId: COMPANY_ID,
    });

    expect(second.id).toBe(workflow.id);
    expect(listNativeAutomationWorkflows(COMPANY_ID)).toHaveLength(1);
    expect(listNativeAutomationTemplates(COMPANY_ID).find((t) => t.id === "vault-intake")?.status).toBe(
      "installed",
    );
  });

  it("runs an installed vault-intake workflow and records step history", async () => {
    const workflow = installNativeAutomationTemplate("vault-intake", {
      tenantId: TENANT_ID,
      companyId: COMPANY_ID,
    });

    const run = await runNativeAutomationWorkflow(workflow.id, { source: "test" }, config);

    expect(run.status).toBe("succeeded");
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]?.type).toBe("vault.write");
    expect(run.steps[0]?.status).toBe("succeeded");
    expect(listNativeAutomationRuns(COMPANY_ID, 5)[0]?.id).toBe(run.id);
  });

  it("creates custom templates and managed workflows inside AWOS", () => {
    const definition = {
      trigger: "manual" as const,
      steps: [
        {
          id: "intake",
          name: "Intake webhook",
          type: "webhook.intake" as const,
          params: {},
        },
      ],
    };

    const template = createNativeAutomationTemplate({
      tenantId: TENANT_ID,
      companyId: COMPANY_ID,
      name: "Custom Intake Template",
      trigger: "manual",
      description: "Custom operator-created template",
      definition,
    });
    const workflow = createNativeAutomationWorkflow({
      tenantId: TENANT_ID,
      companyId: COMPANY_ID,
      name: "Custom Intake Workflow",
      trigger: "manual",
      description: "Custom operator-created workflow",
      definition,
      status: "paused",
    });

    expect(template.source).toBe("custom");
    expect(listNativeAutomationTemplates(COMPANY_ID).some((t) => t.id === template.id)).toBe(true);
    expect(workflow.status).toBe("paused");
    expect(listNativeAutomationWorkflows(COMPANY_ID).some((w) => w.id === workflow.id)).toBe(true);
  });

  it("records workflow versions and durable checkpoint rows", async () => {
    const workflow = createNativeAutomationWorkflow({
      tenantId: TENANT_ID,
      companyId: COMPANY_ID,
      name: "Versioned workflow",
      trigger: "manual",
      status: "active",
      definition: {
        trigger: "manual",
        steps: [
          {
            id: "set",
            name: "Set data",
            type: "data.set",
            params: { value: { ok: true } },
          },
        ],
      },
    });

    expect(workflow.currentVersion).toBe(1);
    const updated = updateNativeAutomationWorkflow(workflow.id, {
      definition: {
        trigger: "manual",
        steps: [
          ...workflow.definition.steps,
          {
            id: "evidence",
            name: "Pack evidence",
            type: "evidence.pack",
            params: {},
          },
        ],
      },
    });

    expect(updated.currentVersion).toBe(2);
    expect(listNativeAutomationWorkflowVersions(workflow.id).map((version) => version.version)).toEqual([2, 1]);

    const run = await runNativeAutomationWorkflow(workflow.id, { source: "test" }, config);
    const checkpointCount = getSqlite()
      .prepare("SELECT COUNT(*) AS count FROM native_automation_run_steps WHERE run_id = ?")
      .get(run.id) as { count: number };
    expect(run.workflowVersionId).toBeTruthy();
    expect(checkpointCount.count).toBe(2);
  });

  it("pauses on approval.wait and resumes after approval", async () => {
    const workflow = createNativeAutomationWorkflow({
      tenantId: TENANT_ID,
      companyId: COMPANY_ID,
      name: "Approval wait workflow",
      trigger: "manual",
      status: "active",
      definition: {
        trigger: "manual",
        steps: [
          {
            id: "approval",
            name: "Wait for approval",
            type: "approval.wait",
            params: {
              proposedActionKind: "workflow.approval",
              proposedActionSummary: "Approve continuation",
              decisionReason: "Test approval gate",
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

    const waiting = await runNativeAutomationWorkflow(workflow.id, {}, config);
    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.waitingForApprovalId).toBeTruthy();
    expect(waiting.steps[0]?.status).toBe("waiting_approval");

    const resumed = await resumeNativeAutomationRun(waiting.id, { decision: "approved" }, config);
    expect(resumed.status).toBe("succeeded");
    expect(resumed.steps.map((step) => step.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("simulates side-effect steps without creating approval or dispatch rows", async () => {
    const workflow = createNativeAutomationWorkflow({
      tenantId: TENANT_ID,
      companyId: COMPANY_ID,
      name: "Dry-run workflow",
      trigger: "manual",
      status: "active",
      definition: {
        trigger: "manual",
        steps: [
          {
            id: "approval",
            name: "Approval",
            type: "approval.wait",
            params: { proposedActionSummary: "Preview approval" },
          },
          {
            id: "dispatch",
            name: "Dispatch",
            type: "handoff.contract",
            params: {
              taskKind: "workflow.handoff",
              targetAgentId: "agent-1",
              contract: { objective: "Preview handoff" },
            },
          },
        ],
      },
    });

    const simulation = await simulateNativeAutomationWorkflow(workflow.id, { preview: true }, config);
    const approvalCount = getSqlite().prepare("SELECT COUNT(*) AS count FROM approval_queue").get() as { count: number };
    const dispatchCount = getSqlite().prepare("SELECT COUNT(*) AS count FROM dispatch_queue").get() as { count: number };

    expect(simulation.dryRun).toBe(true);
    expect(simulation.sideEffectsSuppressed).toEqual(["approval:approval.wait", "dispatch:handoff.contract"]);
    expect(approvalCount.count).toBe(0);
    expect(dispatchCount.count).toBe(0);
  });

  it("replays a run from a checkpoint and records replay provenance", async () => {
    const workflow = createNativeAutomationWorkflow({
      tenantId: TENANT_ID,
      companyId: COMPANY_ID,
      name: "Replay workflow",
      trigger: "manual",
      status: "active",
      definition: {
        trigger: "manual",
        steps: [
          { id: "first", name: "First", type: "data.set", params: { value: { first: true } } },
          { id: "second", name: "Second", type: "data.set", params: { value: { second: true } } },
        ],
      },
    });
    const original = await runNativeAutomationWorkflow(workflow.id, { original: true }, config);

    const replay = await replayNativeAutomationRun(original.id, 1, { replayed: true }, config);

    expect(replay.replayOfRunId).toBe(original.id);
    expect(replay.replayFromStepIndex).toBe(1);
    expect(replay.steps[0]?.status).toBe("skipped");
    expect(replay.steps[1]?.status).toBe("succeeded");
  });

  it("creates evidence packs and self-heal proposals without mutating workflow definitions", async () => {
    const workflow = createNativeAutomationWorkflow({
      tenantId: TENANT_ID,
      companyId: COMPANY_ID,
      name: "Evidence workflow",
      trigger: "manual",
      status: "active",
      definition: {
        trigger: "manual",
        steps: [{ id: "set", name: "Set", type: "data.set", params: { value: { ok: true } } }],
      },
    });
    const run = await runNativeAutomationWorkflow(workflow.id, {}, config);

    const pack = createNativeAutomationEvidencePack(run.id);
    const beforeHash = listNativeAutomationWorkflows(COMPANY_ID).find((item) => item.id === workflow.id)?.definitionHash;
    const proposal = createWorkflowSelfHealProposal(workflow.id);
    const afterHash = listNativeAutomationWorkflows(COMPANY_ID).find((item) => item.id === workflow.id)?.definitionHash;

    expect(pack.markdown).toContain("Workflow Evidence Pack");
    expect(proposal).toMatchObject({ workflowId: workflow.id, proposal: { silentMutation: false } });
    expect(afterHash).toBe(beforeHash);
  });
});
