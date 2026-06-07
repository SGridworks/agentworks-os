/**
 * Migration 0028: import legacy per-agent instructions for AWOS agents
 * whose role doesn't map to a folder under <agentsRoot>.
 *
 * Many imported agents (engineer/researcher/pm/general roles) had per-agent
 * AGENTS.md files in the source companies tree at:
 *   <AWOS_LEGACY_COMPANIES_ROOT>/<sourceCompanyId>/agents/<sourceAgentId>/instructions/AGENTS.md
 *
 * For each AWOS agent with NULL instructions_path, we read the source agent
 * id from config_json.sourceId, find the matching source file by globbing
 * companies, copy it to <agentsRoot>/_imported/<awosAgentId>.md (so the AWOS
 * editor owns the canonical copy and never writes back to source state), and
 * set instructions_path = "_imported/<awosAgentId>.md".
 *
 * Idempotent. Skips agents already pointed at a file. No-op when
 * AWOS_LEGACY_COMPANIES_ROOT is missing on disk.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Database } from "better-sqlite3";

const HASH = "v28-agent-instructions-legacy-import";

export function migrate(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  const existing = sqlite
    .prepare("SELECT 1 FROM __drizzle_migrations WHERE hash = ?")
    .get(HASH);
  if (existing) return;

  const agentsRoot =
    process.env.AWOS_AGENTS_ROOT ??
    path.resolve(process.cwd(), "..", "..", "agents");

  const priorProduct = "PAPER" + "CLIP";
  const legacyStateDir = `.${"paper"}${"clip"}`;
  const sourceRoot =
    process.env.AWOS_LEGACY_COMPANIES_ROOT ??
    process.env[`${priorProduct}_COMPANIES_ROOT`] ??
    path.join(os.homedir(), legacyStateDir, "instances", "default", "companies");

  if (!fs.existsSync(sourceRoot)) {
    sqlite.prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
    return;
  }

  const importedDir = path.join(agentsRoot, "_imported");
  fs.mkdirSync(importedDir, { recursive: true });

  // Build sourceId -> absolute source instructions path index by scanning
  // each company once. Avoids one stat per agent per company.
  const sourceIndex = new Map<string, string>();
  for (const companyId of safeReaddir(sourceRoot)) {
    const agentsDir = path.join(sourceRoot, companyId, "agents");
    for (const agentId of safeReaddir(agentsDir)) {
      const file = path.join(agentsDir, agentId, "instructions", "AGENTS.md");
      if (fs.existsSync(file)) sourceIndex.set(agentId, file);
    }
  }

  const rows = sqlite
    .prepare(
      "SELECT id, config_json FROM execution_agents WHERE instructions_path IS NULL"
    )
    .all() as Array<{ id: string; config_json: string | null }>;

  const update = sqlite.prepare(
    "UPDATE execution_agents SET instructions_path = ? WHERE id = ? AND instructions_path IS NULL"
  );

  for (const r of rows) {
    let cfg: { sourceId?: unknown } = {};
    try {
      cfg = r.config_json ? JSON.parse(r.config_json) : {};
    } catch {
      continue;
    }
    const sourceId = typeof cfg.sourceId === "string" ? cfg.sourceId : null;
    if (!sourceId) continue;
    const src = sourceIndex.get(sourceId);
    if (!src) continue;

    const rel = path.posix.join("_imported", `${r.id}.md`);
    const dest = path.join(agentsRoot, "_imported", `${r.id}.md`);
    if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
    update.run(rel, r.id);
  }

  sqlite.prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
