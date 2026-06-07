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
