import { Router } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Config } from "../../config.js";
import { getSqlite } from "../../db/index.js";
import { requireLocalAdmin } from "../admin.js";
import { ALL_SCOPES, type Scope } from "../../auth/principal.js";

const ScopeSchema = z.enum([
  "memory:read",
  "memory:write",
  "policy:check",
  "dispatch:write",
  "approvals:decide",
  "operator-memory:read",
  "admin",
] satisfies [Scope, ...Scope[]]);

const MintKeySchema = z.object({
  scopes: z.array(ScopeSchema).default([]),
  tenantAllowlist: z.union([z.literal("*"), z.array(z.string().min(1))]).default([]),
});

type AgentKeyRow = {
  id: string;
  agent_id: string;
  key_prefix: string;
  scopes: string;
  tenant_allowlist: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

function sha256hex(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mintToken(): string {
  return `agtk_${randomBytes(24).toString("base64url")}`;
}

function parseJsonArray(text: string): unknown[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function serializeKey(row: AgentKeyRow): Record<string, unknown> {
  return {
    id: row.id,
    agentId: row.agent_id,
    keyPrefix: row.key_prefix,
    scopes: parseJsonArray(row.scopes),
    tenantAllowlist: row.tenant_allowlist === "*" ? "*" : parseJsonArray(row.tenant_allowlist),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

export function createAgentKeysRouter(config: Config): Router {
  const router = Router();

  router.post("/agents/:id/keys", (req, res) => {
    if (!requireLocalAdmin(req, res, config)) return;
    const parsed = MintKeySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }

    const sqlite = getSqlite();
    const agent = sqlite
      .prepare("SELECT id FROM execution_agents WHERE id = ?")
      .get(req.params.id) as { id: string } | undefined;
    if (!agent) {
      res.status(404).json({ error: "agent_not_found" });
      return;
    }

    const token = mintToken();
    const now = new Date().toISOString();
    const keyId = randomUUID();
    const scopes = parsed.data.scopes.filter((scope) => ALL_SCOPES.has(scope));
    const tenantAllowlist =
      parsed.data.tenantAllowlist === "*"
        ? "*"
        : JSON.stringify([...new Set(parsed.data.tenantAllowlist)]);

    sqlite
      .prepare(
        `INSERT INTO agent_api_keys
         (id, agent_id, key_hash, key_prefix, scopes, tenant_allowlist, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(keyId, agent.id, sha256hex(token), token.slice(0, 8), JSON.stringify(scopes), tenantAllowlist, now);

    const row = sqlite
      .prepare(
        `SELECT id, agent_id, key_prefix, scopes, tenant_allowlist, created_at, last_used_at, revoked_at
         FROM agent_api_keys WHERE id = ?`,
      )
      .get(keyId) as AgentKeyRow;

    res.status(201).json({ token, key: serializeKey(row) });
  });

  router.get("/agents/:id/keys", (req, res) => {
    if (!requireLocalAdmin(req, res, config)) return;
    const sqlite = getSqlite();
    const agent = sqlite
      .prepare("SELECT id FROM execution_agents WHERE id = ?")
      .get(req.params.id) as { id: string } | undefined;
    if (!agent) {
      res.status(404).json({ error: "agent_not_found" });
      return;
    }

    const rows = sqlite
      .prepare(
        `SELECT id, agent_id, key_prefix, scopes, tenant_allowlist, created_at, last_used_at, revoked_at
         FROM agent_api_keys WHERE agent_id = ? ORDER BY created_at DESC`,
      )
      .all(agent.id) as AgentKeyRow[];

    res.json({ keys: rows.map(serializeKey) });
  });

  router.post("/agents/:id/keys/:keyId/revoke", (req, res) => {
    if (!requireLocalAdmin(req, res, config)) return;
    const sqlite = getSqlite();
    const now = new Date().toISOString();
    const result = sqlite
      .prepare(
        `UPDATE agent_api_keys
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE id = ? AND agent_id = ?`,
      )
      .run(now, req.params.keyId, req.params.id);
    if (result.changes === 0) {
      res.status(404).json({ error: "key_not_found" });
      return;
    }

    const row = sqlite
      .prepare(
        `SELECT id, agent_id, key_prefix, scopes, tenant_allowlist, created_at, last_used_at, revoked_at
         FROM agent_api_keys WHERE id = ?`,
      )
      .get(req.params.keyId) as AgentKeyRow;

    res.json({ key: serializeKey(row) });
  });

  return router;
}
