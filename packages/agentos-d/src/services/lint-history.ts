/**
 * Lint report history — file-backed diff helpers for the /api/memory/lint/diff
 * route. No new SQLite tables; the report is its own audit log.
 *
 * Storage layout:
 *   <vaultRoot>/<tenantId>/wiki/lint-history/<runId>-<shortIso>.json
 *
 * Each file is a self-contained LintReport (tenantId, ranAt, runId,
 * pageCount, findings, totals, executed). Reading the directory in
 * mtime order gives the chronological history; matching on runId or
 * ISO timestamp pins the baseline.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { LintReport, LintFinding } from "@agentworks/memory";

const FILENAME_RE = /^([0-9a-f]{16})-(\d{4}-\d{2}-\d{2}T.+)\.json$/;

interface StoredReport {
  runId: string;
  ranAt: string;
  filename: string;
  mtimeMs: number;
  report: LintReport;
}

async function readReportFile(absPath: string): Promise<StoredReport | null> {
  let raw: string;
  try {
    raw = await fs.readFile(absPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: LintReport;
  try {
    parsed = JSON.parse(raw) as LintReport;
  } catch {
    // Corrupt file — skip silently. Future work could quarantine.
    return null;
  }
  const m = parsed.runId.match(/^[0-9a-f]{16}$/);
  if (!m) return null;
  const st = await fs.stat(absPath);
  return {
    runId: parsed.runId,
    ranAt: parsed.ranAt,
    filename: absPath,
    mtimeMs: st.mtimeMs,
    report: parsed,
  };
}

export async function listStoredReports(historyDir: string): Promise<StoredReport[]> {
  let names: string[];
  try {
    names = await fs.readdir(historyDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const reports: StoredReport[] = [];
  for (const name of names) {
    if (!FILENAME_RE.test(name)) continue;
    const r = await readReportFile(join(historyDir, name));
    if (r) reports.push(r);
  }
  reports.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return reports;
}

/**
 * Resolve which stored report is the "previous" baseline:
 *   - since === runId  → exact match
 *   - since === ISO    → most recent stored report with ranAt < since
 *   - since undefined  → most recent stored report
 *
 * **`requiredExecuted`:** if provided, the resolved baseline MUST
 * have the same `executed` check set (compared as a sorted
 * canonical string). This is how /lint/diff prevents a subset run
 * from being silently compared against a full run — the finding
 * sets aren't comparable.
 *
 * When no matching baseline exists, returns null. Callers must NOT
 * silently fall back to "most recent of any kind"; they should
 * surface `baselineReason: "no_matching_baseline"` to the caller
 * instead of a fake diff.
 */
export async function readPreviousReport(
  historyDir: string,
  since: string | undefined,
  requiredExecuted?: readonly string[],
): Promise<LintReport | null> {
  const all = await listStoredReports(historyDir);
  if (all.length === 0) return null;

  const matchesExecuted = (r: LintReport): boolean => {
    if (!requiredExecuted) return true;
    const cur = [...(r.executed ?? [])].sort().join(",");
    const want = [...requiredExecuted].sort().join(",");
    return cur === want;
  };

  if (!since) {
    // Walk backward from the most recent, find the latest that
    // matches the required executed set.
    for (let i = all.length - 1; i >= 0; i--) {
      const r = all[i]?.report;
      if (r && matchesExecuted(r)) return r;
    }
    return null;
  }

  // Exact runId match first (must also match the executed set).
  const exact = all.find((r) => r.runId === since);
  if (exact && matchesExecuted(exact.report)) return exact.report;

  // ISO timestamp: most recent stored report strictly older that
  // also matches the executed set.
  const before = all.filter((r) => r.ranAt < since);
  for (let i = before.length - 1; i >= 0; i--) {
    const r = before[i]?.report;
    if (r && matchesExecuted(r)) return r;
  }
  return null;
}

export async function writeReportToHistory(
  historyDir: string,
  report: LintReport,
): Promise<string> {
  await fs.mkdir(historyDir, { recursive: true });
  // Filename: <runId>-<iso>.json. ISO is sanitized for filename use.
  const iso = report.ranAt.replace(/[:.]/g, "-");
  const filename = `${report.runId}-${iso}.json`;
  const abs = join(historyDir, filename);
  // Atomic: write to .tmp then rename.
  const tmp = `${abs}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(report, null, 2), "utf8");
  await fs.rename(tmp, abs);
  return abs;
}

// ── Diff helpers ────────────────────────────────────────────────────────────

function findingKey(f: LintFinding): string {
  return `${f.kind}\0${f.path}\0${f.severity}\0${f.message}\0${f.detail ?? ""}`;
}

function keySet(report: LintReport | null): Set<string> {
  return new Set((report?.findings ?? []).map(findingKey));
}

export function diffAdded(
  previous: LintReport | null,
  current: LintReport,
): LintFinding[] {
  const prev = keySet(previous);
  return current.findings.filter((f) => !prev.has(findingKey(f)));
}

export function diffRemoved(
  previous: LintReport | null,
  current: LintReport,
): LintFinding[] {
  const cur = keySet(current);
  return (previous?.findings ?? []).filter((f) => !cur.has(findingKey(f)));
}

export interface LintDiffSummary {
  added: number;
  removed: number;
  unchanged: number;
  byKindAdded: Record<string, number>;
  byKindRemoved: Record<string, number>;
  bySeverityAdded: Record<string, number>;
}

export function diffSummary(
  previous: LintReport | null,
  current: LintReport,
): LintDiffSummary {
  const added = diffAdded(previous, current);
  const removed = diffRemoved(previous, current);
  const prev = keySet(previous);
  const cur = keySet(current);
  let unchanged = 0;
  for (const k of cur) if (prev.has(k)) unchanged++;

  const byKindAdded: Record<string, number> = {};
  for (const f of added) byKindAdded[f.kind] = (byKindAdded[f.kind] ?? 0) + 1;
  const byKindRemoved: Record<string, number> = {};
  for (const f of removed) byKindRemoved[f.kind] = (byKindRemoved[f.kind] ?? 0) + 1;
  const bySeverityAdded: Record<string, number> = {};
  for (const f of added) bySeverityAdded[f.severity] = (bySeverityAdded[f.severity] ?? 0) + 1;

  return {
    added: added.length,
    removed: removed.length,
    unchanged,
    byKindAdded,
    byKindRemoved,
    bySeverityAdded,
  };
}
