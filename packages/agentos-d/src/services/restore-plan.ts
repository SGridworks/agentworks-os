/**
 * Restore-plan validator (Agent 4, AWOS Local Reliability Sprint).
 *
 * DRY-RUN ONLY. This module exists to reason about what a FUTURE
 * `awos-restore-apply` command would do, without ever performing one.
 *
 * Hard invariants (proven by restore-plan.test.ts):
 *   1. Live DB is opened with `readonly: true`. EVER. No writable handle.
 *   2. Export DB is opened with `readonly: true`. EVER. No writable handle.
 *   3. sha256(live DB) before == sha256(live DB) after. If not, throw.
 *   4. The validator never starts/stops/signals a daemon, never writes the
 *      snapshot directory, never touches WAL/SHM of the live DB.
 *   5. `futureApplyCommand` is PRINTED only. Nothing here executes it.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { AwosLocalProfile } from "../config/local-profile.schema.js";
import { getProfile } from "../config/local-profile.js";

export interface Counts {
  readonly tenants: number;
  readonly executionCompanies: number;
  readonly agentsActive: number;
  readonly agentsPaused: number;
  readonly agentsRetired: number;
  readonly issuesTotal: number;
  readonly dispatchQueued: number;
  readonly dispatchDispatched: number;
  readonly dispatchStale: number;
  readonly dispatchDuplicates: number;
}

export type CountDiff = {
  readonly [K in keyof Counts]: number;
};

export interface WalShmState {
  readonly walPresent: boolean;
  readonly shmPresent: boolean;
  readonly walSize: number | null;
  readonly shmSize: number | null;
}

export interface RestorePlanResult {
  readonly exportPath: string;
  readonly manifestPath: string;
  readonly manifestVerified: boolean;
  readonly live: {
    readonly path: string;
    readonly sizeBytes: number;
    readonly sha256: string;
  };
  readonly liveCounts: Counts;
  readonly exportCounts: Counts;
  readonly expectedPostRestoreCounts: Counts;
  readonly diff: CountDiff;
  readonly walShmAtLive: WalShmState;
  readonly futureApplyCommand: string;
  readonly rollbackCommand: string;
  readonly requiredConfirmationToken: string;
  readonly liveDbSha256Before: string;
  readonly liveDbSha256After: string;
}

export interface PlanRestoreOptions {
  readonly exportPath: string;
  readonly profile?: AwosLocalProfile;
  /** Threshold in minutes after which a `dispatched` row is considered stale. */
  readonly staleDispatchedThresholdMin?: number;
  /** Override the live DB path. Used by tests. Defaults to profile.dbPath. */
  readonly liveDbPathOverride?: string;
  /** Where to write best-effort JSONL audit log. Defaults under HOME. */
  readonly auditLogDir?: string;
}

const DEFAULT_STALE_THRESHOLD_MIN = 30;

const ZERO_COUNTS: Counts = {
  tenants: 0,
  executionCompanies: 0,
  agentsActive: 0,
  agentsPaused: 0,
  agentsRetired: 0,
  issuesTotal: 0,
  dispatchQueued: 0,
  dispatchDispatched: 0,
  dispatchStale: 0,
  dispatchDuplicates: 0,
};

function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function sha256OfString(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function deriveManifestPath(exportPath: string): string {
  // Snapshot artifacts are siblings: awos-snapshot-<ts>.db + .manifest.json.
  const dir = path.dirname(exportPath);
  const base = path.basename(exportPath);
  const stem = base.endsWith(".db") ? base.slice(0, -3) : base;
  return path.join(dir, `${stem}.manifest.json`);
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table) as { present: number } | undefined;
  return row?.present === 1;
}

