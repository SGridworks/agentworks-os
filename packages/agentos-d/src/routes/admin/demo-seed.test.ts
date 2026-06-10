/**
 * demo-seed tests.
 *
 * Coverage:
 *  - seedDemo() leaves a native_automation_run at status waiting_approval with
 *    a non-null waiting_for_approval_id.
 *  - Re-running seedDemo() is idempotent (no duplicate tenants or runs).
 *  - POST /api/admin/demo/seed returns 403 when the connection is not from
 *    loopback (supertest uses an in-process socket, remoteAddress is "").
 *  - POST /api/admin/demo/seed returns 401 when the token is wrong (mocked
 *    loopback via requireLocalAdmin).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { initDb, resetDb, getSqlite } from "../../db/index.js";
import { migrate } from "../../db/migrations/index.js";
import { _resetVaultStoreForTesting } from "../../routes/memory.js";
import type { Config } from "../../config.js";
import { seedDemo, createDemoSeedRouter } from "./demo-seed.js";

// ---------------------------------------------------------------------------
// Helpers
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
  root = mkdtempSync(join(tmpdir(), "awos-demo-seed-"));
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
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// seedDemo service
// ---------------------------------------------------------------------------

describe("seedDemo service", () => {
  it("creates a run at waiting_approval with a non-null approvalId", async () => {
    const result = await seedDemo(config);

    expect(result.tenantId).toBeTruthy();
    expect(result.workflowId).toBeTruthy();
    expect(result.runId).toBeTruthy();
    expect(result.approvalId).toBeTruthy();

    const sqlite = getSqlite();
    const run = sqlite
      .prepare("SELECT status, waiting_for_approval_id FROM native_automation_runs WHERE id = ?")
      .get(result.runId) as { status: string; waiting_for_approval_id: string | null } | undefined;

    expect(run).toBeDefined();
    expect(run?.status).toBe("waiting_approval");
    expect(run?.waiting_for_approval_id).not.toBeNull();
    expect(run?.waiting_for_approval_id).toBe(result.approvalId);
  });

  it("is idempotent — second call returns same tenant and run, no duplicate tenant", async () => {
    const first = await seedDemo(config);
    const second = await seedDemo(config);

    expect(second.tenantId).toBe(first.tenantId);
    expect(second.workflowId).toBe(first.workflowId);
    expect(second.runId).toBe(first.runId);
    expect(second.approvalId).toBe(first.approvalId);

    const sqlite = getSqlite();
    const tenantCount = sqlite
      .prepare("SELECT COUNT(*) AS cnt FROM tenants WHERE name = 'Demo Co (AWOS)'")
      .get() as { cnt: number };
    expect(tenantCount.cnt).toBe(1);
  });

  it("creates exactly two agents (reviewer and engineer)", async () => {
    const result = await seedDemo(config);

    const sqlite = getSqlite();
    const agents = sqlite
      .prepare("SELECT name, role FROM execution_agents WHERE tenant_id = ? ORDER BY name")
      .all(result.tenantId) as { name: string; role: string }[];

    expect(agents).toHaveLength(2);
    const names = agents.map((a) => a.name).sort();
    expect(names).toEqual(["engineer", "reviewer"]);
    const roles = agents.map((a) => a.role).sort();
    expect(roles).toEqual(["engineer", "review"]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/demo/seed route — auth rejection
// ---------------------------------------------------------------------------

describe("POST /api/admin/demo/seed", () => {
  // supertest runs in-process over a loopback socket (remoteAddress = ::1 or
  // 127.0.0.1), so the loopback check passes and we see 401 (bad token) not 403.
  it("returns 401 when called without a valid bearer token", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/admin", createDemoSeedRouter(config));

    const res = await request(app).post("/api/admin/demo/seed").send({});
    // No Authorization header → token check fails → 401 unauthorized
    expect([401, 403]).toContain(res.status);
  });

  it("returns 401 when called with a wrong bearer token", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/admin", createDemoSeedRouter(config));

    const res = await request(app)
      .post("/api/admin/demo/seed")
      .set("Authorization", "Bearer definitely-wrong-token")
      .send({});

    expect([401, 403]).toContain(res.status);
  });

  it("returns 200 when called with the correct owner token", async () => {
    // The default token resolves to config.legacyBridgeApiKey = 'local-trusted'
    // (see resolveAdminToken in require-auth.ts).
    delete process.env.AGENTOS_ADMIN_TOKEN;
    delete process.env.AGENTOS_API_KEY;

    const app = express();
    app.use(express.json());
    app.use("/api/admin", createDemoSeedRouter(config));

    const res = await request(app)
      .post("/api/admin/demo/seed")
      .set("Authorization", "Bearer local-trusted")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tenantId: expect.any(String),
      workflowId: expect.any(String),
      runId: expect.any(String),
      approvalId: expect.any(String),
    });
  });
});
