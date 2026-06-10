/**
 * Migration 0046 — scanner_jobs ownership table.
 *
 * Records every scan/job id submitted through agentos-d, tied to the
 * tenant that submitted it.  Job-level routes enforce ownership against
 * this stored tenant rather than trusting the caller-supplied tenantId
 * query param.
 */

import type { Database } from "better-sqlite3";

const HASH = "v46-scanner-jobs";

export function migrateScannerJobs(sqlite: Database): void {
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
    CREATE TABLE IF NOT EXISTS scanner_jobs (
      id         TEXT NOT NULL PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      company_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scanner_jobs_tenant_id
      ON scanner_jobs(tenant_id);
  `);

  sqlite.prepare("INSERT OR IGNORE INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}
