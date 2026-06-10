import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.js";
import type { Config } from "../config.js";
import { initDb, resetDb } from "../db/index.js";
import { migrate } from "../db/migrations/index.js";
import { _resetVaultStoreForTesting } from "./memory.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const COMPANY_ID = "00000000-0000-4000-8000-000000000002";

let root: string;
let app: ReturnType<typeof createApp>;
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

describe("admin automation workflow engine routes", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "awos-admin-automations-"));
    previousVaultRoot = process.env.VAULT_ROOT;
    process.env.VAULT_ROOT = join(root, "vault");
    _resetVaultStoreForTesting();
    const config = makeConfig(join(root, "data"));
    initDb({ config, migrations: migrate });
    app = createApp(config);
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

  it("exposes simulate, versions, run controls, and evidence pack endpoints", async () => {
    const create = await request(app)
      .post("/api/admin/automations/workflows")
      .send({
        tenantId: TENANT_ID,
        companyId: COMPANY_ID,
        name: "Route engine workflow",
        trigger: "manual",
        status: "active",
        definition: {
          trigger: "manual",
          steps: [
            {
              id: "set",
              name: "Set context",
              type: "data.set",
              params: { value: { ok: true } },
            },
          ],
        },
      });
    expect(create.status).toBe(201);
    expect(create.body.currentVersion).toBe(1);

    const workflowId = create.body.id as string;
    const simulation = await request(app)
      .post(`/api/admin/automations/workflows/${workflowId}/simulate`)
      .send({ input: { preview: true } });
    expect(simulation.status).toBe(201);
    expect(simulation.body.dryRun).toBe(true);
    expect(simulation.body.wouldRun).toHaveLength(1);

    const versions = await request(app).get(`/api/admin/automations/workflows/${workflowId}/versions`);
    expect(versions.status).toBe(200);
    expect(versions.body.items[0].version).toBe(1);

    const run = await request(app)
      .post(`/api/admin/automations/workflows/${workflowId}/run`)
      .send({ input: { route: true } });
    expect(run.status).toBe(201);
    expect(run.body.status).toBe("succeeded");
    expect(run.body.steps[0].stepIndex).toBe(0);

    const evidence = await request(app).post(`/api/admin/automations/runs/${run.body.id}/evidence-pack`).send({});
    expect(evidence.status).toBe(201);
    expect(evidence.body.markdown).toContain("Workflow Evidence Pack");

    const replay = await request(app)
      .post(`/api/admin/automations/runs/${run.body.id}/replay`)
      .send({ fromStepIndex: 0, inputOverride: { routeReplay: true } });
    expect(replay.status).toBe(201);
    expect(replay.body.replayOfRunId).toBe(run.body.id);
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/automations/runs/:id/resubmit
// ---------------------------------------------------------------------------

describe("POST /api/admin/automations/runs/:id/resubmit endpoint", () => {
  let root: string;
  let app: ReturnType<typeof createApp>;
  let previousVaultRoot: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "awos-resubmit-endpoint-"));
    previousVaultRoot = process.env.VAULT_ROOT;
    process.env.VAULT_ROOT = join(root, "vault");
    _resetVaultStoreForTesting();
    const config = makeConfig(join(root, "data"));
    initDb({ config, migrations: migrate });
    app = createApp(config);
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

  async function createApprovalWorkflow() {
    const res = await request(app)
      .post("/api/admin/automations/workflows")
      .send({
        tenantId: TENANT_ID,
        companyId: COMPANY_ID,
        name: "Resubmit endpoint workflow",
        trigger: "manual",
        status: "active",
        definition: {
          trigger: "manual",
          steps: [
            {
              id: "gate",
              name: "Gate",
              type: "approval.wait",
              params: { proposedActionSummary: "Approve this", proposedActionKind: "test.action" },
            },
            { id: "after", name: "After", type: "data.set", params: { value: { done: true } } },
          ],
        },
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it("409 when run is not in waiting_revision", async () => {
    const workflowId = await createApprovalWorkflow();
    const run = await request(app)
      .post(`/api/admin/automations/workflows/${workflowId}/run`)
      .send({ input: {} });
    expect(run.body.status).toBe("waiting_approval");

    const res = await request(app)
      .post(`/api/admin/automations/runs/${run.body.id}/resubmit`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_waiting_revision");
  });

  it("400 on invalid body", async () => {
    const workflowId = await createApprovalWorkflow();
    const run = await request(app)
      .post(`/api/admin/automations/workflows/${workflowId}/run`)
      .send({ input: {} });

    const res = await request(app)
      .post(`/api/admin/automations/runs/${run.body.id}/resubmit`)
      .send({ input: "not-an-object" });
    expect(res.status).toBe(400);
  });

  it("200 + run in waiting_approval after successful resubmit", async () => {
    const workflowId = await createApprovalWorkflow();
    const run = await request(app)
      .post(`/api/admin/automations/workflows/${workflowId}/run`)
      .send({ input: {} });
    expect(run.body.status).toBe("waiting_approval");
    const runId = run.body.id as string;

    // Park in waiting_revision via resume
    const resumed = await request(app)
      .post(`/api/admin/automations/runs/${runId}/resume`)
      .send({ input: { decision: "returned" } });
    expect(resumed.body.status).toBe("waiting_revision");

    // Resubmit
    const res = await request(app)
      .post(`/api/admin/automations/runs/${runId}/resubmit`)
      .send({ input: { revised: true } });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("waiting_approval");
    expect(res.body.waitingForApprovalId).not.toBe(run.body.waitingForApprovalId);
    expect(res.body.input.revised).toBe(true);
  });

  it("404 on unknown run id", async () => {
    const res = await request(app)
      .post("/api/admin/automations/runs/00000000-0000-4000-8000-nonexistent/resubmit")
      .send({});
    expect(res.status).toBe(404);
  });
});
