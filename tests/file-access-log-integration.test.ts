import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../packages/agentos-d/src/app.js";
import { initDb, resetDb, getSqlite } from "../packages/agentos-d/src/db/client.js";
import { migrate } from "../packages/agentos-d/src/db/migrations/index.js";

let dataDir: string;

describe("File Access Log Integration", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    resetDb();
    dataDir = mkdtempSync(join(tmpdir(), "awo-file-access-integration-"));
    initDb({
      config: {
        host: "127.0.0.1",
        port: 0,
        logLevel: "warn",
        awcpVersion: "awcp/v0.1",
        dataDir,
        scannerSidecarUrl: "http://127.0.0.1:0",
        scannerPollIntervalMs: 30_000,
        auditLogRetentionDays: 30,
      },
      migrations: migrate,
    });
    app = createApp({
      host: "127.0.0.1",
      port: 0,
      logLevel: "warn",
      awcpVersion: "awcp/v0.1",
      dataDir,
      scannerSidecarUrl: "http://127.0.0.1:0",
      scannerPollIntervalMs: 30_000,
      auditLogRetentionDays: 30,
    });
  });

  afterEach(() => {
    resetDb();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("should create company, agent, and log file access in a complete workflow", async () => {
    const sqlite = getSqlite();

    // Step 1: Create a company
    const tenantId = randomUUID();
    const companyRes = await request(app)
      .post("/api/companies")
      .send({
        tenantId,
        name: "Test Company",
        slug: "test-company",
      });

    expect(companyRes.status).toBe(201);
    const companyId = companyRes.body.id;

    // Step 2: Create an agent
    const agentRes = await request(app)
      .post("/api/agents")
      .send({
        tenantId,
        companyId,
        name: "Test Agent",
        role: "developer",
        status: "active",
      });

    expect(agentRes.status).toBe(201);
    const agentId = agentRes.body.id;

    // Step 3: Post runtime state with file operations
    const runId = randomUUID();
    const runtimeRes = await request(app)
      .post(`/api/agents/${agentId}/runtime-state`)
      .send({
        sessionId: "test-session-123",
        lastRunId: runId,
        lastRunStatus: "succeeded",
        lastRunAt: new Date().toISOString(),
        totalInputTokens: 100,
        totalOutputTokens: 200,
        filesTouched: [
          { path: "/workspace/project/src/main.ts", op: "write" },
          { path: "/workspace/project/package.json", op: "read" },
          { path: "/workspace/project/README.md", op: "create" },
        ],
      });

    expect(runtimeRes.status).toBe(200);

    // Step 4: Verify file access log entries
    const logs = sqlite.prepare(`
      SELECT * FROM file_access_log
      WHERE tenant_id = ? AND agent_id = ? AND run_id = ?
      ORDER BY file_path
    `).all(tenantId, agentId, runId);

    expect(logs).toHaveLength(3);
    expect(logs[0]).toMatchObject({
      tenant_id: tenantId,
      agent_id: agentId,
      run_id: runId,
      file_path: "/workspace/project/README.md",
      op: "create",
    });
    expect(logs[1]).toMatchObject({
      tenant_id: tenantId,
      agent_id: agentId,
      run_id: runId,
      file_path: "/workspace/project/package.json",
      op: "read",
    });
    expect(logs[2]).toMatchObject({
      tenant_id: tenantId,
      agent_id: agentId,
      run_id: runId,
      file_path: "/workspace/project/src/main.ts",
      op: "write",
    });

    // Step 5: Verify we can query file access by tenant
    const tenantLogs = sqlite.prepare(`
      SELECT * FROM file_access_log
      WHERE tenant_id = ?
      ORDER BY created_at DESC
    `).all(tenantId);

    expect(tenantLogs).toHaveLength(3);

    // Step 6: Verify we can query file access by agent
    const agentLogs = sqlite.prepare(`
      SELECT * FROM file_access_log
      WHERE agent_id = ?
      ORDER BY created_at DESC
    `).all(agentId);

    expect(agentLogs).toHaveLength(3);

    // Step 7: Verify we can query file access by file path
    const fileLogs = sqlite.prepare(`
      SELECT * FROM file_access_log
      WHERE file_path = ?
    `).all("/workspace/project/src/main.ts");

    expect(fileLogs).toHaveLength(1);
    expect(fileLogs[0]).toMatchObject({
      tenant_id: tenantId,
      agent_id: agentId,
      run_id: runId,
      file_path: "/workspace/project/src/main.ts",
      op: "write",
    });
  });

  it("should handle multiple runtime state updates with different file operations", async () => {
    const sqlite = getSqlite();

    // Create company and agent
    const tenantId = randomUUID();
    const companyRes = await request(app)
      .post("/api/companies")
      .send({ tenantId, name: "Test Company" });
    const companyId = companyRes.body.id;

    const agentRes = await request(app)
      .post("/api/agents")
      .send({ tenantId, companyId, name: "Test Agent" });
    const agentId = agentRes.body.id;

    // First runtime state update
    const runId1 = randomUUID();
    await request(app)
      .post(`/api/agents/${agentId}/runtime-state`)
      .send({
        sessionId: "session-1",
        lastRunId: runId1,
        lastRunStatus: "succeeded",
        lastRunAt: new Date().toISOString(),
        filesTouched: [
          { path: "/tmp/file1.txt", op: "write" },
        ],
      });

    // Second runtime state update
    const runId2 = randomUUID();
    await request(app)
      .post(`/api/agents/${agentId}/runtime-state`)
      .send({
        sessionId: "session-2",
        lastRunId: runId2,
        lastRunStatus: "failed",
        lastRunAt: new Date().toISOString(),
        filesTouched: [
          { path: "/tmp/file2.txt", op: "read" },
          { path: "/tmp/file3.txt", op: "delete" },
        ],
      });

    // Verify all file access logs
    const allLogs = sqlite.prepare(`
      SELECT * FROM file_access_log
      WHERE tenant_id = ? AND agent_id = ?
      ORDER BY file_path
    `).all(tenantId, agentId);

    expect(allLogs).toHaveLength(3);
    expect(allLogs[0]).toMatchObject({
      file_path: "/tmp/file1.txt",
      op: "write",
      run_id: runId1,
    });
    expect(allLogs[1]).toMatchObject({
      file_path: "/tmp/file2.txt",
      op: "read",
      run_id: runId2,
    });
    expect(allLogs[2]).toMatchObject({
      file_path: "/tmp/file3.txt",
      op: "delete",
      run_id: runId2,
    });
  });
});
