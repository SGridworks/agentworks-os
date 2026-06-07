import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createSafeSubprocessEnv } from "../runtime-safety.js";

interface RunSafeTestOptions {
  cwd: string;
  testFile?: string | undefined;
  timeoutMs: number;
  python?: boolean | undefined;
  outputCapBytes?: number;
}

function packageHasSafeTest(cwd: string): boolean {
  try {
    const raw = readFileSync(path.join(cwd, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    return typeof parsed.scripts?.["test:safe"] === "string";
  } catch {
    return false;
  }
}

export async function runSafeTestCommand(opts: RunSafeTestOptions): Promise<string> {
  if (!existsSync(opts.cwd)) return `error: package_dir not found: ${opts.cwd}`;
  const outputCapBytes = opts.outputCapBytes ?? 12_000;
  const env = createSafeSubprocessEnv(process.env);
  const command = opts.python ? "python3" : packageHasSafeTest(opts.cwd) ? "pnpm" : "npx";
  const args = opts.python
    ? ["-m", "pytest"]
    : packageHasSafeTest(opts.cwd)
      ? ["test:safe", "--", "--reporter=basic"]
      : ["vitest", "run", "--reporter=basic"];

  if (opts.testFile) args.push(opts.testFile);

  return await new Promise((resolve) => {
    const proc = spawn(command, args, { cwd: opts.cwd, env });
    let out = "";
    let bytes = 0;
    const cap = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes < outputCapBytes) out += chunk.toString("utf8");
    };
    proc.stdout.on("data", cap);
    proc.stderr.on("data", cap);
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGKILL");
    }, opts.timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      const verdict = killed ? "TIMED_OUT" : code === 0 ? "PASS" : "FAIL";
      const tail = out.split("\n").slice(-60).join("\n");
      resolve(`run_test: ${verdict} (exit=${code ?? "killed"})\n--- tail ---\n${tail}`);
    });
  });
}
