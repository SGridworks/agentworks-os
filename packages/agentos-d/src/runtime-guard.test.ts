import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeRuntimeDataDir } from "./runtime-guard.js";

describe("assertSafeRuntimeDataDir", () => {
  it("requires explicit AGENTOS_DATA_DIR for daemon startup", () => {
    const root = mkdtempSync(join(tmpdir(), "awos-guard-"));
    try {
      expect(() =>
        assertSafeRuntimeDataDir(join(root, "data"), {
          env: {},
          packageRoot: join(root, "pkg"),
        }),
      ).toThrow(/without AGENTOS_DATA_DIR/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses package-local data dir", () => {
    const root = mkdtempSync(join(tmpdir(), "awos-guard-"));
    const packageRoot = join(root, "packages", "agentos-d");
    const dataDir = join(packageRoot, "data");
    mkdirSync(packageRoot, { recursive: true });
    try {
      expect(() =>
        assertSafeRuntimeDataDir(dataDir, {
          env: { AGENTOS_DATA_DIR: dataDir },
          packageRoot,
        }),
      ).toThrow(/repo-local DB path/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts an explicit external data dir when its parent exists", () => {
    const root = mkdtempSync(join(tmpdir(), "awos-guard-"));
    const packageRoot = join(root, "packages", "agentos-d");
    const externalParent = join(root, "Application Support", "agentworks-os");
    const dataDir = join(externalParent, "data");
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(externalParent, { recursive: true });
    try {
      expect(
        assertSafeRuntimeDataDir(dataDir, {
          env: { AGENTOS_DATA_DIR: dataDir },
          packageRoot,
        }),
      ).toBe(dataDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
