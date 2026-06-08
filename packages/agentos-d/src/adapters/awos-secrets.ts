import { existsSync, readFileSync } from "node:fs";
import yaml from "js-yaml";

const DEFAULT_AWOS_SECRETS_PATH = `${process.env.HOME}/.agentworks/secrets.env`;
const DEFAULT_AWOS_PROVIDER_PROFILE_PATH = `${process.env.HOME}/.agentworks/provider-profile.yaml`;

interface ProviderKeyOptions {
  envNames: string[];
  awosSecretsPath?: string;
  providerProfilePath?: string;
  providerProfileName?: string;
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match?.[1]) continue;
    out[match[1]] = (match[2] ?? "").replace(/^['"]|['"]$/g, "");
  }
  return out;
}

function readProfileProviderKey(configPath: string, provider: string): string | null {
  if (!existsSync(configPath)) return null;
  try {
    const cfg = yaml.load(readFileSync(configPath, "utf8")) as {
      providers?: Record<string, { api_key?: unknown }>;
    };
    const key = cfg?.providers?.[provider]?.api_key;
    return typeof key === "string" && key.length > 10 ? key : null;
  } catch {
    return null;
  }
}

function defaultProviderProfilePath(): string {
  return process.env.AWOS_PROVIDER_PROFILE_PATH ?? DEFAULT_AWOS_PROVIDER_PROFILE_PATH;
}

export function readAwosModelProfile(configPath = defaultProviderProfilePath()): {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  apiKey: string | null;
} {
  if (!existsSync(configPath)) return { provider: null, model: null, baseUrl: null, apiKey: null };
  try {
    const cfg = yaml.load(readFileSync(configPath, "utf8")) as {
      model?: { provider?: unknown; default?: unknown };
      providers?: Record<string, { api?: unknown; api_key?: unknown }>;
    };
    const provider = typeof cfg?.model?.provider === "string" ? cfg.model.provider : null;
    const model = typeof cfg?.model?.default === "string" ? cfg.model.default : null;
    const providerCfg = provider ? cfg?.providers?.[provider] : undefined;
    const baseUrl = typeof providerCfg?.api === "string" ? providerCfg.api : null;
    const apiKey = typeof providerCfg?.api_key === "string" && providerCfg.api_key.length > 10 ? providerCfg.api_key : null;
    return { provider, model, baseUrl, apiKey };
  } catch {
    return { provider: null, model: null, baseUrl: null, apiKey: null };
  }
}

export function readAwosProviderProfile(
  provider: string,
  configPath = defaultProviderProfilePath(),
): { provider: string; baseUrl: string | null; apiKey: string | null } {
  if (!existsSync(configPath)) return { provider, baseUrl: null, apiKey: null };
  try {
    const cfg = yaml.load(readFileSync(configPath, "utf8")) as {
      providers?: Record<string, { api?: unknown; api_key?: unknown }>;
    };
    const providerCfg = cfg?.providers?.[provider];
    return {
      provider,
      baseUrl: typeof providerCfg?.api === "string" ? providerCfg.api : null,
      apiKey: typeof providerCfg?.api_key === "string" && providerCfg.api_key.length > 10 ? providerCfg.api_key : null,
    };
  } catch {
    return { provider, baseUrl: null, apiKey: null };
  }
}

export function loadAwosProviderKey(opts: ProviderKeyOptions): string {
  for (const name of opts.envNames) {
    const value = process.env[name];
    if (value && value.length > 0) return value;
  }

  const awosSecretsPath = opts.awosSecretsPath ?? process.env.AWOS_SECRETS_PATH ?? DEFAULT_AWOS_SECRETS_PATH;
  const awosSecrets = parseEnvFile(awosSecretsPath);
  for (const name of opts.envNames) {
    const value = awosSecrets[name];
    if (value && value.length > 0) return value;
  }

  if (process.env.AWOS_ALLOW_PROVIDER_PROFILE_FALLBACK === "1") {
    if (opts.providerProfilePath && opts.providerProfileName) {
      const value = readProfileProviderKey(opts.providerProfilePath, opts.providerProfileName);
      if (value) return value;
    }
  }

  throw new Error(
    `${opts.envNames.join("/")} missing. Set it in the daemon environment or ${awosSecretsPath}. ` +
      "Provider profile fallback is disabled unless AWOS_ALLOW_PROVIDER_PROFILE_FALLBACK=1.",
  );
}
