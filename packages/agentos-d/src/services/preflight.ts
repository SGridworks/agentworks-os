/** Run preflight checks for required runtime capabilities */
import { execSync } from "child_process";

export interface PreflightResult {
  ok: boolean;
  missing?: string[];
}

/**
 * Checks for:
 *   - Python 3 executable
 *   - pip executable
 *   - Network connectivity (external IP)
 *   - str_replace_editor command availability
 *
 * @returns {Promise<PreflightResult>} ok flag and missing capability names
 */
export async function runPreflight(): Promise<PreflightResult> {
  const missing: string[] = [];

  // Check for python3
  try {
    execSync("python3 --version", { stdio: "ignore" });
  } catch {
    missing.push("Python 3 executable");
  }

  // Check for pip
  try {
    execSync("pip --version", { stdio: "ignore" });
  } catch {
    missing.push("pip executable");
  }

  // Check network connectivity (attempt DNS lookup of Google)
  try {
    execSync("dig +short google.com", { stdio: "ignore" });
  } catch {
    missing.push("Network connectivity");
  }

  // Check for str_replace_editor command
  try {
    execSync("which str_replace_editor", { stdio: "ignore" });
  } catch {
    missing.push("str_replace_editor command");
  }

  return {
    ok: missing.length === 0,
    missing,
  };
}
