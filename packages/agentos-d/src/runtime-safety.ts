import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

export const AWOS_TEST_ROOT_PREFIX = "awos-test-";

const FORBIDDEN_CHILD_ENV = new Set([
  "AGENTOS_DATA_DIR",
  "VAULT_ROOT",
  "RULE_PACKS_DIR",
  "AWOS_DB_PATH",
  "DATABASE_URL",
  "SQLITE_PATH",
  "AWOS_PROVIDER_PROFILE_PATH",
]);

export function isAwosTestPath(value: string | undefined): boolean {
  if (!value) return false;
  const resolved = resolve(value);
  const tmpPrefix = `${resolve(tmpdir())}${sep}${AWOS_TEST_ROOT_PREFIX}`;
  return resolved.startsWith(tmpPrefix);
}

function existingNonTestPaths(env: NodeJS.ProcessEnv): string[] {
  const bad: string[] = [];
  for (const name of ["AGENTOS_DATA_DIR", "VAULT_ROOT"] as const) {
    const value = env[name];
    if (value && !isAwosTestPath(value)) {
      bad.push(`${name}=${value}`);
    }
  }
  return bad;
}

export function configureVitestIsolation(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AWOS_TEST_ROOT && isAwosTestPath(env.AWOS_TEST_ROOT)) {
    env.AGENTOS_DATA_DIR = join(env.AWOS_TEST_ROOT, "data");
    env.VAULT_ROOT = join(env.AWOS_TEST_ROOT, "vault");
    return env.AWOS_TEST_ROOT;
  }

  const bad = existingNonTestPaths(env);
  if (bad.length > 0) {
    throw new Error(
      `Refusing to run agentos-d tests with non-test data paths: ${bad.join(", ")}. ` +
        `Use pnpm --filter @agentworks/agentos-d test:safe so paths are under ${join(tmpdir(), `${AWOS_TEST_ROOT_PREFIX}*`)}.`,
    );
  }

  const root =
    env.AWOS_TEST_ROOT && isAwosTestPath(env.AWOS_TEST_ROOT)
      ? env.AWOS_TEST_ROOT
      : mkdtempSync(join(tmpdir(), AWOS_TEST_ROOT_PREFIX));

  env.AWOS_TEST_ROOT = root;
  env.AGENTOS_DATA_DIR = join(root, "data");
  env.VAULT_ROOT = join(root, "vault");
  return root;
}

export function createSafeSubprocessEnv(
  base: NodeJS.ProcessEnv = process.env,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !FORBIDDEN_CHILD_ENV.has(key)) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  const root = mkdtempSync(join(tmpdir(), AWOS_TEST_ROOT_PREFIX));
  env.AWOS_TEST_ROOT = root;
  env.AGENTOS_DATA_DIR = join(root, "data");
  env.VAULT_ROOT = join(root, "vault");
  env.CI = "1";
  return env;
}
