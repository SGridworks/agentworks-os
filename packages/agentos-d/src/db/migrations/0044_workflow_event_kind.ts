/**
 * Migration 0044 — workflow event_kind column + routing index.
 *
 * Adds a nullable `event_kind TEXT` column to `native_automation_workflows`
 * so event-triggered workflows can declare the specific event they subscribe
 * to (e.g. "scanner.finding"). Manual and webhook workflows leave it null.
 *
 * Also adds a composite index on (trigger_kind, event_kind, status) that
 * lets the event dispatcher query "all active event workflows for kind X"
 * as a single indexed range scan.
 */

import type { Database } from "better-sqlite3";

const HASH = "v44-workflow-event-kind";

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
    ALTER TABLE native_automation_workflows
      ADD COLUMN event_kind TEXT;

    CREATE INDEX IF NOT EXISTS idx_naw_trigger_event_status
      ON native_automation_workflows(trigger_kind, event_kind, status);
  `);

  sqlite.prepare("INSERT OR IGNORE INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}
