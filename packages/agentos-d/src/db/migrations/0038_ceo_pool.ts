/**
 * Migration 0038 — CEO pool scaling: adds CEO-2 and CEO-3 agents.
 *
 * Creates two additional CEO agents with fixed UUIDs derived from seed
 * to ensure stability across restarts. The CEOs share approval authority
 * and are load-balanced based on current in-flight review count.
 *
 * Forward-only, idempotent via __drizzle_migrations.
 */

import type { Database } from "better-sqlite3";

const HASH = "v38-ceo-pool";

// Fixed UUIDs for CEO-2 and CEO-3 (derived from seed for stability)
const CEO_2_ID = "8f4c9a31-8b7a-4e5f-8c3d-1a2b3c4d5e6f";
const CEO_3_ID = "9d5e8b42-9c8b-5f6e-9d4e-2b3c4d5e6f7a";

export function migrate(sqlite: Database): void {
  const existing = sqlite
    .prepare("SELECT 1 FROM __drizzle_migrations WHERE hash = ?")
    .get(HASH);
  if (existing) return;

  // Get the tenant ID from the existing CEO agent (assuming single tenant for now)
  const ceoRow = sqlite
    .prepare("SELECT tenant_id FROM execution_agents WHERE role = 'ceo' LIMIT 1")
    .get() as { tenant_id: string } | undefined;

  if (!ceoRow) {
    // If no CEO exists yet, we can't create the pool - this migration depends on existing CEO
    throw new Error("Cannot create CEO pool: no existing CEO agent found");
  }

  const tenantId = ceoRow.tenant_id;

  // Create CEO-2 if it doesn't exist
  const existingCeo2 = sqlite
    .prepare("SELECT 1 FROM execution_agents WHERE id = ?")
    .get(CEO_2_ID);

  if (!existingCeo2) {
    sqlite.prepare(
      `INSERT INTO execution_agents (
        id, tenant_id, name, role, status, config_json, adapter_type, model,
        capabilities, heartbeat_interval_sec, source, source_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      CEO_2_ID,
      tenantId,
      "CEO-2",
      "ceo",
      "active",
      JSON.stringify({
        instructionsPath: "agents/ceo/AGENTS.md",
        maxTurns: 50,
        lane: "CEO",
      }),
      "kimi",
      "glm-5.1",
      JSON.stringify(["review", "spec", "gate"]),
      60,
      "awos",
      "ceo-2",
      new Date().toISOString(),
      new Date().toISOString()
    );
  }

  // Create CEO-3 if it doesn't exist
  const existingCeo3 = sqlite
    .prepare("SELECT 1 FROM execution_agents WHERE id = ?")
    .get(CEO_3_ID);

  if (!existingCeo3) {
    sqlite.prepare(
      `INSERT INTO execution_agents (
        id, tenant_id, name, role, status, config_json, adapter_type, model,
        capabilities, heartbeat_interval_sec, source, source_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      CEO_3_ID,
      tenantId,
      "CEO-3",
      "ceo",
      "active",
      JSON.stringify({
        instructionsPath: "agents/ceo/AGENTS.md",
        maxTurns: 50,
        lane: "CEO",
      }),
      "kimi",
      "glm-5.1",
      JSON.stringify(["review", "spec", "gate"]),
      60,
      "awos",
      "ceo-3",
      new Date().toISOString(),
      new Date().toISOString()
    );
  }

  sqlite.prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}