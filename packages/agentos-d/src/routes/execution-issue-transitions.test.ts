import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../app.js";
import { initDb, resetDb } from "../db/client.js";
import { migrate } from "../db/migrations/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("PATCH /api/issues/:id — state-machine enforcement", () => {
  let app: ReturnType<typeof createApp>;
  let dataDir: string;
  let tenantId: string;
  let companyId: string;
  let projectId: string;

  async function newIssue(): Promise<string> {
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ tenantId, projectId, title: "[state-machine test] issue" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("todo");
    return res.body.id as string;
  }

  async function setStatus(
    id: string,
    status: string,
    actorType?: "human" | "agent" | "system",
  ) {
    return request(app)
      .patch(`/api/issues/${id}`)
      .send(actorType ? { status, actorType } : { status });
  }

  beforeEach(async () => {
    resetDb();
    dataDir = mkdtempSync(join(tmpdir(), "awo-issue-sm-"));
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
    tenantId = randomUUID();

    const companyRes = await request(app)
      .post("/api/companies")
      .send({ tenantId, name: "SM Test Co" });
    expect(companyRes.status).toBe(201);
    companyId = companyRes.body.id;

    const projectRes = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ tenantId, name: "SM Test Project" });
    expect(projectRes.status).toBe(201);
    projectId = projectRes.body.id;
  });

  afterEach(() => {
    resetDb();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("allows todo->in_progress->review->done and sets completed_at exactly once", async () => {
    const id = await newIssue();

    let res = await setStatus(id, "in_progress");
    expect(res.status).toBe(200);
    expect(res.body.completedAt).toBeNull();

    res = await setStatus(id, "review");
    expect(res.status).toBe(200);

    res = await setStatus(id, "done");
    expect(res.status).toBe(200);
    expect(res.body.completedAt).not.toBeNull();
    const completedAt = res.body.completedAt as string;

    // A metadata-only PATCH on a done issue must NOT bump completed_at.
    res = await request(app).patch(`/api/issues/${id}`).send({ priority: "high" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
    expect(res.body.completedAt).toBe(completedAt);
  });

  // Regression lock: these three edges were missing from the old graph and
  // 409'd legitimate bridge/review-adapter PATCHes. They must now succeed for
  // any actor (no actorType supplied).
  describe("previously-missing edges are now legal (the bug)", () => {
    it("todo -> done", async () => {
      const id = await newIssue();
      const res = await setStatus(id, "done");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("done");
      expect(res.body.completedAt).not.toBeNull();
    });

    it("review -> todo", async () => {
      const id = await newIssue();
      await setStatus(id, "in_progress");
      await setStatus(id, "review");
      const res = await setStatus(id, "todo");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("todo");
    });

    it("blocked -> done", async () => {
      const id = await newIssue();
      await setStatus(id, "blocked");
      const res = await setStatus(id, "done");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("done");
      expect(res.body.completedAt).not.toBeNull();
    });
  });

  it("still rejects an unknown status with 400 (enum validation intact)", async () => {
    const id = await newIssue();
    const res = await request(app).patch(`/api/issues/${id}`).send({ status: "banana" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("permits the dispatch-bridge path todo->in_progress->done (with comments)", async () => {
    const id = await newIssue();
    let res = await request(app)
      .patch(`/api/issues/${id}`)
      .send({ status: "in_progress", comment: "bridge claimed" });
    expect(res.status).toBe(200);
    res = await request(app)
      .patch(`/api/issues/${id}`)
      .send({ status: "done", comment: "bridge completed" });
    expect(res.status).toBe(200);
    expect(res.body.completedAt).not.toBeNull();
  });

  describe("operator gating: closing and reopening a terminal issue", () => {
    it("rejects done->in_progress (reopen) for an agent actor with 409", async () => {
      const id = await newIssue();
      await setStatus(id, "in_progress");
      await setStatus(id, "done");

      const res = await setStatus(id, "in_progress", "agent");
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("illegal_transition");
      expect(res.body.from).toBe("done");
      expect(res.body.to).toBe("in_progress");
    });

    it("rejects done->in_progress (reopen) with no actorType at all (defaults non-human)", async () => {
      const id = await newIssue();
      await setStatus(id, "in_progress");
      await setStatus(id, "done");

      const res = await setStatus(id, "in_progress");
      expect(res.status).toBe(409);
    });

    it("allows done->in_progress (reopen) for a human actor and clears completed_at", async () => {
      const id = await newIssue();
      await setStatus(id, "in_progress");
      await setStatus(id, "done");

      const res = await setStatus(id, "in_progress", "human");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("in_progress");
      expect(res.body.completedAt).toBeNull();
    });

    it("rejects todo->closed for a system actor with 409", async () => {
      const id = await newIssue();
      const res = await setStatus(id, "closed", "system");
      expect(res.status).toBe(409);
      expect(res.body.allowed).not.toContain("closed");
    });

    it("allows todo->closed for a human actor", async () => {
      const id = await newIssue();
      const res = await setStatus(id, "closed", "human");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("closed");
    });
  });
});
