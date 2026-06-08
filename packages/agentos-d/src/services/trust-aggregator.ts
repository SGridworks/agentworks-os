/**
 * Trust aggregator — assembles the enriched /api/admin/trust response from
 * DB, filesystem, and network state. Pure: no side effects.
 */

import { access, stat, readdir as readdirAsync, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { constants } from "node:fs";
import { dirname, join, basename } from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import net from "node:net";
import Database from "better-sqlite3";
import type { AwosLocalProfile } from "../config/local-profile.schema.js";
import type { ProfileDriftCode } from "../config/local-profile.schema.js";

export interface TrustDaemon {
  readonly pid: number;
  readonly version: string;
  readonly startedAt: string;
  readonly uptimeS: number;
}

export interface TrustDb {
  readonly path: string;
  readonly sizeBytes: number;
  readonly usingProfile: boolean;
  readonly writable: boolean;
  readonly identity: {
    readonly current: string | null;
    readonly daemonLock: string | null;
    readonly matchesDaemonLock: boolean | null;
  };
}

export interface TrustVault {
  readonly path: string;
  readonly fileCount: number;
  readonly manifestUpdatedAt: string | null;
}

export interface TrustProfile {
  readonly loaded: boolean;
  readonly path: string | null;
  readonly version: number | null;
  readonly drift: ProfileDriftCode[];
}

export interface TrustCompany {
  readonly name: string;
  readonly expected: boolean;
  readonly present: boolean;
  readonly status: string | null;
}

export interface TrustDispatch {
  readonly queued: number;
  readonly dispatched: number;
  readonly stale: number;
  readonly duplicateWakeups: number;
}

export interface TrustBackup {
  readonly backupDir: string;
  readonly latestSnapshot: string | null;
  readonly latestVerifiedAt: string | null;
}

export interface TrustInspector {
  readonly listening: boolean;
}

export interface TrustResponse {
  readonly daemon: TrustDaemon;
  readonly db: TrustDb;
  readonly vault: TrustVault;
  readonly profile: TrustProfile;
  readonly companies: TrustCompany[];
  readonly agents: { readonly active: number; readonly paused: number; readonly retired: number };
  readonly providers: unknown[];
  readonly dispatch: TrustDispatch;
  readonly backup: TrustBackup;
  readonly inspector: TrustInspector;
  readonly warnings: string[];
}

export interface AggregatorDeps {
  readonly daemonVersion: string;
  readonly dbPath: string;
  readonly profile: AwosLocalProfile | null;
  readonly profilePath: string | null;
  readonly profileDrift: ProfileDriftCode[];
  readonly providers: unknown[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function isWritable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function identityFromStat(s: Awaited<ReturnType<typeof stat>>): string {
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`;
}

async function daemonLockIdentity(dbPath: string): Promise<string | null> {
  const lockPath = join(dirname(dbPath), ".awos-daemon.lock");
  try {
    const raw = await readFile(lockPath, "utf-8");
    const parsed = JSON.parse(raw) as { openDbIdentity?: unknown };
    return typeof parsed.openDbIdentity === "string" ? parsed.openDbIdentity : null;
  } catch {
    return null;
  }
}

async function probeInspectorPort(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: 9229 });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 100);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function vaultStats(vaultDir: string): Promise<{ fileCount: number; manifestUpdatedAt: string | null }> {
  let fileCount = 0;
  let manifestUpdatedAt: string | null = null;

  if (!existsSync(vaultDir)) {
    return { fileCount, manifestUpdatedAt };
  }

  async function walk(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await readdirAsync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const fullPath = join(dir, name);
      let s: Awaited<ReturnType<typeof stat>>;
      try {
        s = await stat(fullPath);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        await walk(fullPath);
      } else if (s.isFile() && name.endsWith(".md")) {
        fileCount++;
      } else if (
        s.isFile() &&
        (name === "MANIFEST.json" || name === ".manifest.json")
      ) {
        const updatedAt = s.mtime.toISOString();
        if (manifestUpdatedAt === null || updatedAt > manifestUpdatedAt) {
          manifestUpdatedAt = updatedAt;
        }
      }
    }
  }

  await walk(vaultDir);
  return { fileCount, manifestUpdatedAt };
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function latestSnapshot(backupDir: string): Promise<{
  latestSnapshot: string | null;
  latestVerifiedAt: string | null;
}> {
  if (!existsSync(backupDir)) {
    return { latestSnapshot: null, latestVerifiedAt: null };
  }

  let entries: string[];
  try {
    entries = await readdirAsync(backupDir);
  } catch {
    return { latestSnapshot: null, latestVerifiedAt: null };
  }

  const manifests = entries
    .filter((f) => /^awos-snapshot-.+\.manifest\.json$/.test(f))
    .sort()
    .reverse();

  const latestManifest = manifests[0];
  if (latestManifest === undefined) {
    return { latestSnapshot: null, latestVerifiedAt: null };
  }

  const manifestPath = join(backupDir, latestManifest);
  let manifest: Record<string, unknown>;
  try {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(manifestPath, "utf8");
    manifest = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { latestSnapshot: latestManifest, latestVerifiedAt: null };
  }

  // Verify sha256 of the .db artifact. Do not report latestVerifiedAt unless
  // the artifact path exists and its checksum matches the manifest.
  const artifacts = manifest["artifacts"] as Record<string, unknown> | undefined;
  const dbArtifactRecord =
    artifacts !== undefined && artifacts !== null && typeof artifacts === "object"
      ? (artifacts["db"] as Record<string, unknown> | undefined)
      : undefined;
  const dbArtifact =
    typeof dbArtifactRecord?.["path"] === "string"
      ? dbArtifactRecord["path"]
      : manifest["dbArtifactPath"];
  const dbSha256 =
    typeof dbArtifactRecord?.["sha256"] === "string"
      ? dbArtifactRecord["sha256"]
      : manifest["dbArtifactSha256"];
  const timestamp = manifest["timestamp"];

  if (
    typeof dbArtifact === "string" &&
    typeof dbSha256 === "string" &&
    existsSync(dbArtifact)
  ) {
    try {
      const actualSha256 = await sha256File(dbArtifact);
      if (actualSha256 !== dbSha256) {
        return { latestSnapshot: latestManifest, latestVerifiedAt: null };
      }
      return {
        latestSnapshot: latestManifest,
        latestVerifiedAt: typeof timestamp === "string" ? timestamp : null,
      };
    } catch {
      return { latestSnapshot: latestManifest, latestVerifiedAt: null };
    }
  }

  return { latestSnapshot: latestManifest, latestVerifiedAt: null };
}

interface CompanyRow {
  name: string;
  status: string;
}

function queryCompanies(
  sqlite: Database.Database,
  tenantId: string,
  expectedNames: string[],
): TrustCompany[] {
  let rows: CompanyRow[];
  try {
    rows = sqlite
      .prepare(
        "SELECT name, status FROM execution_companies WHERE tenant_id = ?",
      )
      .all(tenantId) as CompanyRow[];
  } catch {
    rows = [];
  }

  const byName = new Map<string, CompanyRow>();
  for (const row of rows) {
    byName.set(row.name, row);
  }

  const result: TrustCompany[] = expectedNames.map((name) => {
    const row = byName.get(name);
    return {
      name,
      expected: true,
      present: row !== undefined,
      status: row !== undefined ? row.status : null,
    };
  });

  // Also surface unexpected companies (present = true, expected = false)
  for (const [name, row] of byName) {
    if (!expectedNames.includes(name)) {
      result.push({ name, expected: false, present: true, status: row.status });
    }
  }

  return result;
}

interface DispatchCountRow {
  status: string;
  n: number;
}

interface DupRow {
  issue_id: string;
  cnt: number;
}

function queryDispatch(
  sqlite: Database.Database,
  tenantId: string,
): TrustDispatch {
  const staleThresholdMs = 30 * 60 * 1000;
  const staleThresholdIso = new Date(Date.now() - staleThresholdMs).toISOString();

  let queued = 0;
  let dispatched = 0;
  let stale = 0;
  let duplicateWakeups = 0;

  try {
    const rows = sqlite
      .prepare(
        "SELECT status, COUNT(*) AS n FROM dispatch_queue WHERE tenant_id = ? GROUP BY status",
      )
      .all(tenantId) as DispatchCountRow[];
    for (const row of rows) {
      if (row.status === "queued") queued = row.n;
      else if (row.status === "dispatched") dispatched = row.n;
    }
  } catch {
    // table may not exist
  }

  try {
    const staleRow = sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM dispatch_queue WHERE tenant_id = ? AND status = 'dispatched' AND dispatched_at <= ?",
      )
      .get(tenantId, staleThresholdIso) as { n: number } | undefined;
    stale = staleRow?.n ?? 0;
  } catch {
    // ignore
  }

  try {
    const dupRows = sqlite
      .prepare(
        `SELECT json_extract(input, '$.issueId') AS issue_id, COUNT(*) AS cnt
         FROM dispatch_queue
         WHERE tenant_id = ?
           AND status IN ('queued', 'dispatched')
           AND json_extract(input, '$.issueId') IS NOT NULL
         GROUP BY json_extract(input, '$.issueId')
         HAVING COUNT(*) > 1`,
      )
      .all(tenantId) as DupRow[];
    duplicateWakeups = dupRows.length;
  } catch {
    // ignore
  }

  return { queued, dispatched, stale, duplicateWakeups };
}

function queryAgents(
  sqlite: Database.Database,
): { active: number; paused: number; retired: number } {
  let active = 0;
  let paused = 0;
  let retired = 0;
  try {
    const rows = sqlite
      .prepare(
        "SELECT status, COUNT(*) AS n FROM execution_agents GROUP BY status",
      )
      .all() as Array<{ status: string; n: number }>;
    for (const row of rows) {
      if (row.status === "active") active = row.n;
      else if (row.status === "paused") paused = row.n;
      else if (row.status === "retired") retired = row.n;
    }
  } catch {
    // ignore
  }
  return { active, paused, retired };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function aggregateTrust(deps: AggregatorDeps): Promise<TrustResponse> {
  const now = Date.now();
  const startedAt = new Date(now - process.uptime() * 1000).toISOString();
  const uptimeS = Math.round(process.uptime());

  const { daemonVersion, dbPath, profile, profilePath, profileDrift, providers } = deps;

  // DB stats
  let dbSizeBytes = 0;
  let dbWritable = false;
  let currentDbIdentity: string | null = null;
  const daemonDbIdentity = await daemonLockIdentity(dbPath);
  try {
    const s = await stat(dbPath);
    dbSizeBytes = s.size;
    currentDbIdentity = identityFromStat(s);
    dbWritable = await isWritable(dbPath);
  } catch {
    // db may not exist yet
  }
  const dbIdentityMatchesDaemonLock =
    daemonDbIdentity && currentDbIdentity ? daemonDbIdentity === currentDbIdentity : null;

  const usingProfile = profile !== null;

  // Vault stats
  const vaultDir =
    profile?.vaultRoot ??
    process.env.VAULT_ROOT ??
    join(process.env.HOME ?? "/", "vault");
  const { fileCount: vaultFileCount, manifestUpdatedAt } = await vaultStats(vaultDir);

  // Inspector probe
  const inspectorListening = await probeInspectorPort();

  // Profile info
  const trustProfile: TrustProfile = {
    loaded: profile !== null,
    path: profilePath,
    version: profile?.version ?? null,
    drift: profileDrift,
  };

  // Backup info
  const backupDir = profile?.backupDir ?? join(process.env.HOME ?? "/", "backups", "awos-local");
  const { latestSnapshot: latestSnapshotName, latestVerifiedAt } = await latestSnapshot(backupDir);

  // DB queries (use a dedicated readonly connection to avoid touching the daemon's WAL state)
  let sqlite: Database.Database | null = null;
  let agents = { active: 0, paused: 0, retired: 0 };
  let companies: TrustCompany[] = [];
  let dispatch: TrustDispatch = { queued: 0, dispatched: 0, stale: 0, duplicateWakeups: 0 };

  const tenantId = profile?.tenantId ?? "00000000-0000-4000-8000-000000000001";
  const expectedCompanies = profile?.expectedCompanies ?? [];

  try {
    if (existsSync(dbPath)) {
      sqlite = new Database(dbPath, { readonly: true });
      agents = queryAgents(sqlite);
      companies = queryCompanies(sqlite, tenantId, expectedCompanies);
      dispatch = queryDispatch(sqlite, tenantId);
    }
  } catch {
    // DB inaccessible — leave defaults
  } finally {
    try {
      sqlite?.close();
    } catch {
      // ignore
    }
  }

  // Warnings
  const warnings: string[] = [];

  if (dbSizeBytes === 0) warnings.push("zero-byte-db");

  if (profileDrift.includes("dbPath-mismatch")) {
    warnings.push("profile-db-path-mismatch");
  }

  if (dbIdentityMatchesDaemonLock === false) {
    warnings.push("db-identity-mismatch");
  }

  if (companies.some((c) => c.expected && !c.present)) {
    warnings.push("missing-expected-company");
  }

  if (inspectorListening) warnings.push("inspector-exposed");

  if (!existsSync(vaultDir)) warnings.push("missing-vault-root");

  if (agents.active === 0) warnings.push("no-active-agents");

  if (dispatch.stale > 0) warnings.push("stale-dispatch");

  if (dispatch.duplicateWakeups > 0) warnings.push("duplicate-queued-wakeup");

  if (manifestUpdatedAt !== null) {
    const age = Date.now() - new Date(manifestUpdatedAt).getTime();
    if (age > 24 * 60 * 60 * 1000) warnings.push("vault-manifest-stale");
  }

  return {
    daemon: {
      pid: process.pid,
      version: daemonVersion,
      startedAt,
      uptimeS,
    },
    db: {
      path: dbPath,
      sizeBytes: dbSizeBytes,
      usingProfile,
      writable: dbWritable,
      identity: {
        current: currentDbIdentity,
        daemonLock: daemonDbIdentity,
        matchesDaemonLock: dbIdentityMatchesDaemonLock,
      },
    },
    vault: {
      path: vaultDir,
      fileCount: vaultFileCount,
      manifestUpdatedAt,
    },
    profile: trustProfile,
    companies,
    agents,
    providers,
    dispatch,
    backup: {
      backupDir,
      latestSnapshot: latestSnapshotName,
      latestVerifiedAt,
    },
    inspector: {
      listening: inspectorListening,
    },
    warnings,
  };
}

// Stable warning code strings exported for use in tests
export const WARNING_CODES = {
  ZERO_BYTE_DB: "zero-byte-db",
  DB_IDENTITY_MISMATCH: "db-identity-mismatch",
  PROFILE_DB_PATH_MISMATCH: "profile-db-path-mismatch",
  MISSING_EXPECTED_COMPANY: "missing-expected-company",
  INSPECTOR_EXPOSED: "inspector-exposed",
  MISSING_VAULT_ROOT: "missing-vault-root",
  NO_ACTIVE_AGENTS: "no-active-agents",
  STALE_DISPATCH: "stale-dispatch",
  DUPLICATE_QUEUED_WAKEUP: "duplicate-queued-wakeup",
  VAULT_MANIFEST_STALE: "vault-manifest-stale",
} as const;
