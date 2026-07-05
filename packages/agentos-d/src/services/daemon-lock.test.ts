import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock, type DaemonLockInfo } from "./daemon-lock.js";

describe("daemon-lock", () => {
  let dataDir: string;
  let lockPath: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "awo-lock-"));
    lockPath = join(dataDir, ".awos-daemon.lock");
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function writeStaleLock(info: Partial<DaemonLockInfo>): void {
    const full: DaemonLockInfo = {
      pid: 4242,
      startTime: "2026-07-05T00:00:00.000Z",
      dbPath: join(dataDir, "agentworks.db"),
      openDbIdentity: "missing",
      ...info,
    };
    writeFileSync(lockPath, JSON.stringify(full), "utf-8");
  }

  it("acquires when no lock file exists", async () => {
    const info = await acquireLock(dataDir);
    expect(info.pid).toBe(process.pid);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("acquires over a corrupt lock file", async () => {
    writeFileSync(lockPath, "{ not json", "utf-8");
    const info = await acquireLock(dataDir);
    expect(info.pid).toBe(process.pid);
  });

  it("reclaims a lock whose PID is dead", async () => {
    writeStaleLock({ pid: 4242, command: "/repo/dist/cli.js" });
    const info = await acquireLock(dataDir, {
      isPidAlive: () => false,
      readProcessCommand: () => "/repo/dist/cli.js",
    });
    expect(info.pid).toBe(process.pid);
  });

  it("refuses when the PID is alive AND running this daemon's entry", async () => {
    writeStaleLock({ pid: 4242, command: "/repo/packages/agentos-d/dist/cli.js" });
    await expect(
      acquireLock(dataDir, {
        isPidAlive: () => true,
        readProcessCommand: () => "node /repo/packages/agentos-d/dist/cli.js --port 7710",
      }),
    ).rejects.toThrow(/Another instance is already running \(PID 4242\)/);
  });

  it("reclaims when the PID is alive but recycled by an unrelated process (the outage bug)", async () => {
    // The daemon that wrote the lock died uncleanly; macOS reassigned its PID
    // to keyboardservicesd, which the naive process.kill(pid,0) misread as
    // "daemon still running" and wedged startup.
    writeStaleLock({ pid: 1099, command: "/repo/packages/agentos-d/dist/cli.js" });
    const info = await acquireLock(dataDir, {
      isPidAlive: () => true,
      readProcessCommand: () => "/usr/libexec/keyboardservicesd",
    });
    expect(info.pid).toBe(process.pid);
    const written = JSON.parse(readFileSync(lockPath, "utf-8")) as DaemonLockInfo;
    expect(written.pid).toBe(process.pid);
  });

  it("stays conservative and refuses when the command cannot be read", async () => {
    // ps failed / process vanished mid-check: cannot prove it is foreign, so
    // prefer a spurious refusal over risking two daemons on one DB.
    writeStaleLock({ pid: 4242 });
    await expect(
      acquireLock(dataDir, {
        isPidAlive: () => true,
        readProcessCommand: () => null,
      }),
    ).rejects.toThrow(/Another instance is already running/);
  });

  it("matches on the stored entry basename when ps truncates the path", async () => {
    writeStaleLock({ pid: 4242, command: "/repo/packages/agentos-d/dist/cli.js" });
    await expect(
      acquireLock(dataDir, {
        isPidAlive: () => true,
        readProcessCommand: () => "node ...truncated.../cli.js",
      }),
    ).rejects.toThrow(/Another instance is already running/);
  });

  it("releaseLock removes the lock file", async () => {
    await acquireLock(dataDir);
    expect(existsSync(lockPath)).toBe(true);
    await releaseLock(dataDir);
    expect(existsSync(lockPath)).toBe(false);
  });
});
