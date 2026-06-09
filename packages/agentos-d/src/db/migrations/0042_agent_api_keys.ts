/**
 * Migration 0042 - agent API keys for scoped per-agent credentials.
 *
 * Adds the agent_api_keys table used by the principal resolver to authenticate
 * individual agents with scoped permissions rather than the owner token.
 * Token plaintext is shown once at creation; only the sha256 hash is stored.
 */

import type { Database } from "better-sqlite3";

const HASH = "v42-agent-api-keys";

export function migrate(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  const existing = sqlite.prepare("SELECT 1 FROM __drizzle_migrations WHERE hash = ?").get(HASH);
  if (existing) return;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_api_keys (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES execution_agents(id) ON DELETE CASCADE,
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      scopes TEXT NOT NULL,
      tenant_allowlist TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_api_keys_hash
      ON agent_api_keys(key_hash);

    CREATE INDEX IF NOT EXISTS idx_agent_api_keys_agent
      ON agent_api_keys(agent_id);
  `);

  sqlite.prepare("INSERT OR IGNORE INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}
