import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

export interface DaemonLockInfo {
  pid: number;
  startTime: string;
  dbPath: string;
  openDbIdentity: string;
}

export async function acquireLock(dataDir: string): Promise<DaemonLockInfo> {
  const lockPath = join(dataDir, ".awos-daemon.lock");
  try {
    const raw = await fs.readFile(lockPath, "utf-8");
    const existing: DaemonLockInfo = JSON.parse(raw);
    try {
      process.kill(existing.pid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        await fs.unlink(lockPath).catch(() => {});
        return writeLock(lockPath, dataDir);
      }
      throw error;
    }
    throw new Error(`Another instance is already running (PID ${existing.pid}).`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) {
      // Missing or corrupt lock files do not prove another daemon is alive.
    } else {
      throw error;
    }
  }

  return writeLock(lockPath, dataDir);
}

async function writeLock(lockPath: string, dataDir: string): Promise<DaemonLockInfo> {
  const currentPid = process.pid;
  const startTime = new Date().toISOString();
  const dbPath = join(dataDir, "agentworks.db");
  const openDbIdentity = await identityForPath(dbPath);

  const lockInfo: DaemonLockInfo = { pid: currentPid, startTime, dbPath, openDbIdentity };
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
