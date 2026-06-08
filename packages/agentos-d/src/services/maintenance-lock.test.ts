import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertDbPathMatchesDaemonLock,
  assertNoActiveDaemon,
} from "./maintenance-lock.js";

const dirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "awos-maintenance-lock-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("assertNoActiveDaemon", () => {
  it("allows maintenance when no daemon lock exists", () => {
    expect(() => assertNoActiveDaemon(tempDataDir(), "db:migrate")).not.toThrow();
  });

  it("refuses maintenance when the daemon lock points at a live pid", () => {
    const dataDir = tempDataDir();
    writeFileSync(
      join(dataDir, ".awos-daemon.lock"),
      JSON.stringify({
        pid: process.pid,
        startTime: new Date().toISOString(),
        dbPath: join(dataDir, "agentworks.db"),
        openDbIdentity: "test",
      }),
    );

    expect(() => assertNoActiveDaemon(dataDir, "db:migrate")).toThrow(
      /db:migrate refused: agentos-d appears to be active/,
    );
  });
});

describe("assertDbPathMatchesDaemonLock", () => {
  it("refuses when the live DB path identity differs from the active daemon lock", () => {
    const dataDir = tempDataDir();
    const dbPath = join(dataDir, "agentworks.db");
    writeFileSync(dbPath, "original");
    const stats = statSync(dbPath);

    writeFileSync(
      join(dataDir, ".awos-daemon.lock"),
      JSON.stringify({
        pid: process.pid,
        startTime: new Date().toISOString(),
        dbPath,
        openDbIdentity: `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`,
      }),
    );

    rmSync(dbPath, { force: true });
    writeFileSync(dbPath, "replacement");

    expect(() => assertDbPathMatchesDaemonLock(dbPath, "snapshot")).toThrow(
      /snapshot refused: DB path identity no longer matches/,
    );
  });
});
