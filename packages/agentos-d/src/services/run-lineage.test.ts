import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations/index.js";
import { resolveRunLineage } from "./run-lineage.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const COMPANY = "22222222-2222-2222-2222-222222222222";
const AGENT = "33333333-3333-3333-3333-333333333333";
const RUN = "44444444-4444-4444-4444-444444444444";
const SESSION = "55555555-5555-5555-5555-555555555555";
const EPISODE = "66666666-6666-6666-6666-666666666666";
const INSIGHT = "77777777-7777-7777-7777-777777777777";

let sqlite: Database.Database;

function seedBase() {
  sqlite.prepare(`
    INSERT INTO execution_companies (id, tenant_id, name, slug, slug_prefix, status, metadata_json, created_at, updated_at)
    VALUES (?, ?, 'Test Co', 'test-co', 'TEST', 'active', '{}', ?, ?)
  `).run(COMPANY, TENANT, "2026-05-02T19:00:00.000Z", "2026-05-02T19:00:00.000Z");

  sqlite.prepare(`
    INSERT INTO execution_agents (id, tenant_id, company_id, name, role, status, config_json, created_at, updated_at)
    VALUES (?, ?, ?, 'Test Agent', 'developer', 'active', '{}', ?, ?)
  `).run(AGENT, TENANT, COMPANY, "2026-05-02T19:00:00.000Z", "2026-05-02T19:00:00.000Z");

  sqlite.prepare(`
    INSERT INTO execution_runs
    (id, tenant_id, company_id, project_id, issue_id, agent_id, status, started_at, ended_at, summary, episode_session_id, created_at, updated_at)
    VALUES (?, ?, ?, NULL, NULL, ?, 'completed', ?, ?, 'Run summary', ?, ?, ?)
  `).run(
    RUN,
    TENANT,
    COMPANY,
    AGENT,
    "2026-05-02T20:00:00.000Z",
    "2026-05-02T20:30:00.000Z",
    SESSION,
    "2026-05-02T20:00:00.000Z",
    "2026-05-02T20:30:00.000Z",
  );
}

function seedEpisode() {
  sqlite.prepare(`
    INSERT INTO episodes
    (id, tenant_id, agent_id, session_id, started_at, ended_at, duration_sec, outcome, summary, importance, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1800, 'success', 'Episode summary', 3, ?)
  `).run(EPISODE, TENANT, AGENT, SESSION, "2026-05-02T20:00:00.000Z", "2026-05-02T20:30:00.000Z", "2026-05-02T20:30:00.000Z");
}

function seedInsight() {
  sqlite.prepare(`
    INSERT INTO insights
    (id, tenant_id, episode_id, frame_type, subject, content, importance, source, validated, created_at)
    VALUES (?, ?, ?, 'fact', 'test-subject', 'Insight content', 4, 'agent_reflection', 0, ?)
  `).run(INSIGHT, TENANT, EPISODE, "2026-05-02T20:35:00.000Z");
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  migrate(sqlite);
});

afterEach(() => {
  sqlite.close();
});

describe("resolveRunLineage", () => {
  it("returns 404 shape when run does not exist", () => {
    const result = resolveRunLineage(sqlite, RUN);
    expect(result.run).toBeNull();
    expect(result.episodes).toEqual([]);
    expect(result.insights).toEqual([]);
  });

  it("returns run with empty episodes/insights when no episode exists", () => {
    seedBase();
    const result = resolveRunLineage(sqlite, RUN);
    expect(result.run).not.toBeNull();
    expect(result.run!.id).toBe(RUN);
    expect(result.run!.episodeSessionId).toBe(SESSION);
    expect(result.episodes).toEqual([]);
    expect(result.insights).toEqual([]);
  });

  it("returns run + episodes when episode exists but no insights", () => {
    seedBase();
    seedEpisode();
    const result = resolveRunLineage(sqlite, RUN);
    expect(result.run!.id).toBe(RUN);
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]!.id).toBe(EPISODE);
    expect(result.episodes[0]!.sessionId).toBe(SESSION);
    expect(result.insights).toEqual([]);
  });

  it("returns full lineage run → episode → insights", () => {
    seedBase();
    seedEpisode();
    seedInsight();
    const result = resolveRunLineage(sqlite, RUN);
    expect(result.run!.id).toBe(RUN);
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]!.id).toBe(EPISODE);
    expect(result.insights).toHaveLength(1);
    expect(result.insights[0]!.id).toBe(INSIGHT);
    expect(result.insights[0]!.episodeId).toBe(EPISODE);
    expect(result.insights[0]!.frameType).toBe("fact");
  });

  it("returns multiple insights for the same episode", () => {
    seedBase();
    seedEpisode();
    seedInsight();
    const INSIGHT2 = "88888888-8888-8888-8888-888888888888";
    sqlite.prepare(`
      INSERT INTO insights
      (id, tenant_id, episode_id, frame_type, subject, content, importance, source, validated, created_at)
      VALUES (?, ?, ?, 'plan', NULL, 'Another insight', 2, 'task_outcome', 1, ?)
    `).run(INSIGHT2, TENANT, EPISODE, "2026-05-02T20:36:00.000Z");

    const result = resolveRunLineage(sqlite, RUN);
    expect(result.insights).toHaveLength(2);
    expect(result.insights.map((i) => i.id)).toContain(INSIGHT);
    expect(result.insights.map((i) => i.id)).toContain(INSIGHT2);
  });

  it("returns multiple episodes sharing the same session", () => {
    seedBase();
    seedEpisode();
    const EPISODE2 = "88888888-8888-8888-8888-888888888888";
    sqlite.prepare(`
      INSERT INTO episodes
      (id, tenant_id, agent_id, session_id, started_at, ended_at, duration_sec, outcome, summary, importance, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 900, 'success', 'Second episode', 2, ?)
    `).run(EPISODE2, TENANT, AGENT, SESSION, "2026-05-02T21:00:00.000Z", "2026-05-02T21:15:00.000Z", "2026-05-02T21:15:00.000Z");

    const result = resolveRunLineage(sqlite, RUN);
    expect(result.episodes).toHaveLength(2);
    expect(result.episodes.map((e) => e.id)).toContain(EPISODE);
    expect(result.episodes.map((e) => e.id)).toContain(EPISODE2);
  });
});
