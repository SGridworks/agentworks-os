/**
 * /api/memory/lint and /api/memory/lint/diff route tests.
 *
 * Covers the Phase 3 follow-up corrections:
 *   - /lint writes to history for both full and subset runs
 *   - /lint/diff baselines on matching executed set
 *   - /lint/diff returns baseline: null + reason when no match
 *   - /lint/diff/subset takes a checks subset and diffs subset-to-subset
 *   - invalid check names return 400 (no silent acceptance)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import type { Server } from "node:http";
import { createMemoryRouter } from "./memory.js";
import type { Config } from "../config.js";
import { _resetVaultStoreForTesting } from "./memory.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";

describe("Memory Routes — /lint and /lint/diff", () => {
  let root: string;
  let originalVaultRoot: string | undefined;
  let app: express.Express;
  let server: Server;

  // Seed a tiny wiki with one page so the lint has something to scan.
  function seed(rel: string, body: string): void {
    const abs = join(root, TENANT_A, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "lint-routes-test-"));
    originalVaultRoot = process.env.VAULT_ROOT;
    process.env.VAULT_ROOT = root;
    _resetVaultStoreForTesting();

    // Minimal schema so tag_audit can find it.
    const schemaDir = join(root, "wiki");
    mkdirSync(schemaDir, { recursive: true });
    writeFileSync(join(schemaDir, "SCHEMA.md"), "Allowed: `#project`\n", "utf8");

    seed("alpha.md", `---\ntitle: alpha\ntype: note\ntags: [project]\n---\n\nbody\n`);
    seed("orphan.md", `---\ntitle: orphan\ntype: note\n---\n\nbody\n`);

    app = express();
    app.use(express.json());
    app.use("/api/memory", createMemoryRouter({} as Config));
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env.VAULT_ROOT = originalVaultRoot;
    _resetVaultStoreForTesting();
    rmSync(root, { recursive: true, force: true });
  });

  it("GET /lint returns a 11-kind report by default", async () => {
    const r = await request(server)
      .get(`/api/memory/lint?tenantId=${TENANT_A}`)
      .expect(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.data.pageCount).toBe(2);
    expect(r.body.data.executed).toHaveLength(11);
    expect(r.body.data.runId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("GET /lint?checks=source_drift runs only that check", async () => {
    const r = await request(server)
      .get(`/api/memory/lint?tenantId=${TENANT_A}&checks=source_drift`)
      .expect(200);
    expect(r.body.data.executed).toEqual(["source_drift"]);
  });

  it("GET /lint?checks=a,b repeats work like a,b", async () => {
    const r = await request(server)
      .get(
        `/api/memory/lint?tenantId=${TENANT_A}&checks=source_drift,page_oversize`,
      )
      .expect(200);
    expect(r.body.data.executed).toEqual(["source_drift", "page_oversize"]);
  });

  it("GET /lint?checks=bogus returns 400 with helpful message", async () => {
    const r = await request(server)
      .get(`/api/memory/lint?tenantId=${TENANT_A}&checks=bogus`)
      .expect(400);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toBe("invalid_request");
    const flat = JSON.stringify(r.body.details);
    expect(flat).toMatch(/bogus/);
    expect(flat).toMatch(/unknown check name/);
  });

  it("GET /lint?checks=source_drift,alsogibberish returns 400 on first bad name", async () => {
    const r = await request(server)
      .get(
        `/api/memory/lint?tenantId=${TENANT_A}&checks=source_drift,alsogibberish`,
      )
      .expect(400);
    const flat = JSON.stringify(r.body.details);
    expect(flat).toMatch(/alsogibberish/);
  });

  it("GET /lint persists the report under wiki/lint-history/", async () => {
    await request(server)
      .get(`/api/memory/lint?tenantId=${TENANT_A}`)
      .expect(200);
    const histDir = join(root, TENANT_A, "wiki", "lint-history");
    // The history write is async-best-effort; give it a tick.
    await new Promise((r) => setTimeout(r, 50));
    const { readdirSync, existsSync } = await import("node:fs");
    expect(existsSync(histDir)).toBe(true);
    const names = readdirSync(histDir).filter((n) => n.endsWith(".json"));
    expect(names.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /lint/diff without history returns baseline: null + no_matching_baseline", async () => {
    const r = await request(server)
      .get(`/api/memory/lint/diff?tenantId=${TENANT_A}`)
      .expect(200);
    expect(r.body.data.currentRunId).toMatch(/^[0-9a-f]{16}$/);
    expect(r.body.data.currentExecuted).toHaveLength(11);
    expect(r.body.data.previousRunId).toBeNull();
    expect(r.body.data.baselineReason).toBe("no_matching_baseline");
    expect(r.body.data.added).toEqual([]);
    expect(r.body.data.removed).toEqual([]);
    expect(r.body.data.summary).toBeNull();
  });

  it("GET /lint/diff after two full runs produces a real diff", async () => {
    // Run 1 — establishes history baseline.
    const r1 = await request(server)
      .get(`/api/memory/lint?tenantId=${TENANT_A}`)
      .expect(200);
    const run1Id = r1.body.data.runId;
    await new Promise((r) => setTimeout(r, 50));

    // Run 2 — also full. The diff route will re-execute a full
    // lint and compare against the prior full lint.
    const r2 = await request(server)
      .get(`/api/memory/lint/diff?tenantId=${TENANT_A}`)
      .expect(200);
    expect(r2.body.data.previousRunId).toBe(run1Id);
    expect(r2.body.data.baselineReason).toBeNull();
    expect(r2.body.data.summary).not.toBeNull();
    expect(r2.body.data.currentExecuted).toEqual(r1.body.data.executed);
    expect(r2.body.data.previousExecuted).toEqual(r1.body.data.executed);
  });

  it("GET /lint/diff refuses to baseline a full run against a subset history (no_matching_baseline)", async () => {
    // Write a subset report to history directly.
    await request(server)
      .get(`/api/memory/lint?tenantId=${TENANT_A}&checks=source_drift`)
      .expect(200);
    await new Promise((r) => setTimeout(r, 50));

    // /lint/diff (full → full) should NOT match the subset history.
    const r = await request(server)
      .get(`/api/memory/lint/diff?tenantId=${TENANT_A}`)
      .expect(200);
    expect(r.body.data.previousRunId).toBeNull();
    expect(r.body.data.baselineReason).toBe("no_matching_baseline");
    expect(r.body.data.summary).toBeNull();
  });

  it("GET /lint/diff/subset persists subset runs and diffs subset-to-subset", async () => {
    // First subset call — establishes subset history.
    const r1 = await request(server)
      .get(
        `/api/memory/lint/diff/subset?tenantId=${TENANT_A}&checks=source_drift,page_oversize`,
      )
      .expect(200);
    expect(r1.body.data.currentExecuted).toEqual(["source_drift", "page_oversize"]);
    expect(r1.body.data.previousRunId).toBeNull();
    expect(r1.body.data.baselineReason).toBe("no_matching_baseline");
    const run1Id = r1.body.data.currentRunId;
    await new Promise((r) => setTimeout(r, 50));

    // Second subset call — same executed set, should baseline.
    const r2 = await request(server)
      .get(
        `/api/memory/lint/diff/subset?tenantId=${TENANT_A}&checks=source_drift,page_oversize`,
      )
      .expect(200);
    expect(r2.body.data.previousRunId).toBe(run1Id);
    expect(r2.body.data.baselineReason).toBeNull();
    expect(r2.body.data.currentExecuted).toEqual(r1.body.data.currentExecuted);
    expect(r2.body.data.previousExecuted).toEqual(r1.body.data.currentExecuted);
  });

  it("GET /lint/diff/subset does NOT baseline against a different subset", async () => {
    // First subset: source_drift.
    await request(server)
      .get(
        `/api/memory/lint/diff/subset?tenantId=${TENANT_A}&checks=source_drift`,
      )
      .expect(200);
    await new Promise((r) => setTimeout(r, 50));

    // Second subset: different set (page_oversize,tag_audit).
    const r = await request(server)
      .get(
        `/api/memory/lint/diff/subset?tenantId=${TENANT_A}&checks=page_oversize,tag_audit`,
      )
      .expect(200);
    expect(r.body.data.previousRunId).toBeNull();
    expect(r.body.data.baselineReason).toBe("no_matching_baseline");
  });

  it("GET /lint/diff/subset validates checks (400 on unknown name)", async () => {
    const r = await request(server)
      .get(
        `/api/memory/lint/diff/subset?tenantId=${TENANT_A}&checks=source_drift,not_a_real_check`,
      )
      .expect(400);
    const flat = JSON.stringify(r.body.details);
    expect(flat).toMatch(/not_a_real_check/);
  });

  it("GET /lint/diff with since=<iso> filters to strictly older reports with matching executed set", async () => {
    // Two full runs in sequence; record the first runId, then ask
    // for diff since an ISO that is between the two.
    const r1 = await request(server)
      .get(`/api/memory/lint?tenantId=${TENANT_A}`)
      .expect(200);
    const run1Id = r1.body.data.runId;
    await new Promise((r) => setTimeout(r, 50));
    const midpoint = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 50));
    await request(server)
      .get(`/api/memory/lint?tenantId=${TENANT_A}`)
      .expect(200);

    const r2 = await request(server)
      .get(
        `/api/memory/lint/diff?tenantId=${TENANT_A}&since=${encodeURIComponent(midpoint)}`,
      )
      .expect(200);
    expect(r2.body.data.previousRunId).toBe(run1Id);
  });
});
