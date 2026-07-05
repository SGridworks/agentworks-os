import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";

export interface DaemonLockInfo {
  pid: number;
  startTime: string;
  dbPath: string;
  openDbIdentity: string;
  /** Entry path (process.argv[1]) of the daemon that wrote the lock. Used to
   * tell a real daemon from an unrelated process that recycled its PID. */
  command?: string;
}

/** Injectable probes so the reuse logic is testable without real processes. */
export interface AcquireLockDeps {
  /** True if `pid` is a live process (any owner). Default: process.kill(pid, 0). */
  isPidAlive?: (pid: number) => boolean;
  /** Full command line for `pid`, or null if it can't be determined. Default: ps. */
  readProcessCommand?: (pid: number) => string | null;
}

export async function acquireLock(
  dataDir: string,
  deps: AcquireLockDeps = {},
): Promise<DaemonLockInfo> {
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  const readProcessCommand = deps.readProcessCommand ?? defaultReadProcessCommand;
  const lockPath = join(dataDir, ".awos-daemon.lock");

  let existing: DaemonLockInfo | null = null;
  try {
    existing = JSON.parse(await fs.readFile(lockPath, "utf-8")) as DaemonLockInfo;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A missing or corrupt lock file does not prove another daemon is alive.
    if (code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }

  if (existing && heldByLiveDaemon(existing, isPidAlive, readProcessCommand)) {
    throw new Error(`Another instance is already running (PID ${existing.pid}).`);
  }

  // No lock, a dead PID, or a PID that has been recycled by an unrelated
  // process (the lock's owner exited uncleanly). Reclaim it.
  await fs.unlink(lockPath).catch(() => {});
  return writeLock(lockPath, dataDir);
}

/**
 * A bare `process.kill(pid, 0)` only proves the PID is alive. On macOS/Linux a
 * dead daemon's PID is quickly recycled (e.g. keyboardservicesd), which the
 * naive check misreads as "still running" and wedges startup. Confirm the live
 * PID is actually running this daemon's entry before treating the lock as held.
 * Fail-safe: when we cannot tell, keep the lock (better a spurious refusal than
 * two daemons writing one DB).
 */
function heldByLiveDaemon(
  existing: DaemonLockInfo,
  isPidAlive: (pid: number) => boolean,
  readProcessCommand: (pid: number) => string | null,
): boolean {
  if (!isPidAlive(existing.pid)) return false;
  const command = readProcessCommand(existing.pid);
  if (command === null) return true;
  return commandIsThisDaemon(command, existing);
}

function commandIsThisDaemon(command: string, existing: DaemonLockInfo): boolean {
  const entries = [existing.command, process.argv[1]].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  for (const entry of entries) {
    if (command.includes(entry)) return true;
    const base = basename(entry);
    if (base && command.includes(base)) return true;
  }
  return false;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive but owned by another user (so never our daemon, which runs
    // as us — the command check will confirm and reclaim). ESRCH: no process.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultReadProcessCommand(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

async function writeLock(lockPath: string, dataDir: string): Promise<DaemonLockInfo> {
  const currentPid = process.pid;
  const startTime = new Date().toISOString();
  const dbPath = join(dataDir, "agentworks.db");
  const openDbIdentity = await identityForPath(dbPath);
  const command = process.argv[1];

  const lockInfo: DaemonLockInfo = {
    pid: currentPid,
    startTime,
    dbPath,
    openDbIdentity,
    ...(command ? { command } : {}),
  };
  await fs.mkdir(dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, JSON.stringify(lockInfo, null, 2), "utf-8");
  return lockInfo;
}

async function identityForPath(dbPath: string): Promise<string> {
  try {
    const stats = await fs.stat(dbPath);
    return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    throw error;
  }
}

export async function releaseLock(dataDir: string): Promise<void> {
  const lockPath = join(dataDir, ".awos-daemon.lock");
  try {
    await fs.unlink(lockPath);
  } catch (e) {
    // ignore; lock may have already been removed
  }
}
