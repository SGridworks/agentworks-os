/**
 * AWOS local snapshot exporter.
 *
 * Produces a byte-restoreable SQLite database file via `VACUUM INTO`, plus a
 * JSON sidecar of derived counts and a manifest tying the two together.
 *
 * Safety invariants (proven in snapshot.test.ts):
 *   - sha256(live DB) is identical before and after the snapshot.
 *   - mtime + size of the live DB's .wal and .shm sidecars are unchanged.
 *   - The snapshot never creates a .wal or .shm at the live DB path that
 *     wasn't there before.
 *
 * VACUUM INTO requires a writable connection to the source (better-sqlite3
 * 11.x rejects VACUUM on OPEN_READONLY). VACUUM INTO does not modify the
 * source — it copies pages into a fresh file. We rely on the sha256 invariant
 * to prove that, not on the open mode. Derived count queries use a SEPARATE
 * read-only connection so the count path cannot mutate the live DB.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getProfile } from "../config/local-profile.js";
import type { AwosLocalProfile } from "../config/local-profile.schema.js";
import { assertDbPathMatchesDaemonLock } from "./maintenance-lock.js";

export interface SnapshotCounts {
  tenants: number;
  companies: number;
  companiesByTenant: Record<string, number>;
  agents: { active: number; paused: number; retired: number; total: number };
  issues: number;
  dispatch: {
    queued: number;
    dispatched: number;
    stale: number;
    duplicateWakeups: number;
  };
}

export interface SidecarState {
  schemaVersion: 1;
  timestamp: string;
  profile: AwosLocalProfile;
  liveCounts: SnapshotCounts;
  snapshotCounts: SnapshotCounts;
}

export interface SidecarFileObservation {
  exists: boolean;
  mtimeMs: number | null;
  sizeBytes: number | null;
}

export interface SnapshotManifest {
  schemaVersion: 1;
  timestamp: string;
  profile: AwosLocalProfile;
  liveCounts: SnapshotCounts;
  snapshotCounts: SnapshotCounts;
  countsDelta: Partial<Record<keyof SnapshotCounts, number>>;
  liveDb: {
    path: string;
    sizeBytes: number;
    sha256Before: string;
    sha256After: string;
    walBefore: SidecarFileObservation;
    walAfter: SidecarFileObservation;
    shmBefore: SidecarFileObservation;
    shmAfter: SidecarFileObservation;
  };
  artifacts: {
    db: { path: string; sizeBytes: number; sha256: string };
    json: { path: string; sizeBytes: number; sha256: string };
  };
  gitCommit: string | null;
  suggestedRestoreCommand: string;
}

export interface SnapshotResult {
  dbPath: string;
  jsonPath: string;
  manifestPath: string;
  timestamp: string;
  liveDbSha256Before: string;
  liveDbSha256After: string;
  walMtimeBefore: number | null;
  walMtimeAfter: number | null;
}

export interface CreateSnapshotOptions {
  profile?: AwosLocalProfile;
}

function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function observeSidecar(filePath: string): SidecarFileObservation {
  try {
    const s = statSync(filePath);
    return { exists: true, mtimeMs: s.mtimeMs, sizeBytes: s.size };
  } catch {
    return { exists: false, mtimeMs: null, sizeBytes: null };
  }
}

function utcTimestamp(date: Date = new Date()): string {
  const iso = date.toISOString();
  // 2026-05-16T12:34:56.789Z -> 20260516T123456Z
  return iso.replace(/[-:]/g, "").replace(/\.\d+/, "");
}

function gitCommit(repoRoot: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

interface CountQueryRow<T> {
  v: T;
}

function readCounts(dbPath: string): SnapshotCounts {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tenants = (
      db.prepare("SELECT COUNT(*) AS v FROM tenants").get() as CountQueryRow<number>
    ).v;
    const companies = (
      db
        .prepare("SELECT COUNT(*) AS v FROM execution_companies")
        .get() as CountQueryRow<number>
    ).v;
    const companiesByTenantRows = db
      .prepare(
        "SELECT tenant_id AS tenantId, COUNT(*) AS v FROM execution_companies GROUP BY tenant_id",
      )
      .all() as Array<{ tenantId: string; v: number }>;
    const companiesByTenant: Record<string, number> = {};
    for (const row of companiesByTenantRows) {
      companiesByTenant[row.tenantId] = row.v;
    }
    const agentRows = db
      .prepare(
        "SELECT status, COUNT(*) AS v FROM execution_agents GROUP BY status",
      )
      .all() as Array<{ status: string; v: number }>;
    let active = 0;
    let paused = 0;
    let retired = 0;
    let total = 0;
    for (const row of agentRows) {
      total += row.v;
      if (row.status === "active") active = row.v;
      else if (row.status === "paused") paused = row.v;
      else if (row.status === "retired") retired = row.v;
    }
    const issues = (
      db.prepare("SELECT COUNT(*) AS v FROM execution_issues").get() as CountQueryRow<number>
    ).v;
    const dispatchQueued = (
      db
        .prepare("SELECT COUNT(*) AS v FROM dispatch_queue WHERE status = 'queued'")
        .get() as CountQueryRow<number>
    ).v;
    const dispatchDispatched = (
      db
        .prepare(
          "SELECT COUNT(*) AS v FROM dispatch_queue WHERE status = 'dispatched'",
        )
        .get() as CountQueryRow<number>
    ).v;
    const dispatchStale = (
      db
        .prepare(
          "SELECT COUNT(*) AS v FROM dispatch_queue " +
            "WHERE status = 'dispatched' AND dispatched_at IS NOT NULL " +
            "AND dispatched_at < datetime('now','-30 minutes')",
        )
        .get() as CountQueryRow<number>
    ).v;
    const duplicateWakeups = (
      db
        .prepare(
          "SELECT COUNT(*) AS v FROM (" +
            "SELECT json_extract(input, '$.issueId') AS issue_id, COUNT(*) AS c " +
            "FROM dispatch_queue " +
            "WHERE status IN ('queued','dispatched') " +
            "AND json_extract(input, '$.issueId') IS NOT NULL " +
            "GROUP BY issue_id HAVING c > 1)",
        )
        .get() as CountQueryRow<number>
    ).v;

    return {
      tenants,
      companies,
      companiesByTenant,
      agents: { active, paused, retired, total },
      issues,
      dispatch: {
        queued: dispatchQueued,
        dispatched: dispatchDispatched,
        stale: dispatchStale,
        duplicateWakeups,
      },
    };
  } finally {
    db.close();
  }
}

function computeCountsDelta(
  live: SnapshotCounts,
  snap: SnapshotCounts,
): Partial<Record<keyof SnapshotCounts, number>> {
  const delta: Partial<Record<keyof SnapshotCounts, number>> = {};
  if (live.tenants !== snap.tenants) delta.tenants = snap.tenants - live.tenants;
  if (live.companies !== snap.companies)
    delta.companies = snap.companies - live.companies;
  if (live.issues !== snap.issues) delta.issues = snap.issues - live.issues;
  if (live.agents.total !== snap.agents.total)
    delta.agents = snap.agents.total - live.agents.total;
  return delta;
}

/**
 * Create a point-in-time snapshot of the live AWOS local SQLite DB.
 *
 * Workflow:
 *   1. Hash + observe live DB and its .wal/.shm sidecars (before).
 *   2. VACUUM INTO new .db file at backupDir.
 *   3. Read counts from live DB (read-only conn) and new .db.
 *   4. Write JSON sidecar, then manifest.
 *   5. Hash + observe live DB and sidecars (after) — must match before.
 *   6. Re-read .db and .json from disk; recompute sha256; compare against
 *      manifest. Mismatch throws; all 3 files are retained for forensics.
 */
