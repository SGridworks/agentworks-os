import { homedir } from "node:os";
import { join } from "node:path";

function defaultDataDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "agentworks-os", "data");
  }
  return join(homedir(), ".agentworks", "data");
}

const dataDir = process.env.AGENTOS_DATA_DIR ?? defaultDataDir();

export { dataDir };
