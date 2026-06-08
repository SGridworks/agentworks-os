import path from "node:path";
import { z } from "zod";
import { pino, Logger } from "pino";

const EnvBooleanSchema = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

const ConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().positive().default(7710),
  logLevel: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  awcpVersion: z.string().default("awcp/v0.1"),
  dataDir: z.string().default("./data"),
  scannerSidecarUrl: z.string().default("http://127.0.0.1:3101"),
  scannerPollIntervalMs: z.coerce.number().int().positive().default(30_000),
  /**
   * Audit log retention in days. action_log rows older than this are deleted
   * by the daily retention sweep. Default 30. Set to 0 to disable retention
   * (rows kept forever).
   *
   * policy_decisions are NOT subject to retention — they are hash-chained for
   * tamper-evidence and the chain must not be broken. Compliance evidence
   * reports aggregate over policy_decisions counts, not action_log payloads.
   */
  auditLogRetentionDays: z.coerce.number().int().min(0).default(30),
  companyId: z.string().default(""),
  standingIssueId: z.string().default("standing"),
  legacyBridgeUrl: z.string().url().default("http://127.0.0.1:3100"),
  legacyBridgeApiKey: z.string().default("local-trusted"),
  legacyBridgeEnabled: EnvBooleanSchema.default(false),
  executionDatabaseUrl: z.string().url().optional(),
  agentsRoot: z.string().default(""),
});

export type Config = z.infer<typeof ConfigSchema> & {
  logger: Logger;
};

function deprecatedLegacyBridgeAlias(
  env: Record<string, string | undefined>,
  suffix: "URL" | "API_KEY" | "ENABLED",
): { value: string | undefined; used: boolean } {
  const priorProduct = "PAPER" + "CLIP";
  const names =
    suffix === "URL"
      ? [`${priorProduct}_API_URL`, `AGENTOS_${priorProduct}_COMPAT_URL`]
      : suffix === "API_KEY"
        ? [`${priorProduct}_API_KEY`, `AGENTOS_${priorProduct}_COMPAT_API_KEY`]
        : [`AGENTOS_${priorProduct}_COMPAT_ENABLED`];
  for (const name of names) {
    if (env[name] !== undefined) return { value: env[name], used: true };
  }
  return { value: undefined, used: false };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const legacyBridgeUrlAlias = deprecatedLegacyBridgeAlias(env, "URL");
  const legacyBridgeApiKeyAlias = deprecatedLegacyBridgeAlias(env, "API_KEY");
  const legacyBridgeEnabledAlias = deprecatedLegacyBridgeAlias(env, "ENABLED");
  const raw = ConfigSchema.parse({
    host: env.AGENTOS_HOST,
    port: env.AGENTOS_PORT,
    logLevel: env.AGENTOS_LOG_LEVEL,
    awcpVersion: env.AGENTOS_AWCP_VERSION,
    dataDir: env.AGENTOS_DATA_DIR ?? "./data",
    auditLogRetentionDays: env.AGENTOS_AUDIT_LOG_RETENTION_DAYS,
    legacyBridgeUrl: env.AWOS_LEGACY_BRIDGE_URL ?? legacyBridgeUrlAlias.value,
    legacyBridgeApiKey: env.AWOS_LEGACY_BRIDGE_API_KEY ?? legacyBridgeApiKeyAlias.value,
    legacyBridgeEnabled: env.AWOS_LEGACY_BRIDGE_ENABLED ?? legacyBridgeEnabledAlias.value,
    executionDatabaseUrl: env.AGENTOS_EXECUTION_DATABASE_URL,
    agentsRoot: env.AWOS_AGENTS_ROOT ?? path.resolve(process.cwd(), "..", "..", "agents"),
  });

  const logger = pino({ level: raw.logLevel });
  if (legacyBridgeUrlAlias.used || legacyBridgeApiKeyAlias.used || legacyBridgeEnabledAlias.used) {
    logger.warn(
      { code: "deprecated_legacy_bridge_env_alias" },
      "Deprecated legacy bridge env alias used; switch to AWOS_LEGACY_BRIDGE_*.",
    );
  }

  return {
    ...raw,
    logger,
    companyId: env.AGENTOS_COMPANY_ID ?? raw.companyId,
    standingIssueId: env.AGENTOS_STANDING_ISSUE_ID ?? raw.standingIssueId,
  };
}