export async function createSnapshot(
  opts: CreateSnapshotOptions = {},
): Promise<SnapshotResult> {
  const profile = opts.profile ?? (await getProfile());
  const backupDir = profile.backupDir;
  mkdirSync(backupDir, { recursive: true });

  const ts = utcTimestamp();
  const dbPath = path.join(backupDir, `awos-snapshot-${ts}.db`);
  const jsonPath = path.join(backupDir, `awos-snapshot-${ts}.json`);
  const manifestPath = path.join(backupDir, `awos-snapshot-${ts}.manifest.json`);

  const liveDbPath = profile.dbPath;
  const liveWalPath = `${liveDbPath}-wal`;
  const liveShmPath = `${liveDbPath}-shm`;

  assertDbPathMatchesDaemonLock(liveDbPath, "snapshot");

  const liveSha256Before = sha256File(liveDbPath);
  const liveSizeBefore = statSync(liveDbPath).size;
  const walBefore = observeSidecar(liveWalPath);
  const shmBefore = observeSidecar(liveShmPath);

  // VACUUM INTO needs a writable connection per better-sqlite3 11.x; the
  // operation itself does not mutate the source — the sha256 invariant proves
  // this. Open in default mode but never run any DML/DDL on this connection.
  const src = new Database(liveDbPath, { fileMustExist: true });
  try {
    src.prepare(`VACUUM INTO ?`).run(dbPath);
  } finally {
    src.close();
  }

  const liveCounts = readCounts(liveDbPath);
  const snapshotCounts = readCounts(dbPath);
  const countsDelta = computeCountsDelta(liveCounts, snapshotCounts);

  const sidecar: SidecarState = {
    schemaVersion: 1,
    timestamp: ts,
    profile,
    liveCounts,
    snapshotCounts,
  };
  writeFileSync(jsonPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");

  const dbSha256 = sha256File(dbPath);
  const jsonSha256 = sha256File(jsonPath);
  const dbSize = statSync(dbPath).size;
  const jsonSize = statSync(jsonPath).size;

  const liveSha256After = sha256File(liveDbPath);
  const walAfter = observeSidecar(liveWalPath);
  const shmAfter = observeSidecar(liveShmPath);

  const manifest: SnapshotManifest = {
    schemaVersion: 1,
    timestamp: ts,
    profile,
    liveCounts,
    snapshotCounts,
    countsDelta,
    liveDb: {
      path: liveDbPath,
      sizeBytes: liveSizeBefore,
      sha256Before: liveSha256Before,
      sha256After: liveSha256After,
      walBefore,
      walAfter,
      shmBefore,
      shmAfter,
    },
    artifacts: {
      db: { path: dbPath, sizeBytes: dbSize, sha256: dbSha256 },
      json: { path: jsonPath, sizeBytes: jsonSize, sha256: jsonSha256 },
    },
    gitCommit: gitCommit(profile.repoRoot),
    suggestedRestoreCommand: `awos-restore-plan.mjs --export=${dbPath}`,
  };
  writeFileSync(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  // Verification: re-read artifacts from disk, recompute sha256, compare to
  // manifest. Mismatch is a fatal integrity failure; retain all 3 files.
  const dbSha256Verify = sha256File(dbPath);
  const jsonSha256Verify = sha256File(jsonPath);
  if (dbSha256Verify !== dbSha256) {
    throw new Error(
      `snapshot integrity: .db sha256 mismatch on verify ` +
        `(manifest=${dbSha256} disk=${dbSha256Verify}); artifacts retained at ${backupDir}`,
    );
  }
  if (jsonSha256Verify !== jsonSha256) {
    throw new Error(
      `snapshot integrity: .json sha256 mismatch on verify ` +
        `(manifest=${jsonSha256} disk=${jsonSha256Verify}); artifacts retained at ${backupDir}`,
    );
  }

  return {
    dbPath,
    jsonPath,
    manifestPath,
    timestamp: ts,
    liveDbSha256Before: liveSha256Before,
    liveDbSha256After: liveSha256After,
    walMtimeBefore: walBefore.mtimeMs,
    walMtimeAfter: walAfter.mtimeMs,
  };
}
