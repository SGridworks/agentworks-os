/**
 * Unit tests for GET /api/admin/autopilot endpoint.
 */

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { initDb } from "../db/index.js";
import { migrate } from "../db/migrations/index.js";
import type { Config } from "../config.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeConfig(): Config {
  const tmpDir = mkdtempSync(join(tmpdir(), "awo-autopilot-smoke-test-"));
  return {
    companyId: "00000000-0000-4000-8000-000000000001",
    logLevel: "silent",
    sessionSecret: "test-secret",
    listenPort: 0,
    vaultDir: join(tmpDir, "vault"),
    dataDir: join(tmpDir, "data"),
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

describe("GET /api/admin/autopilot - smoke test", () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;

  beforeAll(() => {
    const config = makeConfig();
    tmpDir = config.dataDir;
    initDb({ config, migrations: migrate });
    app = createApp(config);
  });

  afterAll(() => {
    // Clean up temporary directory
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should return 400 when tenantId is missing", async () => {
    const res = await request(app).get("/api/admin/autopilot");
    
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("tenantId required");
  });

  it("should return 200 when tenantId is provided", async () => {
    const res = await request(app).get("/api/admin/autopilot?tenantId=test-tenant-id");
    
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("safe");
    expect(res.body).toHaveProperty("needsApproval");
    expect(res.body).toHaveProperty("risky");
    expect(res.body).toHaveProperty("summary");
    expect(res.body).toHaveProperty("generatedAt");
  });

  it("should return correct structure with all required fields", async () => {
    const res = await request(app).get("/api/admin/autopilot?tenantId=test-tenant-id");
    
    expect(res.status).toBe(200);
    const body = res.body;
    
    // Check main counts
    expect(typeof body.safe).toBe("number");
    expect(typeof body.needsApproval).toBe("number");
    expect(typeof body.risky).toBe("number");
    expect(body.safe + body.needsApproval + body.risky).toBeGreaterThanOrEqual(0);
    
    // Check summary structure
    expect(body.summary).toHaveProperty("triageIssues");
    expect(body.summary).toHaveProperty("approvalQueue");
    expect(body.summary).toHaveProperty("dispatchQueue");
    expect(body.summary).toHaveProperty("recentDecisions");
    
    // Check all summary fields are numbers
    expect(typeof body.summary.triageIssues).toBe("number");
    expect(typeof body.summary.approvalQueue).toBe("number");
    expect(typeof body.summary.dispatchQueue).toBe("number");
    expect(typeof body.summary.recentDecisions).toBe("number");
    
    // Check generatedAt is ISO string
    expect(typeof body.generatedAt).toBe("string");
    expect(() => new Date(body.generatedAt)).not.toThrow();
  });

  it("should handle empty tenant gracefully", async () => {
    const fakeTenantId = "00000000-0000-0000-0000-000000000000";
    const res = await request(app).get(`/api/admin/autopilot?tenantId=${fakeTenantId}`);
    
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.safe).toBe(0);
    expect(body.needsApproval).toBe(0);
    expect(body.risky).toBe(0);
    expect(body.summary.triageIssues).toBe(0);
    expect(body.summary.approvalQueue).toBe(0);
    expect(body.summary.dispatchQueue).toBe(0);
    expect(body.summary.recentDecisions).toBe(0);
  });
});
