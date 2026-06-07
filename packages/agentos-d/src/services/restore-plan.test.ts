/**
 * Mandatory safety tests for restore-plan validator.
 *
 * The whole point of this module is "reason about a future restore without
 * doing one". The two non-negotiable invariants:
 *   - hash(live DB before) === hash(live DB after)
 *   - WAL/SHM mtime + size unchanged
 *
 * Plus correctness of manifest verification, missing-file error messages,
 * and the exact futureApplyCommand format.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AwosLocalProfile } from "../config/local-profile.schema.js";
import { planRestore } from "./restore-plan.js";
import { createSnapshot } from "./snapshot.js";

function sha256(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

function seedDb(filePath: string, opts: { companies?: number } = {}): void {
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY);
    CREATE TABLE execution_companies (
      id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT, status TEXT
    );
    CREATE TABLE execution_agents (
      id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT, status TEXT
    );
    CREATE TABLE execution_issues (
      id TEXT PRIMARY KEY, tenant_id TEXT, status TEXT
    );
    CREATE TABLE dispatch_queue (
      id TEXT PRIMARY KEY, tenant_id TEXT, task_kind TEXT, target_agent_id TEXT,
      input TEXT NOT NULL, status TEXT NOT NULL, dispatched_at TEXT, created_at TEXT
    );
  `);
  db.prepare("INSERT INTO tenants (id) VALUES (?)").run("t1");
  const insertCo = db.prepare(
    "INSERT INTO execution_companies (id, tenant_id, name, status) VALUES (?, ?, ?, 'active')",
  );
  const count = opts.companies ?? 3;
  for (let i = 0; i < count; i++) insertCo.run(`co-${i}`, "t1", `Co${i}`);
  db.prepare(
    "INSERT INTO execution_agents (id, tenant_id, name, status) VALUES ('a1','t1','A1','active')",
  ).run();
  db.prepare(
    "INSERT INTO execution_issues (id, tenant_id, status) VALUES ('i1','t1','todo')",
  ).run();
  db.close();
}

function makeManifest(
  manifestPath: string,
  exportPath: string,
  exportSha: string,
): void {
  const manifest = {
    timestamp: new Date().toISOString(),
    export: { path: exportPath, sha256: exportSha },
    live: { path: "/tmp/whatever", sha256: "deadbeef" },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function makeProfile(dbPath: string): AwosLocalProfile {
  return {
    version: 1,
    repoRoot: "/tmp/fake-repo",
    dataDir: path.dirname(dbPath),
    dbPath,
    vaultRoot: path.dirname(dbPath),
    tenantId: "00000000-0000-4000-8000-000000000001",
    tenantName: "Test",
    expectedCompanies: ["Co0"],
    alwaysKeepIssueIds: [],
    ports: { admin: 3000, api: 7710 },
    launchdLabels: [],
    backupDir: path.dirname(dbPath),
  };
}

interface Sandbox {
  root: string;
  livePath: string;
  exportPath: string;
  manifestPath: string;
  auditDir: string;
  profile: AwosLocalProfile;
}

async function setupSandbox(): Promise<Sandbox> {
  const root = await mkdtemp(path.join(tmpdir(), "awo-restore-plan-"));
  const livePath = path.join(root, "agentworks.db");
  const exportPath = path.join(root, "awos-snapshot-2026.db");
  const manifestPath = path.join(root, "awos-snapshot-2026.manifest.json");
  seedDb(livePath, { companies: 3 });
  seedDb(exportPath, { companies: 6 });
  const exportSha = sha256(exportPath);
  makeManifest(manifestPath, exportPath, exportSha);
  return {
    root,
    livePath,
    exportPath,
    manifestPath,
    auditDir: path.join(root, "audit"),
    profile: makeProfile(livePath),
  };
}

let sandbox: Sandbox;

beforeEach(async () => {
  sandbox = await setupSandbox();
});

afterEach(() => {
  rmSync(sandbox.root, { recursive: true, force: true });
});

describe("planRestore — safety invariants", () => {
  it("Test 1: live DB sha256 is identical before and after", async () => {
    const before = sha256(sandbox.livePath);
    const result = await planRestore({
      exportPath: sandbox.exportPath,
      profile: sandbox.profile,
      auditLogDir: sandbox.auditDir,
    });
    const after = sha256(sandbox.livePath);
    expect(before).toBe(after);
    expect(result.liveDbSha256Before).toBe(result.liveDbSha256After);
    expect(result.liveDbSha256Before).toBe(before);
  });

  it("Test 2: real WAL-mode live DB with active sidecars is untouched", async () => {
    // Build a fresh WAL-mode DB and hold an open writer to keep -wal and
    // -shm alive (mirroring the production state where the daemon is running).
    const livePath = path.join(sandbox.root, "live-wal.db");
    const writer = new Database(livePath);
    writer.exec("PRAGMA journal_mode=WAL;");
    writer.exec(`
      CREATE TABLE tenants (id TEXT PRIMARY KEY);
      CREATE TABLE execution_companies (id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT, status TEXT);
      CREATE TABLE execution_agents (id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT, status TEXT);
      CREATE TABLE execution_issues (id TEXT PRIMARY KEY, tenant_id TEXT, status TEXT);
      CREATE TABLE dispatch_queue (id TEXT PRIMARY KEY, tenant_id TEXT, task_kind TEXT, target_agent_id TEXT, input TEXT NOT NULL, status TEXT NOT NULL, dispatched_at TEXT, created_at TEXT);
      INSERT INTO tenants (id) VALUES ('t1');
      INSERT INTO execution_companies (id, tenant_id, name, status) VALUES ('c1','t1','C','active');
    `);
    const walPath = `${livePath}-wal`;
    const shmPath = `${livePath}-shm`;
    expect(statSync(walPath).size).toBeGreaterThan(0);
    expect(statSync(shmPath).size).toBeGreaterThan(0);
    const walBefore = statSync(walPath);
    const shmBefore = statSync(shmPath);

    const profile = makeProfile(livePath);
    const result = await planRestore({
      exportPath: sandbox.exportPath,
      profile,
      auditLogDir: sandbox.auditDir,
    });

    const walAfter = statSync(walPath);
    const shmAfter = statSync(shmPath);
    expect(walAfter.size).toBe(walBefore.size);
    expect(walAfter.mtimeMs).toBe(walBefore.mtimeMs);
    expect(shmAfter.size).toBe(shmBefore.size);
    expect(shmAfter.mtimeMs).toBe(shmBefore.mtimeMs);
    expect(result.walShmAtLive.walPresent).toBe(true);
    expect(result.walShmAtLive.shmPresent).toBe(true);
    writer.close();
  });

  it("Test 3: tampered manifest sha256 -> manifestVerified=false, no throw", async () => {
    const manifest = JSON.parse(readFileSync(sandbox.manifestPath, "utf8"));
    manifest.export.sha256 = "0".repeat(64);
    writeFileSync(sandbox.manifestPath, JSON.stringify(manifest, null, 2));

    const result = await planRestore({
      exportPath: sandbox.exportPath,
      profile: sandbox.profile,
      auditLogDir: sandbox.auditDir,
    });
    expect(result.manifestVerified).toBe(false);
    // Operator must still see the live DB unchanged.
    expect(result.liveDbSha256Before).toBe(result.liveDbSha256After);
  });

  it("verifies the nested artifacts.db.sha256 shape produced by createSnapshot", async () => {
    const snapshot = await createSnapshot({ profile: sandbox.profile });

    const result = await planRestore({
      exportPath: snapshot.dbPath,
      profile: sandbox.profile,
      auditLogDir: sandbox.auditDir,
    });

    expect(result.manifestVerified).toBe(true);
    expect(result.manifestPath).toBe(snapshot.manifestPath);
  });

  it("Test 4: missing manifest file -> clear throw", async () => {
    rmSync(sandbox.manifestPath);
    await expect(
      planRestore({
        exportPath: sandbox.exportPath,
        profile: sandbox.profile,
        auditLogDir: sandbox.auditDir,
      }),
    ).rejects.toThrow(/manifest not found at .*\.manifest\.json/);
  });

  it("Test 5: missing export file -> clean throw", async () => {
    const fakePath = path.join(sandbox.root, "does-not-exist.db");
    await expect(
      planRestore({
        exportPath: fakePath,
        profile: sandbox.profile,
        auditLogDir: sandbox.auditDir,
      }),
    ).rejects.toThrow(/export not found at /);
  });

  it("Test 6: futureApplyCommand has exact format awos-restore-apply --export=<path> --confirm=<token>", async () => {
    const result = await planRestore({
      exportPath: sandbox.exportPath,
      profile: sandbox.profile,
      auditLogDir: sandbox.auditDir,
    });
    const expected = `awos-restore-apply --export=${sandbox.exportPath} --confirm=${result.requiredConfirmationToken}`;
    expect(result.futureApplyCommand).toBe(expected);
    expect(result.requiredConfirmationToken).toMatch(/^[0-9a-f]{64}$/);
    // Manifest token must be sha256 of raw manifest contents (not parsed/normalized).
    const raw = readFileSync(sandbox.manifestPath, "utf8");
    const expectedToken = createHash("sha256").update(raw).digest("hex");
    expect(result.requiredConfirmationToken).toBe(expectedToken);
  });

  it("count diff is live - export and exposes expectedPostRestoreCounts", async () => {
    const result = await planRestore({
      exportPath: sandbox.exportPath,
      profile: sandbox.profile,
      auditLogDir: sandbox.auditDir,
    });
    // Sandbox: live has 3 companies, export has 6.
    expect(result.liveCounts.executionCompanies).toBe(3);
    expect(result.exportCounts.executionCompanies).toBe(6);
    expect(result.diff.executionCompanies).toBe(-3);
    expect(result.expectedPostRestoreCounts).toEqual(result.exportCounts);
  });

  it("rollback command references lastKnownGoodSnapshot when present", async () => {
    const profile: AwosLocalProfile = {
      ...sandbox.profile,
      lastKnownGoodSnapshot: "/tmp/awos-snapshot-prior.db",
    };
    const result = await planRestore({
      exportPath: sandbox.exportPath,
      profile,
      auditLogDir: sandbox.auditDir,
    });
    expect(result.rollbackCommand).toContain("/tmp/awos-snapshot-prior.db");
  });

  it("touch test: opening export through validator does not create wal/shm sidecars on export", async () => {
    const exportWal = `${sandbox.exportPath}-wal`;
    const exportShm = `${sandbox.exportPath}-shm`;
    // Confirm baseline: no sidecars before run.
    let pre = false;
    try {
      statSync(exportWal);
      pre = true;
    } catch {
      /* expected */
    }
    expect(pre).toBe(false);

    await planRestore({
      exportPath: sandbox.exportPath,
      profile: sandbox.profile,
      auditLogDir: sandbox.auditDir,
    });
    // Readonly open should not produce sidecars.
    let postWal = false;
    let postShm = false;
    try {
      statSync(exportWal);
      postWal = true;
    } catch {
      /* expected */
    }
    try {
      statSync(exportShm);
      postShm = true;
    } catch {
      /* expected */
    }
    expect(postWal).toBe(false);
    expect(postShm).toBe(false);
  });
});

describe("planRestore — input validation", () => {
  it("rejects non-.db export path", async () => {
    const wrong = path.join(sandbox.root, "not-a-db.txt");
    const fd = openSync(wrong, "w");
    closeSync(fd);
    await writeFile(wrong, "garbage");
    await expect(
      planRestore({
        exportPath: wrong,
        profile: sandbox.profile,
        auditLogDir: sandbox.auditDir,
      }),
    ).rejects.toThrow(/must be a \.db file/);
  });
});