function countSimple(
  db: Database.Database,
  table: string,
  where?: { col: string; val: string },
): number {
  if (!tableExists(db, table)) return 0;
  const sql = where
    ? `SELECT COUNT(*) AS n FROM ${table} WHERE ${where.col} = ?`
    : `SELECT COUNT(*) AS n FROM ${table}`;
  const stmt = db.prepare(sql);
  const row = (where ? stmt.get(where.val) : stmt.get()) as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

function readCounts(
  db: Database.Database,
  staleThresholdMin: number,
): Counts {
  const tenants = countSimple(db, "tenants");
  const executionCompanies = countSimple(db, "execution_companies");
  const agentsActive = countSimple(db, "execution_agents", {
    col: "status",
    val: "active",
  });
  const agentsPaused = countSimple(db, "execution_agents", {
    col: "status",
    val: "paused",
  });
  const agentsRetired = countSimple(db, "execution_agents", {
    col: "status",
    val: "retired",
  });
  const issuesTotal = countSimple(db, "execution_issues");

  let dispatchQueued = 0;
  let dispatchDispatched = 0;
  let dispatchStale = 0;
  let dispatchDuplicates = 0;

  if (tableExists(db, "dispatch_queue")) {
    dispatchQueued = countSimple(db, "dispatch_queue", {
      col: "status",
      val: "queued",
    });
    dispatchDispatched = countSimple(db, "dispatch_queue", {
      col: "status",
      val: "dispatched",
    });

    // dispatched_at is ISO string; compare as ISO lexically against threshold.
    const cutoffIso = new Date(
      Date.now() - staleThresholdMin * 60_000,
    ).toISOString();
    const staleRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM dispatch_queue
         WHERE status = 'dispatched'
           AND dispatched_at IS NOT NULL
           AND dispatched_at < ?`,
      )
      .get(cutoffIso) as { n: number } | undefined;
    dispatchStale = staleRow?.n ?? 0;

    // Duplicate queued wakeups: same issueId (json_extract($.issueId)) appearing
    // in >1 active (queued|dispatched) rows. issueId can live under $.issueId
    // or $.payload.issueId per the wake-on-assign daemon hardening memo.
    const dupRow = db
      .prepare(
        `WITH active AS (
           SELECT COALESCE(
             json_extract(input, '$.issueId'),
             json_extract(input, '$.payload.issueId')
           ) AS issue_id
           FROM dispatch_queue
           WHERE status IN ('queued','dispatched')
         )
         SELECT COUNT(*) AS n FROM (
           SELECT issue_id FROM active
           WHERE issue_id IS NOT NULL
           GROUP BY issue_id HAVING COUNT(*) > 1
         )`,
      )
      .get() as { n: number } | undefined;
    dispatchDuplicates = dupRow?.n ?? 0;
  }

  return {
    tenants,
    executionCompanies,
    agentsActive,
    agentsPaused,
    agentsRetired,
    issuesTotal,
    dispatchQueued,
    dispatchDispatched,
    dispatchStale,
    dispatchDuplicates,
  };
}

function diffCounts(live: Counts, exp: Counts): CountDiff {
  const keys = Object.keys(ZERO_COUNTS) as Array<keyof Counts>;
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = (live[k] ?? 0) - (exp[k] ?? 0);
  return out as CountDiff;
}

function readWalShm(livePath: string): WalShmState {
  const walPath = `${livePath}-wal`;
  const shmPath = `${livePath}-shm`;
  const walPresent = existsSync(walPath);
  const shmPresent = existsSync(shmPath);
  return {
    walPresent,
    shmPresent,
    walSize: walPresent ? statSync(walPath).size : null,
    shmSize: shmPresent ? statSync(shmPath).size : null,
  };
}

function withReadonlyDb<T>(
  filePath: string,
  fn: (db: Database.Database) => T,
): T {
  // better-sqlite3 11.x: `readonly: true` opens SQLITE_OPEN_READONLY. Combined
  // with fileMustExist we get a hard refusal if anything attempts a write.
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

interface RawManifest {
  readonly export?: { readonly path?: string; readonly sha256?: string };
  readonly db?: { readonly path?: string; readonly sha256?: string };
  readonly artifact?: { readonly path?: string; readonly sha256?: string };
  readonly artifacts?: {
    readonly db?: { readonly path?: string; readonly sha256?: string };
  };
  readonly sha256?: string;
  readonly [k: string]: unknown;
}

function extractClaimedExportSha(manifest: RawManifest): string | null {
  // Prefer the sprint snapshot manifest shape, then tolerate older shapes.
  if (manifest.artifacts?.db?.sha256) return manifest.artifacts.db.sha256;
  if (manifest.export?.sha256) return manifest.export.sha256;
  if (manifest.db?.sha256) return manifest.db.sha256;
  if (manifest.artifact?.sha256) return manifest.artifact.sha256;
  if (typeof manifest.sha256 === "string") return manifest.sha256;
  return null;
}

async function bestEffortAudit(
  auditDir: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await mkdir(auditDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...payload })}\n`;
    await appendFile(path.join(auditDir, `${stamp}.jsonl`), line, "utf8");
  } catch {
    // Audit is best-effort. A failure here MUST NOT break the validator —
    // the validator is the safety net, and the audit log is decoration.
  }
}

export async function planRestore(
  opts: PlanRestoreOptions,
): Promise<RestorePlanResult> {
  const exportPath = path.resolve(opts.exportPath);
  if (!existsSync(exportPath)) {
    throw new Error(`export not found at ${exportPath}`);
  }
  const exportStat = statSync(exportPath);
  if (!exportStat.isFile()) {
    throw new Error(`export path is not a file: ${exportPath}`);
  }
  if (!exportPath.endsWith(".db")) {
    throw new Error(`export must be a .db file: ${exportPath}`);
  }

  const manifestPath = deriveManifestPath(exportPath);
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest not found at ${manifestPath}`);
  }

  const manifestRaw = await readFile(manifestPath, "utf8");
  let manifest: RawManifest;
  try {
    manifest = JSON.parse(manifestRaw) as RawManifest;
  } catch (err) {
    throw new Error(
      `manifest at ${manifestPath} is not valid JSON: ${(err as Error).message}`,
    );
  }

  const claimedExportSha = extractClaimedExportSha(manifest);
  const actualExportSha = await sha256OfFile(exportPath);
  const manifestVerified =
    claimedExportSha !== null && claimedExportSha === actualExportSha;

  const profile = opts.profile ?? (await getProfile());
  const livePath = opts.liveDbPathOverride ?? profile.dbPath;

  if (!existsSync(livePath)) {
    throw new Error(`live DB not found at ${livePath}`);
  }

  const liveDbSha256Before = await sha256OfFile(livePath);
  const liveSizeBytes = statSync(livePath).size;
  const walShm = readWalShm(livePath);

  const staleThreshold =
    opts.staleDispatchedThresholdMin ?? DEFAULT_STALE_THRESHOLD_MIN;

  const liveCounts = withReadonlyDb(livePath, (db) =>
    readCounts(db, staleThreshold),
  );
  const exportCounts = withReadonlyDb(exportPath, (db) =>
    readCounts(db, staleThreshold),
  );

  const requiredConfirmationToken = sha256OfString(manifestRaw);
  const futureApplyCommand = `awos-restore-apply --export=${exportPath} --confirm=${requiredConfirmationToken}`;
  const rollbackCommand = profile.lastKnownGoodSnapshot
    ? `awos-restore-apply --export=${profile.lastKnownGoodSnapshot} --confirm=<sha256 of that manifest>`
    : `# no lastKnownGoodSnapshot in profile — run \`awos-snapshot.mjs\` BEFORE any future apply, then keep that path as the rollback target`;

  const liveDbSha256After = await sha256OfFile(livePath);
  if (liveDbSha256After !== liveDbSha256Before) {
    throw new Error(
      "INVARIANT VIOLATED: live DB sha256 changed during restore-plan run. " +
        "This should be impossible — the validator only opens readonly handles. " +
        "Halting to prevent any downstream apply.",
    );
  }

  const result: RestorePlanResult = {
    exportPath,
    manifestPath,
    manifestVerified,
    live: {
      path: livePath,
      sizeBytes: liveSizeBytes,
      sha256: liveDbSha256Before,
    },
    liveCounts,
    exportCounts,
    expectedPostRestoreCounts: exportCounts,
    diff: diffCounts(liveCounts, exportCounts),
    walShmAtLive: walShm,
    futureApplyCommand,
    rollbackCommand,
    requiredConfirmationToken,
    liveDbSha256Before,
    liveDbSha256After,
  };

  const auditDir =
    opts.auditLogDir ?? path.join(homedir(), ".agentworks", "logs", "restore-plan");
  await bestEffortAudit(auditDir, {
    exportPath,
    manifestPath,
    manifestVerified,
    liveSha256: liveDbSha256Before,
    futureApplyCommand,
  });

  return result;
}
