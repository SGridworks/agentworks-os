import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

interface DaemonLockInfo {
  pid: number;
  startTime?: string;
  dbPath?: string;
  openDbIdentity?: string;
}

function readDaemonLock(dataDir: string): DaemonLockInfo | null {
  const lockPath = join(dataDir, ".awos-daemon.lock");
  if (!existsSync(lockPath)) return null;
  try {
    return JSON.parse(readFileSync(lockPath, "utf-8")) as DaemonLockInfo;
  } catch {
    throw new Error(
      `Cannot verify daemon state because ${lockPath} is unreadable. ` +
        `Refusing DB maintenance until the daemon lock is inspected or removed.`,
    );
  }
}

function fileIdentity(filePath: string): string {
  const stats = statSync(filePath);
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function assertNoActiveDaemon(dataDir: string, operation: string): void {
  const lock = readDaemonLock(dataDir);
  if (!lock) return;

  if (!Number.isInteger(lock.pid) || lock.pid <= 0) {
    throw new Error(
      `${operation} refused: invalid daemon lock in ${join(dataDir, ".awos-daemon.lock")}. ` +
        `Inspect the lock before running DB maintenance.`,
    );
  }

  if (!isPidAlive(lock.pid)) return;

  throw new Error(
    `${operation} refused: agentos-d appears to be active for ${dataDir} (pid ${lock.pid}). ` +
      `Stop the daemon before restore, migration, seed, or snapshot maintenance so the live DB file cannot be replaced while SQLite still has the old inode open.`,
  );
}

export function assertDbPathMatchesDaemonLock(dbPath: string, operation: string): void {
  const dataDir = resolve(dirname(dbPath));
  const lock = readDaemonLock(dataDir);
  if (!lock || !Number.isInteger(lock.pid) || !isPidAlive(lock.pid)) return;

  if (lock.dbPath && resolve(lock.dbPath) !== resolve(dbPath)) return;
  if (!lock.openDbIdentity || lock.openDbIdentity === "canonical") return;

  const currentIdentity = fileIdentity(dbPath);
  if (currentIdentity === lock.openDbIdentity) return;

  throw new Error(
    `${operation} refused: DB path identity no longer matches the active daemon lock. ` +
      `The daemon may be serving an older open SQLite inode while ${dbPath} points at a replacement file. ` +
      `Stop the daemon and run recovery before snapshot, restore, migration, seed, or installer operations.`,
  );
}

export class MaintenanceLock {
  private lockPath: string;

  constructor(private dataDir: string) {
    this.lockPath = join(dataDir, ".awos-maintenance.lock");
  }

  /**
   * Acquire the maintenance lock.
   * Throws if lock already exists (maintenance already engaged).
   */
  acquire(): void {
    if (existsSync(this.lockPath)) {
      throw new Error(
        `Maintenance mode is already engaged. ` +
        `Stop the daemon or use the admin API to exit maintenance mode first.`
      );
    }
    // Create an empty lock file to signal active maintenance
    writeFileSync(this.lockPath, `${Date.now()}`);
  }

  /**
   * Release the maintenance lock.
   * Safe to call even if lock does not exist.
   */
  release(): void {
    try {
      unlinkSync(this.lockPath);
    } catch {
      // Ignore errors (e.g., lock file absent)
    }
  }
}
