import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  AwosLocalProfile,
  AwosLocalProfileSchema,
  ProfileDriftCode,
} from "./local-profile.schema.js";

const DEFAULT_PROFILE_PATH = path.join(
  homedir(),
  ".agentworks",
  "awos-local.profile.json",
);
const DEFAULT_ENV_PATH = path.join(
  homedir(),
  ".agentworks",
  "awos-local.env",
);

function defaultDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(
      homedir(),
      "Library",
      "Application Support",
      "agentworks-os",
      "data",
    );
  }
  return path.join(homedir(), ".agentworks", "data");
}

const DEFAULT_REPO_ROOT = process.cwd();
const DEFAULT_DATA_DIR = defaultDataDir();
const DEFAULT_DB_PATH = path.join(DEFAULT_DATA_DIR, "agentworks.db");
const DEFAULT_VAULT_ROOT = path.join(homedir(), "vault");
const DEFAULT_TENANT_ID = "00000000-0000-4000-8000-000000000001";
const DEFAULT_TENANT_NAME = "Local";
const DEFAULT_EXPECTED_COMPANIES: ReadonlyArray<string> = [
  "AgentWorks",
];
const DEFAULT_ALWAYS_KEEP_IDS: ReadonlyArray<string> = [
  "AWOS-STANDING",
];
const DEFAULT_LAUNCHD_LABELS: ReadonlyArray<string> = [
  "com.agentworks.admin-ui-watchdog",
  "com.agentworks.wake-on-assign",
  "com.agentworks.automation-engine",
  "com.agentworks.review-router",
  "ai.agentworks.daemon",
  "ai.agentworks.bridge",
];
const DEFAULT_BACKUP_DIR = path.join(homedir(), "backups", "awos-local");
const DEFAULT_ALLOWED_FALLBACK_MODEL = "kimi-k2.6";
const DEFAULT_ADMIN_PORT = 3000;
const DEFAULT_API_PORT = 7710;

let cached: AwosLocalProfile | null = null;

/**
 * Parse a shell-style env file (KEY=VALUE per line, with optional quotes).
 * Comments (#) and blank lines are skipped. Used as a fallback when no JSON
 * profile is present. We do NOT write or mutate this file.
 */
function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readEnvFileSafe(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) return {};
  try {
    return parseEnvFile(readFileSync(envPath, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Build a profile derived from the existing awos-local.env (last-resort
 * fallback when no JSON profile exists). The env file is the source of
 * truth for ports/data-dir today; this bridge stays read-only.
 */
function buildBridgedProfile(envPath: string): unknown {
  const env = readEnvFileSafe(envPath);

  const repoRoot = env.AWOS_REPO_ROOT ?? DEFAULT_REPO_ROOT;
  const dataDir = env.AGENTOS_DATA_DIR ?? DEFAULT_DATA_DIR;
  const vaultRoot = env.VAULT_ROOT ?? DEFAULT_VAULT_ROOT;
  const apiPortStr = env.AGENTOS_PORT;
  const adminPortStr = env.AWOS_ADMIN_UI_PORT;
  const allowedFallbackModel =
    env.AWOS_BRIDGE_REQUIRED_FALLBACK_MODEL ??
    env.FALLBACK_MODEL ??
    DEFAULT_ALLOWED_FALLBACK_MODEL;

  return {
    version: 1,
    repoRoot,
    dataDir,
    dbPath: path.join(dataDir, "agentworks.db"),
    vaultRoot,
    tenantId: env.AGENTOS_TENANT_ID ?? DEFAULT_TENANT_ID,
    tenantName: DEFAULT_TENANT_NAME,
    expectedCompanies: [...DEFAULT_EXPECTED_COMPANIES],
    alwaysKeepIssueIds: [...DEFAULT_ALWAYS_KEEP_IDS],
    ports: {
      admin: adminPortStr ? Number(adminPortStr) : DEFAULT_ADMIN_PORT,
      api: apiPortStr ? Number(apiPortStr) : DEFAULT_API_PORT,
    },
    launchdLabels: [...DEFAULT_LAUNCHD_LABELS],
    backupDir: DEFAULT_BACKUP_DIR,
    allowedFallbackModel,
  };
}

async function readJsonProfile(filePath: string): Promise<unknown> {
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text);
}

export interface LoadProfileOptions {
  envOverrides?: Record<string, string | undefined>;
  envFilePath?: string;
  profilePathOverride?: string;
}

/**
 * Resolve the profile JSON path with the documented precedence:
 *   1. AGENTWORKS_LOCAL_PROFILE env var (explicit file path)
 *   2. ~/.agentworks/awos-local.profile.json (default)
 * If neither file exists, returns null and the caller derives from env.
 */
export function resolveProfilePath(opts: LoadProfileOptions = {}): string | null {
  const env = opts.envOverrides ?? process.env;
  const fromEnv = env.AGENTWORKS_LOCAL_PROFILE;
  if (opts.profilePathOverride && existsSync(opts.profilePathOverride)) {
    return opts.profilePathOverride;
  }
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (existsSync(DEFAULT_PROFILE_PATH)) return DEFAULT_PROFILE_PATH;
  return null;
}

/**
 * Load and validate the AWOS local profile. Precedence:
 *   AGENTWORKS_LOCAL_PROFILE env → ~/.agentworks/awos-local.profile.json
 *   → bridged-from-env defaults (reads ~/.agentworks/awos-local.env).
 *
 * Throws ZodError on schema violation; the caller decides how to surface it.
 */
export async function loadProfile(
  opts: LoadProfileOptions = {},
): Promise<AwosLocalProfile> {
  const profilePath = resolveProfilePath(opts);
  const raw =
    profilePath !== null
      ? await readJsonProfile(profilePath)
      : buildBridgedProfile(opts.envFilePath ?? DEFAULT_ENV_PATH);
  return AwosLocalProfileSchema.parse(raw);
}

/**
 * Cached singleton accessor. Profile changes require a daemon restart by
 * design — runtime hot-reload is out of scope for the reliability sprint.
 */
export async function getProfile(
  opts: LoadProfileOptions = {},
): Promise<AwosLocalProfile> {
  if (cached !== null) return cached;
  cached = await loadProfile(opts);
  return cached;
}

/**
 * Test-only escape hatch. Production code must not call this.
 */
export function resetProfileCache(): void {
  cached = null;
}

export interface RuntimeContext {
  readonly dbPath?: string;
  readonly dataDir?: string;
  readonly repoRoot?: string;
}

export interface DriftReport {
  readonly drift: ReadonlyArray<ProfileDriftCode>;
}

/**
 * Compare a loaded profile against observed runtime values. Returns stable
 * codes so trust/doctor can render warnings without re-deriving the logic.
 * vaultRoot is checked for existence here (rather than equality) because the
 * profile is authoritative on where the vault should be.
 */
export function validateAgainstRuntime(
  profile: AwosLocalProfile,
  runtime: RuntimeContext,
): DriftReport {
  const drift: ProfileDriftCode[] = [];
  if (runtime.dbPath !== undefined && runtime.dbPath !== profile.dbPath) {
    drift.push("dbPath-mismatch");
  }
  if (runtime.dataDir !== undefined && runtime.dataDir !== profile.dataDir) {
    drift.push("dataDir-mismatch");
  }
  if (runtime.repoRoot !== undefined && runtime.repoRoot !== profile.repoRoot) {
    drift.push("repoRoot-mismatch");
  }
  if (!existsSync(profile.vaultRoot)) {
    drift.push("vaultRoot-missing");
  }
  return { drift };
}

export { DEFAULT_PROFILE_PATH, DEFAULT_ENV_PATH };
