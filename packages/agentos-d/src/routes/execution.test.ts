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

describe("GET /api/agents/:id/flight-recorder", () => {
  beforeEach(() => {
    resetDb();
    dataDir = mkdtempSync(join(tmpdir(), "awo-flight-recorder-"));
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

  it("returns 404 for non-existent agent", async () => {
    const res = await request(app)
      .get(`/api/agents/${randomUUID()}/flight-recorder`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("agent_not_found");
  });

  it("returns 404 for invalid agent ID format", async () => {
    const res = await request(app)
      .get("/api/agents/invalid-uuid/flight-recorder");

    expect(res.status).toBe(404);
  });

  it("provides flight recorder data chronologically", async () => {
    const sqlite = getSqlite();
    const tenantId = randomUUID();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupId = randomUUID();

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

    // Create run first (required for foreign key constraint)
    sqlite.prepare(`
      INSERT INTO execution_runs (id, tenant_id, company_id, agent_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'running', datetime('now'), datetime('now'))
    `).run(runId, tenantId, companyId, agentId);

    // Create run event
    sqlite.prepare(`
      INSERT INTO execution_run_events (id, tenant_id, run_id, event_type, message, data_json, created_at)
      VALUES (?, ?, ?, 'status_change', 'Run started', '{}', datetime('now'))
    `).run(randomUUID(), tenantId, runId);

    // Create agent wakeup
    sqlite.prepare(`
      INSERT INTO execution_agent_wakeups (id, tenant_id, agent_id, source, trigger_detail, reason, payload_json, idempotency_key, dispatch_id, created_at)
      VALUES (?, ?, ?, 'manual', 'test-trigger', 'Test wakeup', '{}', NULL, ?, datetime('now'))
    `).run(wakeupId, tenantId, agentId, randomUUID());

    const res = await request(app)
      .get(`/api/agents/${agentId}/flight-recorder`);

    expect(res.status).toBe(200);
    expect(res.body.items).toBeInstanceOf(Array);
    expect(res.body.items.length).toBeGreaterThan(0);

    // Verify chronological ordering - run_event should come before wakeup
    // based on the merge order specified in the spec (Action Proposed before System Events)
    expect(res.body.items[0].type).toBe("run_event");
    expect(res.body.items[1].type).toBe("wakeup");
  });

  it("includes runtime state transitions", async () => {
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

    // Create runtime state with action log entry
    sqlite.prepare(`
      INSERT INTO execution_agent_runtime_state (agent_id, tenant_id, last_run_id, last_run_status, last_run_at, updated_at)
      VALUES (?, ?, ?, 'succeeded', datetime('now'), datetime('now'))
    `).run(agentId, tenantId, runId);

    // Create action log entry for run.*
    const now = new Date().toISOString();
    sqlite.prepare(`
      INSERT INTO action_log (id, tenant_id, actor_id, actor_type, actor_label, action_kind, payload_snapshot, vault_refs, conversation_refs, project_refs, proposed_at, logged_at)
      VALUES (?, ?, ?, 'agent', 'Test Agent', 'run.succeeded', '{"runId": "${runId}"}', '[]', '[]', '[]', ?, ?)
    `).run(randomUUID(), tenantId, agentId, now, now);

    const res = await request(app)
      .get(`/api/agents/${agentId}/flight-recorder`);

    expect(res.status).toBe(200);
    expect(res.body.items).toBeInstanceOf(Array);

    // Should include the runtime state transition
    const runTransition = res.body.items.find((item: any) => item.type === 'action_log' && item.actionKind === 'run.succeeded');
    expect(runTransition).toBeDefined();
  });

  it("includes terminal episodes", async () => {
    const sqlite = getSqlite();
    const tenantId = randomUUID();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const episodeId = randomUUID();
    const sessionId = randomUUID();

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

    // Create episode
    sqlite.prepare(`
      INSERT INTO episodes (id, tenant_id, agent_id, session_id, started_at, ended_at, duration_sec, outcome, summary, importance, created_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), 300, 'success', 'Test episode', 3, datetime('now'))
    `).run(episodeId, tenantId, agentId, sessionId);

    const res = await request(app)
      .get(`/api/agents/${agentId}/flight-recorder`);

    expect(res.status).toBe(200);
    expect(res.body.items).toBeInstanceOf(Array);

    // Should include the episode
    const episodeItem = res.body.items.find((item: any) => item.type === 'episode');
    expect(episodeItem).toBeDefined();
    expect(episodeItem.summary).toBe('Test episode');
  });

  it("includes linked insights", async () => {
    const sqlite = getSqlite();
    const tenantId = randomUUID();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const episodeId = randomUUID();
    const sessionId = randomUUID();
    const insightId = randomUUID();

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

    // Create episode
    sqlite.prepare(`
      INSERT INTO episodes (id, tenant_id, agent_id, session_id, started_at, ended_at, duration_sec, outcome, summary, importance, created_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), 300, 'success', 'Test episode', 3, datetime('now'))
    `).run(episodeId, tenantId, agentId, sessionId);

    // Create insight
    sqlite.prepare(`
      INSERT INTO insights (id, tenant_id, episode_id, frame_type, content, importance, source, validated, created_at)
      VALUES (?, ?, ?, 'fact', 'Test insight', 2, 'agent_reflection', 0, datetime('now'))
    `).run(insightId, tenantId, episodeId);

    const res = await request(app)
      .get(`/api/agents/${agentId}/flight-recorder`);

    expect(res.status).toBe(200);
    expect(res.body.items).toBeInstanceOf(Array);

    // Should include the insight
    const insightItem = res.body.items.find((item: any) => item.type === 'insight');
    expect(insightItem).toBeDefined();
    expect(insightItem.content).toBe('Test insight');
  });



  it("surfaces confidence field from data_json in flight-recorder responses", async () => {
    const sqlite = getSqlite();
    const tenantId = randomUUID();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const eventId = randomUUID();

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

    // Create run event with confidence in data_json
    sqlite.prepare(`
      INSERT INTO execution_run_events (id, tenant_id, run_id, event_type, message, data_json, created_at)
      VALUES (?, ?, ?, 'status_change', 'Run started', '{"confidence": 0.85}', datetime('now'))
    `).run(eventId, tenantId, runId);

    const res = await request(app)
      .get(`/api/agents/${agentId}/flight-recorder`);

    expect(res.status).toBe(200);
    expect(res.body.items).toBeInstanceOf(Array);

    // Find the run event with confidence
    const runEvent = res.body.items.find((item: any) => item.type === 'run_event');
    expect(runEvent).toBeDefined();
    expect(runEvent.confidence).toBe(0.85);
    expect(runEvent.data).toMatchObject({ confidence: 0.85 });
  });

  it("handles run events without confidence field gracefully", async () => {
    const sqlite = getSqlite();
    const tenantId = randomUUID();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const eventId = randomUUID();

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

    // Create run event without confidence
    sqlite.prepare(`
      INSERT INTO execution_run_events (id, tenant_id, run_id, event_type, message, data_json, created_at)
      VALUES (?, ?, ?, 'status_change', 'Run started', '{"status": "active"}', datetime('now'))
    `).run(eventId, tenantId, runId);

    const res = await request(app)
      .get(`/api/agents/${agentId}/flight-recorder`);

    expect(res.status).toBe(200);
    expect(res.body.items).toBeInstanceOf(Array);

    // Find the run event without confidence
    const runEvent = res.body.items.find((item: any) => item.type === 'run_event');
    expect(runEvent).toBeDefined();
    expect(runEvent.confidence).toBeUndefined();
    expect(runEvent.data).toMatchObject({ status: 'active' });
  });
});

describe("GET /api/runs/:runId/lineage", () => {
  let lineageApp: ReturnType<typeof createApp>;

  beforeEach(() => {
    resetDb();
    dataDir = mkdtempSync(join(tmpdir(), "awo-lineage-"));
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
    lineageApp = createApp({
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

  it("returns 404 for non-existent run", async () => {
    const res = await request(lineageApp)
      .get(`/api/runs/${randomUUID()}/lineage`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("run_not_found");
  });

  it("returns 404 for invalid run ID format", async () => {
    const res = await request(lineageApp)
      .get("/api/runs/invalid-uuid/lineage");
    expect(res.status).toBe(404);
  });

  it("returns run with empty episodes and insights when no episode linked", async () => {
    const sqlite = getSqlite();
    const tenantId = randomUUID();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    sqlite.prepare(`
      INSERT INTO execution_companies (id, tenant_id, name, slug, slug_prefix, status, metadata_json, created_at, updated_at)
      VALUES (?, ?, 'Test Company', 'test', 'TEST', 'active', '{}', datetime('now'), datetime('now'))
    `).run(companyId, tenantId);

    sqlite.prepare(`
      INSERT INTO execution_agents (id, tenant_id, company_id, name, role, status, config_json, created_at, updated_at)
      VALUES (?, ?, ?, 'Test Agent', 'developer', 'active', '{}', datetime('now'), datetime('now'))
    `).run(agentId, tenantId, companyId);

    sqlite.prepare(`
      INSERT INTO execution_runs (id, tenant_id, company_id, agent_id, status, episode_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'completed', ?, datetime('now'), datetime('now'))
    `).run(runId, tenantId, companyId, agentId, randomUUID());

    const res = await request(lineageApp)
      .get(`/api/runs/${runId}/lineage`);

    expect(res.status).toBe(200);
    expect(res.body.run.id).toBe(runId);
    expect(res.body.episodes).toEqual([]);
    expect(res.body.insights).toEqual([]);
  });

  it("returns full lineage run → episode → insights", async () => {
    const sqlite = getSqlite();
    const tenantId = randomUUID();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const sessionId = randomUUID();
    const episodeId = randomUUID();
    const insightId = randomUUID();

    sqlite.prepare(`
      INSERT INTO execution_companies (id, tenant_id, name, slug, slug_prefix, status, metadata_json, created_at, updated_at)
      VALUES (?, ?, 'Test Company', 'test', 'TEST', 'active', '{}', datetime('now'), datetime('now'))
    `).run(companyId, tenantId);

    sqlite.prepare(`
      INSERT INTO execution_agents (id, tenant_id, company_id, name, role, status, config_json, created_at, updated_at)
      VALUES (?, ?, ?, 'Test Agent', 'developer', 'active', '{}', datetime('now'), datetime('now'))
    `).run(agentId, tenantId, companyId);

    sqlite.prepare(`
      INSERT INTO execution_runs (id, tenant_id, company_id, agent_id, status, episode_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'completed', ?, datetime('now'), datetime('now'))
    `).run(runId, tenantId, companyId, agentId, sessionId);

    sqlite.prepare(`
      INSERT INTO episodes (id, tenant_id, agent_id, session_id, started_at, ended_at, duration_sec, outcome, summary, importance, created_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), 600, 'success', 'Episode summary', 3, datetime('now'))
    `).run(episodeId, tenantId, agentId, sessionId);

    sqlite.prepare(`
      INSERT INTO insights (id, tenant_id, episode_id, frame_type, subject, content, importance, source, validated, created_at)
      VALUES (?, ?, ?, 'fact', 'test-subject', 'Insight content', 4, 'agent_reflection', 0, datetime('now'))
    `).run(insightId, tenantId, episodeId);

    const res = await request(lineageApp)
      .get(`/api/runs/${runId}/lineage`);

    expect(res.status).toBe(200);
    expect(res.body.run.id).toBe(runId);
    expect(res.body.episodes).toHaveLength(1);
    expect(res.body.episodes[0].id).toBe(episodeId);
    expect(res.body.insights).toHaveLength(1);
    expect(res.body.insights[0].id).toBe(insightId);
    expect(res.body.insights[0].episodeId).toBe(episodeId);
  });
});
