import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AWOS_TEST_ROOT_PREFIX,
  configureVitestIsolation,
  createSafeSubprocessEnv,
  isAwosTestPath,
} from "./runtime-safety.js";

describe("runtime test safety", () => {
  it("creates isolated agentos and vault paths under the awos test root", () => {
    const env: NodeJS.ProcessEnv = {};
    const root = configureVitestIsolation(env);

    expect(root).toContain(AWOS_TEST_ROOT_PREFIX);
    expect(isAwosTestPath(env.AGENTOS_DATA_DIR)).toBe(true);
    expect(isAwosTestPath(env.VAULT_ROOT)).toBe(true);
  });

  it("rejects inherited live data paths before DB initialization", () => {
    const env: NodeJS.ProcessEnv = {
      AGENTOS_DATA_DIR: "/Users/example/Library/Application Support/agentworks-os/data",
    };

    expect(() => configureVitestIsolation(env)).toThrow(/non-test data paths/);
  });

  it("sanitizes child process env and injects safe test paths", () => {
    const env = createSafeSubprocessEnv({
      AGENTOS_DATA_DIR: "/live/data",
      VAULT_ROOT: "/live/vault",
      RULE_PACKS_DIR: "/live/rules",
      OLLAMA_API_KEY: "ok",
    });

    expect(env.OLLAMA_API_KEY).toBe("ok");
    expect(env.RULE_PACKS_DIR).toBeUndefined();
    expect(env.AGENTOS_DATA_DIR).toMatch(new RegExp(`^${join(tmpdir(), AWOS_TEST_ROOT_PREFIX)}`));
    expect(isAwosTestPath(env.AGENTOS_DATA_DIR)).toBe(true);
    expect(isAwosTestPath(env.VAULT_ROOT)).toBe(true);
  });
});
