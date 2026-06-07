import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { Config } from "../config.js";
import { getSqlite, initDb, resetDb } from "../db/client.js";
import { migrate } from "../db/migrations/index.js";

let dataDir: string;
let app: ReturnType<typeof createApp>;

function testConfig(): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    logLevel: "warn",
    awcpVersion: "awcp/v0.1",
    dataDir,
    scannerSidecarUrl: "http://127.0.0.1:0",
    scannerPollIntervalMs: 30_000,
    auditLogRetentionDays: 30,
  };
}

describe("execution compatibility routes", () => {
  beforeEach(() => {
    resetDb();
    dataDir = mkdtempSync(join(tmpdir(), "awo-execution-compat-"));
    initDb({ config: testConfig(), migrations: migrate });
    app = createApp(testConfig());
  });

  afterEach(() => {
    resetDb();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns a single company from GET /api/companies/:companyId", async () => {
    const tenantId = randomUUID();
    const company = await request(app)
      .post("/api/companies")
      .send({ tenantId, name: "E2E Company" })
      .expect(201);

    const res = await request(app).get(`/api/companies/${company.body.id}`).expect(200);

    expect(res.body).toMatchObject({
      id: company.body.id,
      tenantId,
      name: "E2E Company",
      status: "active",
    });
  });

  it("creates issues through POST /api/issues when companyId is in the body", async () => {
    const tenantId = randomUUID();
    const company = await request(app)
      .post("/api/companies")
      .send({ tenantId, name: "E2E Company" })
      .expect(201);
    const project = await request(app)
      .post(`/api/companies/${company.body.id}/projects`)
      .send({ tenantId, name: "E2E Project" })
      .expect(201);

    const created = await request(app)
      .post("/api/issues")
      .send({
        tenantId,
        companyId: company.body.id,
        projectId: project.body.id,
        title: "E2E-LOCAL-GATEWAY top-level issue create",
        description: "Created through compatibility route",
        priority: "low",
      })
      .expect(201);

    expect(created.body).toMatchObject({
      tenantId,
      companyId: company.body.id,
      projectId: project.body.id,
      title: "E2E-LOCAL-GATEWAY top-level issue create",
      status: "todo",
      priority: "low",
    });

    const row = getSqlite()
      .prepare("SELECT * FROM execution_issues WHERE id = ?")
      .get(created.body.id) as { company_id: string; title: string } | undefined;
    expect(row).toMatchObject({
      company_id: company.body.id,
      title: "E2E-LOCAL-GATEWAY top-level issue create",
    });
  });
});
