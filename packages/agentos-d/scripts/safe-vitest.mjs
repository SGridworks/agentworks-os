#!/usr/bin/env node
import { mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "awos-test-"));
const env = {
  ...process.env,
  AWOS_TEST_ROOT: root,
  AGENTOS_DATA_DIR: join(root, "data"),
  VAULT_ROOT: join(root, "vault"),
  CI: "1",
};

delete env.RULE_PACKS_DIR;
delete env.AWOS_DB_PATH;
delete env.DATABASE_URL;
delete env.SQLITE_PATH;

const forwarded = process.argv.slice(2);
if (forwarded[0] === "--") forwarded.shift();

const child = spawn("pnpm", ["exec", "vitest", "run", ...forwarded], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
