import { existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

export interface RuntimeDataDirGuardOptions {
  env?: Record<string, string | undefined>;
  packageRoot?: string;
}

export function assertSafeRuntimeDataDir(
  dataDir: string,
  opts: RuntimeDataDirGuardOptions = {},
): string {
  const env = opts.env ?? process.env;
  const explicit = env.AGENTOS_DATA_DIR;
  if (!explicit) {
    throw new Error(
      "Refusing to start agentos-d without AGENTOS_DATA_DIR. Set it to " +
        "~/Library/Application Support/agentworks-os/data.",
    );
  }

  const resolvedDataDir = resolve(dataDir);
  const packageRoot = resolve(opts.packageRoot ?? resolve(import.meta.dirname, ".."));
  const repoLocalData = resolve(packageRoot, "data");

  if (resolvedDataDir === repoLocalData || resolvedDataDir.startsWith(`${repoLocalData}${sep}`)) {
    throw new Error(
      `Refusing to start agentos-d against repo-local DB path: ${resolvedDataDir}. ` +
        "Use ~/Library/Application Support/agentworks-os/data instead.",
    );
  }

  if (!existsSync(dirname(resolvedDataDir))) {
    throw new Error(`AGENTOS_DATA_DIR parent does not exist: ${dirname(resolvedDataDir)}`);
  }

  return resolvedDataDir;
}
