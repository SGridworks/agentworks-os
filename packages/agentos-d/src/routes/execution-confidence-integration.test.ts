import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../app.js";
import { initDb, resetDb, getSqlite } from "../db/client.js";
import { migrate } from "../db/migrations/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir: string;
let app: ReturnType<typeof createApp>;

describe("Confidence field integration tests", () => {
  beforeEach(() => {
    resetDb();
    dataDir = mkdtempSync(join(tmpdir(), "awo-confidence-"));
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

  it("POST /runs/:runId/events creates event and GET /agents/:agentId/flight-recorder surfaces confidence", async () => {
    const sqlite = getSqlite();
    const tenantId = randomUUID();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    
    // Create company
    sqlite.prepare(`
      INSERT INTO execution_companies (id, tenant_id, name, slug, slug_prefix, status, metadata_json, created_at, updated_at)
      VALUES (?, ?, 'Test Company', 'test', 'TEST', 'active', '{}', datetime('now'), datetime('now'))
    `).run(companyId, tenantId);
    
    // Create agent
    sqlite.prepare(`
      INSERT INTO execution_agents (id, tenant_id, company_id, name, role, status, config_json, created_at, updated_at)
      VALUES (?, ?, ?, 'Test Agent', 'developer', 'active', '{}', datetime('now'), datetime('now'))
    `).run(agentId, tenantId, companyId);
    
    // Create run
    sqlite.prepare(`
      INSERT INTO execution_runs (id, tenant_id, company_id, agent_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'running', datetime('now'), datetime('now'))
    `).run(runId, tenantId, companyId, agentId);
    
    // POST run event with confidence
    const eventResponse = await request(app)
      .post(`/api/runs/${runId}/events`)
      .send({
        tenantId: tenantId,
        eventType: 'status_change',
        message: 'Run status updated',
        data: {
          status: 'completed',
          confidence: 0.92
        }
      });
    
    expect(eventResponse.status).toBe(201);
    expect(eventResponse.body.data).toMatchObject({
      status: 'completed',
      confidence: 0.92
    });
    
    // GET flight-recorder and verify confidence field
    const flightRecorderResponse = await request(app)
      .get(`/api/agents/${agentId}/flight-recorder`);
    
    expect(flightRecorderResponse.status).toBe(200);
    expect(flightRecorderResponse.body.items).toBeInstanceOf(Array);
    
    // Find the run event with confidence
    const runEvent = flightRecorderResponse.body.items.find((item: any) => item.type === 'run_event');
    expect(runEvent).toBeDefined();
    expect(runEvent.confidence).toBe(0.92);
    expect(runEvent.data).toMatchObject({ 
      status: 'completed',
      confidence: 0.92 
    });
  });

  it("handles run events without confidence field via POST endpoint", async () => {
    const sqlite = getSqlite();
    const tenantId = randomUUID();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    
    // Create company
    sqlite.prepare(`
      INSERT INTO execution_companies (id, tenant_id, name, slug, slug_prefix, status, metadata_json, created_at, updated_at)
      VALUES (?, ?, 'Test Company', 'test', 'TEST', 'active', '{}', datetime('now'), datetime('now'))
    `).run(companyId, tenantId);
    
    // Create agent
    sqlite.prepare(`
      INSERT INTO execution_agents (id, tenant_id, company_id, name, role, status, config_json, created_at, updated_at)
      VALUES (?, ?, ?, 'Test Agent', 'developer', 'active', '{}', datetime('now'), datetime('now'))
    `).run(agentId, tenantId, companyId);
    
    // Create run
    sqlite.prepare(`
      INSERT INTO execution_runs (id, tenant_id, company_id, agent_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'running', datetime('now'), datetime('now'))
    `).run(runId, tenantId, companyId, agentId);
    
    // POST run event without confidence
    const eventResponse = await request(app)
      .post(`/api/runs/${runId}/events`)
      .send({
        tenantId: tenantId,
        eventType: 'status_change',
        message: 'Run status updated',
        data: {
          status: 'completed'
        }
      });
    
    expect(eventResponse.status).toBe(201);
    expect(eventResponse.body.data).toMatchObject({
      status: 'completed'
    });
    
    // GET flight-recorder and verify no confidence field
    const flightRecorderResponse = await request(app)
      .get(`/api/agents/${agentId}/flight-recorder`);
    
    expect(flightRecorderResponse.status).toBe(200);
    expect(flightRecorderResponse.body.items).toBeInstanceOf(Array);
    
    // Find the run event without confidence
    const runEvent = flightRecorderResponse.body.items.find((item: any) => item.type === 'run_event');
    expect(runEvent).toBeDefined();
    expect(runEvent.confidence).toBeUndefined();
    expect(runEvent.data).toMatchObject({ 
      status: 'completed'
    });
  });
});