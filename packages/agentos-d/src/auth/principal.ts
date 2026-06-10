/**
 * Principal resolution — per-request identity for the single-operator trust model.
 *
 * Resolution order (token checked BEFORE network trust so a scoped agent
 * on loopback stays scoped rather than being silently elevated):
 *   a. Bearer == owner token → OWNER (all scopes, tenants "*")
 *   b. Bearer matches a non-revoked agent_api_keys row → AGENT (key's scopes + tenant_allowlist)
 *   c. Bearer present but unmatched → null (caller will 401)
 *   d. No Bearer + !AGENTOS_REQUIRE_TOKEN + (loopback | Docker bridge) → OWNER
 *   e. else → null (caller will 401)
 */

import { createHash } from "node:crypto";
import type { Request } from "express";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import {
  resolveAdminToken,
  isValidToken,
  isLoopback,
  isDockerBridge,
} from "../middleware/require-auth.js";

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export type Scope =
  | "memory:read"
  | "memory:write"
  | "policy:check"
  | "dispatch:write"
  | "approvals:decide"
  | "operator-memory:read"
  | "admin";

export const ALL_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  "memory:read",
  "memory:write",
  "policy:check",
  "dispatch:write",
  "approvals:decide",
  "operator-memory:read",
  "admin",
]);

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------

export type Principal = {
  kind: "owner" | "agent";
  id: string;
  scopes: Set<Scope>;
  tenants: string[] | "*";
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256hex(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

type AgentKeyRow = {
  id: string;
  agent_id: string;
  scopes: string;
  tenant_allowlist: string;
  revoked_at: string | null;
};

function lookupAgentKey(sqlite: Database.Database, token: string): AgentKeyRow | null {
  const hash = sha256hex(token);
  const row = sqlite
    .prepare(
      "SELECT id, agent_id, scopes, tenant_allowlist, revoked_at FROM agent_api_keys WHERE key_hash = ? LIMIT 1",
    )
    .get(hash) as AgentKeyRow | undefined;
  return row ?? null;
}

function stampLastUsed(sqlite: Database.Database, keyId: string): void {
  try {
    sqlite
      .prepare("UPDATE agent_api_keys SET last_used_at = ? WHERE id = ?")
      .run(new Date().toISOString(), keyId);
  } catch {
    // best-effort; never fail the request due to a stamp error
  }
}

function ownerPrincipal(): Principal {
  return {
    kind: "owner",
    id: "owner",
    scopes: new Set(ALL_SCOPES),
    tenants: "*",
  };
}

// ---------------------------------------------------------------------------
// resolvePrincipal
// ---------------------------------------------------------------------------

export function resolvePrincipal(
  req: Request,
  config: Config,
  sqlite: Database.Database,
): Principal | null {
  const requireTokenAlways = process.env.AGENTOS_REQUIRE_TOKEN === "true";

  const authHeader = req.header("authorization") ?? "";
  const bearerPrefix = "Bearer ";
  const hasBearerHeader = authHeader.startsWith(bearerPrefix);
  const bearerToken = hasBearerHeader ? authHeader.slice(bearerPrefix.length) : null;

  if (bearerToken !== null) {
    // (a) Check owner token first
    const ownerToken = resolveAdminToken(config);
    if (isValidToken(bearerToken, ownerToken)) {
      return ownerPrincipal();
    }

    // (b) Check agent_api_keys
    const row = lookupAgentKey(sqlite, bearerToken);
    if (row !== null) {
      if (row.revoked_at !== null) {
        // (c) revoked — treat as unmatched
        return null;
      }

      stampLastUsed(sqlite, row.id);

      let parsedScopes: Scope[];
      try {
        parsedScopes = (JSON.parse(row.scopes) as string[]).filter(
          (s) => ALL_SCOPES.has(s as Scope),
        ) as Scope[];
      } catch {
        parsedScopes = [];
      }

      let tenants: string[] | "*";
      if (row.tenant_allowlist === "*") {
        tenants = "*";
      } else {
        try {
          tenants = JSON.parse(row.tenant_allowlist) as string[];
        } catch {
          tenants = [];
        }
      }

      return {
        kind: "agent",
        id: row.agent_id,
        scopes: new Set(parsedScopes),
        tenants,
      };
    }

    // (c) Bearer present but unmatched
    return null;
  }

  // No Bearer header
  if (!requireTokenAlways && (isLoopback(req) || isDockerBridge(req))) {
    // (d) zero-config local appliance default
    return ownerPrincipal();
  }

  // (e) no bearer, not local, or token required
  return null;
}
