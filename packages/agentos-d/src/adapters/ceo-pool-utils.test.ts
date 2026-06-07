/**
 * Tests for CEO pool utilities.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { getLeastLoadedCeo, isCeoAgent, getActiveCeoAgents, CEO_AGENT_IDS } from "./ceo-pool-utils.js";

describe("CEO pool utilities", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");

    // Create execution_agents table
    sqlite.exec(`
      CREATE TABLE execution_agents (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        config_json TEXT NOT NULL DEFAULT '{}',
        adapter_type TEXT,
        model TEXT,
        capabilities TEXT,
        heartbeat_interval_sec INTEGER,
        source TEXT NOT NULL DEFAULT 'awos',
        source_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // Create execution_issues table
    sqlite.exec(`
      CREATE TABLE execution_issues (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        company_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        identifier TEXT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'todo',
        priority TEXT NOT NULL DEFAULT 'medium',
        assignee_agent_id TEXT REFERENCES execution_agents(id) ON DELETE SET NULL,
        parent_issue_id TEXT REFERENCES execution_issues(id) ON DELETE SET NULL,
        blocked_on_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        source TEXT NOT NULL DEFAULT 'awos',
        source_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);

    // Insert test CEO agents
    const now = new Date().toISOString();
    sqlite.prepare(
      `INSERT INTO execution_agents (id, tenant_id, name, role, status, config_json, adapter_type, model, capabilities, heartbeat_interval_sec, source, source_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      CEO_AGENT_IDS[0], "tenant-1", "CEO", "ceo", "active", "{}", "kimi", "glm-5.1", "[\"review\"]", 60, "awos", "ceo-1", now, now
    );
    sqlite.prepare(
      `INSERT INTO execution_agents (id, tenant_id, name, role, status, config_json, adapter_type, model, capabilities, heartbeat_interval_sec, source, source_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      CEO_AGENT_IDS[1], "tenant-1", "CEO-2", "ceo", "active", "{}", "kimi", "glm-5.1", "[\"review\"]", 60, "awos", "ceo-2", now, now
    );
    sqlite.prepare(
      `INSERT INTO execution_agents (id, tenant_id, name, role, status, config_json, adapter_type, model, capabilities, heartbeat_interval_sec, source, source_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      CEO_AGENT_IDS[2], "tenant-1", "CEO-3", "ceo", "active", "{}", "kimi", "glm-5.1", "[\"review\"]", 60, "awos", "ceo-3", now, now
    );
  });

  describe("isCeoAgent", () => {
    it("should return true for CEO agent IDs", () => {
      expect(isCeoAgent(CEO_AGENT_IDS[0])).toBe(true);
      expect(isCeoAgent(CEO_AGENT_IDS[1])).toBe(true);
      expect(isCeoAgent(CEO_AGENT_IDS[2])).toBe(true);
    });

    it("should return false for non-CEO agent IDs", () => {
      expect(isCeoAgent("some-other-agent-id")).toBe(false);
      expect(isCeoAgent("")).toBe(false);
    });
  });

  describe("getLeastLoadedCeo", () => {
    it("should return the CEO with fewest active reviews", () => {
      // Create some review issues
      const now = new Date().toISOString();

      // CEO-1 has 2 active reviews
      sqlite.prepare(`INSERT INTO execution_issues (id, tenant_id, company_id, project_id, title, status, assignee_agent_id, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
           .run("issue-1", "tenant-1", "company-1", "project-1", "Test Issue 1", "review", CEO_AGENT_IDS[0], now, now);
      sqlite.prepare(`INSERT INTO execution_issues (id, tenant_id, company_id, project_id, title, status, assignee_agent_id, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
           .run("issue-2", "tenant-1", "company-1", "project-1", "Test Issue 2", "review", CEO_AGENT_IDS[0], now, now);

      // CEO-2 has 1 active review
      sqlite.prepare(`INSERT INTO execution_issues (id, tenant_id, company_id, project_id, title, status, assignee_agent_id, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
           .run("issue-3", "tenant-1", "company-1", "project-1", "Test Issue 3", "review", CEO_AGENT_IDS[1], now, now);

      // CEO-3 has 0 active reviews

      const leastLoaded = getLeastLoadedCeo(sqlite, "tenant-1");
      expect(leastLoaded).toBe(CEO_AGENT_IDS[2]); // Should be CEO-3
    });

    it("should return original CEO if no CEOs found", () => {
      // Create a new database without CEO agents
      const emptyDb = new Database(":memory:");
      emptyDb.exec(`
        CREATE TABLE execution_agents (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          name TEXT NOT NULL,
          role TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          config_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE execution_issues (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          assignee_agent_id TEXT,
          status TEXT NOT NULL DEFAULT 'todo'
        );
      `);

      const leastLoaded = getLeastLoadedCeo(emptyDb, "tenant-1");
      expect(leastLoaded).toBe(CEO_AGENT_IDS[0]); // Should fallback to original CEO
    });

    it("should handle ties by choosing the oldest CEO", () => {
      // Create some review issues with equal counts
      const now = new Date().toISOString();

      // All CEOs have 1 active review each
      sqlite.prepare(`INSERT INTO execution_issues (id, tenant_id, company_id, project_id, title, status, assignee_agent_id, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
           .run("issue-1", "tenant-1", "company-1", "project-1", "Test Issue 1", "review", CEO_AGENT_IDS[0], now, now);
      sqlite.prepare(`INSERT INTO execution_issues (id, tenant_id, company_id, project_id, title, status, assignee_agent_id, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
           .run("issue-2", "tenant-1", "company-1", "project-1", "Test Issue 2", "review", CEO_AGENT_IDS[1], now, now);
      sqlite.prepare(`INSERT INTO execution_issues (id, tenant_id, company_id, project_id, title, status, assignee_agent_id, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
           .run("issue-3", "tenant-1", "company-1", "project-1", "Test Issue 3", "review", CEO_AGENT_IDS[2], now, now);

      const leastLoaded = getLeastLoadedCeo(sqlite, "tenant-1");
      expect(leastLoaded).toBe(CEO_AGENT_IDS[0]); // Should be the original CEO (oldest)
    });
  });

  describe("getActiveCeoAgents", () => {
    it("should return all active CEO agents with their review counts", () => {
      // Create some review issues
      const now = new Date().toISOString();

      // CEO-1 has 2 active reviews
      sqlite.prepare(`INSERT INTO execution_issues (id, tenant_id, company_id, project_id, title, status, assignee_agent_id, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
           .run("issue-1", "tenant-1", "company-1", "project-1", "Test Issue 1", "review", CEO_AGENT_IDS[0], now, now);
      sqlite.prepare(`INSERT INTO execution_issues (id, tenant_id, company_id, project_id, title, status, assignee_agent_id, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
           .run("issue-2", "tenant-1", "company-1", "project-1", "Test Issue 2", "review", CEO_AGENT_IDS[0], now, now);

      // CEO-2 has 1 active review
      sqlite.prepare(`INSERT INTO execution_issues (id, tenant_id, company_id, project_id, title, status, assignee_agent_id, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
           .run("issue-3", "tenant-1", "company-1", "project-1", "Test Issue 3", "review", CEO_AGENT_IDS[1], now, now);

      const activeCeos = getActiveCeoAgents(sqlite, "tenant-1");

      expect(activeCeos).toHaveLength(3);
      expect(activeCeos[0]).toEqual({ id: CEO_AGENT_IDS[0], name: "CEO", active_reviews: 2 });
      expect(activeCeos[1]).toEqual({ id: CEO_AGENT_IDS[1], name: "CEO-2", active_reviews: 1 });
      expect(activeCeos[2]).toEqual({ id: CEO_AGENT_IDS[2], name: "CEO-3", active_reviews: 0 });
    });

    it("should return empty array if no CEOs exist", () => {
      // Create a new database without CEO agents
      const emptyDb = new Database(":memory:");
      emptyDb.exec(`
        CREATE TABLE execution_agents (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          name TEXT NOT NULL,
          role TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          config_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE execution_issues (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          assignee_agent_id TEXT,
          status TEXT NOT NULL DEFAULT 'todo'
        );
      `);

      const activeCeos = getActiveCeoAgents(emptyDb, "tenant-1");
      expect(activeCeos).toEqual([]);
    });
  });
});
