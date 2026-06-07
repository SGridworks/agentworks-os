import type { Database } from "better-sqlite3";

export function migrate(sqlite: Database): void {
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_agents_tenant_name ON execution_agents (tenant_id, name);");
}

export function undo(sqlite: Database): void {
  sqlite.exec("DROP INDEX IF EXISTS idx_execution_agents_tenant_name");
}