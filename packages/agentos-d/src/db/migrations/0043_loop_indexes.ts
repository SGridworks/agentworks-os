/**
 * Migration 0043 — loop-driver lookup indexes.
 *
 * Adds composite indexes on native_automation_runs for the two foreign-key
 * lookups the loop-driver performs on every approval/dispatch resolution:
 *   - (waiting_for_approval_id, status) for onApprovalResolved
 *   - (waiting_for_dispatch_id, status) for onDispatchResolved
 *
 * Without these, each lookup is a full table scan. With them, both queries
 * become indexed range scans on the (usually small) set of waiting rows.
 */

import type { Database } from "better-sqlite3";

const HASH = "v43-loop-indexes";

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
    CREATE INDEX IF NOT EXISTS idx_nar_waiting_approval_id_status
      ON native_automation_runs(waiting_for_approval_id, status);

    CREATE INDEX IF NOT EXISTS idx_nar_waiting_dispatch_id_status
      ON native_automation_runs(waiting_for_dispatch_id, status);
  `);

  sqlite.prepare("INSERT OR IGNORE INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}
