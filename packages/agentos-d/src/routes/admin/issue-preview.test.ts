import express from "express";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AwosLocalProfile } from "../../config/local-profile.schema.js";

const mockState = vi.hoisted(() => ({
  profile: null as AwosLocalProfile | null,
}));

vi.mock("../../config/local-profile.js", () => ({
  getProfile: vi.fn(async () => {
    if (mockState.profile === null) {
      throw new Error("mock profile not configured");
    }
    return mockState.profile;
  }),
}));

import { issuePreviewRouter } from "./issue-preview.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";

function makeProfile(dbPath: string): AwosLocalProfile {
  return {
    version: 1,
    repoRoot: "/tmp/repo",
    dataDir: path.dirname(dbPath),
    dbPath,
    vaultRoot: path.dirname(dbPath),
    tenantId: TENANT_ID,
    tenantName: "Test",
    expectedCompanies: ["AgentWorks"],
    alwaysKeepIssueIds: ["AGE-KEEP", "AGE-DONE"],
    ports: { admin: 3000, api: 7710 },
    launchdLabels: [],
    backupDir: path.dirname(dbPath),
  };
}

function makeDb(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    const recent = new Date().toISOString();
    db.exec(`
      CREATE TABLE execution_agents (
        id TEXT PRIMARY KEY,
        last_heartbeat_at TEXT
      );
      CREATE TABLE execution_issues (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        identifier TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        assignee_agent_id TEXT
      );
      CREATE TABLE dispatch_queue (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL
      );
      INSERT INTO execution_agents VALUES ('agent-recent', '${recent}');
      INSERT INTO execution_issues VALUES
        ('issue-keep', '${TENANT_ID}', 'AGE-KEEP', 'todo', '{}', NULL),
        ('issue-candidate', '${TENANT_ID}', 'AGE-CANDIDATE', 'blocked', '{}', NULL),
        ('issue-recent', '${TENANT_ID}', 'AGE-RECENT', 'review', '{}', 'agent-recent'),
        ('issue-done', '${TENANT_ID}', 'AGE-DONE', 'done', '{}', NULL),
        ('issue-closed', '${TENANT_ID}', 'AGE-CLOSED', 'closed', '{}', NULL);
    `);
  } finally {
    db.close();
  }
}

describe("issue-preview route", () => {
  let tmp = "";

  afterEach(() => {
    mockState.profile = null;
    if (tmp !== "") {
      rmSync(tmp, { recursive: true, force: true });
      tmp = "";
    }
  });

  it("classifies only active statuses and excludes done/closed history", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "awos-issue-preview-"));
    const dbPath = path.join(tmp, "agentworks.db");
    makeDb(dbPath);
    mockState.profile = makeProfile(dbPath);

    const app = express();
    app.use("/api/admin/issue-preview", issuePreviewRouter);

    const res = await request(app)
      .get(`/api/admin/issue-preview?tenantId=${TENANT_ID}`)
      .expect(200);

    const ids = [
      ...res.body.keep.map((item: { id: string }) => item.id),
      ...res.body.candidates.map((item: { id: string }) => item.id),
    ];

    expect(ids).toContain("issue-keep");
    expect(ids).toContain("issue-candidate");
    expect(ids).toContain("issue-recent");
    expect(ids).not.toContain("issue-done");
    expect(ids).not.toContain("issue-closed");
    expect(res.body.counts).toEqual({ keep: 2, candidate: 1 });
  });
});
