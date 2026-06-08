/**
 * Migration 0041 - native workflow engine metadata.
 *
 * Adds durable workflow versions, per-step checkpoints, evidence packs, and
 * run/dispatch recovery fields for first-party AWOS orchestration.
 */

import type { Database } from "better-sqlite3";

const HASH = "v41-workflow-engine";

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
    CREATE TABLE IF NOT EXISTS native_automation_workflow_versions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES native_automation_workflows(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      definition_hash TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      change_summary TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_native_automation_workflow_versions_unique
      ON native_automation_workflow_versions(workflow_id, version);

    CREATE INDEX IF NOT EXISTS idx_native_automation_workflow_versions_workflow
      ON native_automation_workflow_versions(workflow_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS native_automation_run_steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES native_automation_runs(id) ON DELETE CASCADE,
      workflow_id TEXT NOT NULL,
      workflow_version_id TEXT,
      step_index INTEGER NOT NULL,
      step_id TEXT NOT NULL,
      step_type TEXT NOT NULL,
      step_name TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT NOT NULL DEFAULT '{}',
      output_json TEXT NOT NULL DEFAULT '{}',
      context_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_native_automation_run_steps_run_index
      ON native_automation_run_steps(run_id, step_index);

    CREATE INDEX IF NOT EXISTS idx_native_automation_run_steps_workflow
      ON native_automation_run_steps(workflow_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS native_automation_evidence_packs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES native_automation_runs(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      status TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      markdown TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_native_automation_evidence_packs_run
      ON native_automation_evidence_packs(run_id, created_at DESC);
  `);

  addColumn(sqlite, "native_automation_runs", "workflow_version_id", "TEXT");
  addColumn(sqlite, "native_automation_runs", "current_step_index", "INTEGER NOT NULL DEFAULT 0");
  addColumn(sqlite, "native_automation_runs", "terminal_reason", "TEXT");
  addColumn(sqlite, "native_automation_runs", "replay_of_run_id", "TEXT");
  addColumn(sqlite, "native_automation_runs", "replay_from_step_index", "INTEGER");
  addColumn(sqlite, "native_automation_runs", "cancelled_at", "TEXT");
  addColumn(sqlite, "native_automation_runs", "paused_at", "TEXT");
  addColumn(sqlite, "native_automation_runs", "resumed_at", "TEXT");
  addColumn(sqlite, "native_automation_runs", "waiting_for_approval_id", "TEXT");
  addColumn(sqlite, "native_automation_runs", "waiting_for_dispatch_id", "TEXT");
  addColumn(sqlite, "native_automation_runs", "dry_run", "INTEGER NOT NULL DEFAULT 0");

  addColumn(sqlite, "dispatch_queue", "retry_count", "INTEGER NOT NULL DEFAULT 0");
  addColumn(sqlite, "dispatch_queue", "max_retries", "INTEGER NOT NULL DEFAULT 0");
  addColumn(sqlite, "dispatch_queue", "lease_expires_at", "TEXT");
  addColumn(sqlite, "dispatch_queue", "contract_json", "TEXT");
  addColumn(sqlite, "dispatch_queue", "accepted_at", "TEXT");
  addColumn(sqlite, "dispatch_queue", "acceptance_error", "TEXT");

  sqlite.prepare("INSERT OR IGNORE INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}

function addColumn(sqlite: Database, table: string, column: string, definition: string): void {
  const columns = sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (columns.some((existing) => existing.name === column)) return;
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
