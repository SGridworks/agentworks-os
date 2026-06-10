/**
 * Migration 0045 — workflow_event_emissions dedup table.
 *
 * Records every (event_kind, subject_id) pair that has been emitted to the
 * workflow event bus by a level-triggered sweep. The UNIQUE index on
 * (event_kind, subject_id) ensures each subject fires at most once per
 * event kind across restarts — INSERT OR IGNORE is the atomic claim gate.
 */

import type { Database } from "better-sqlite3";

const HASH = "v45-workflow-event-emissions";

export function migrateWorkflowEventEmissions(sqlite: Database): void {
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
    CREATE TABLE IF NOT EXISTS workflow_event_emissions (
      id          TEXT NOT NULL PRIMARY KEY,
      event_kind  TEXT NOT NULL,
      subject_id  TEXT NOT NULL,
      tenant_id   TEXT NOT NULL,
      emitted_at  TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_wee_kind_subject
      ON workflow_event_emissions(event_kind, subject_id);
  `);

  sqlite.prepare("INSERT OR IGNORE INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}
