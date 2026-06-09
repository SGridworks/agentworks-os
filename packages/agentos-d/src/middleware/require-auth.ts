/**
 * Shared auth middleware — local-network trust + Bearer token gate.
 *
 * Applied app-wide to all /api/* routes except /api/health (Docker healthcheck).
 *
 * Token resolution (highest precedence first):
 *   AGENTOS_ADMIN_TOKEN → AGENTOS_API_KEY (the documented auth token env) →
 *   config.legacyBridgeApiKey → "local-trusted"
 *
 * Note: AGENTWORKS_SESSION_SECRET referenced in older docker-compose files has no
 * effect here. Operators should set AGENTOS_API_KEY as the auth token env instead.
 *
 * ACCESS MODEL — a request is admitted if ANY of these hold:
 *   1. It carries a valid `Authorization: Bearer <token>` (constant-time compare).
 *      This is the escalation path: a remote client with the token always gets in.
 *   2. Its source address is loopback (127.0.0.1 / ::1).
 *   3. Its source address is in the Docker bridge range (172.16.0.0/12).
 *
 * Rationale: agentos-d is a local-first appliance. The published host ports are
 * bound to 127.0.0.1 in docker-compose, so the LAN cannot reach this service at
 * all; the only non-loopback callers are sibling compose containers (admin-ui,
 * scanner) on the bridge network, which is why the bridge range is trusted
 * without a token. A Next.js `rewrites` proxy cannot inject an Authorization
 * header, so admin-ui relies on bridge trust rather than a forwarded token.
 *
 * HARDENING — set AGENTOS_REQUIRE_TOKEN=true to disable the loopback/bridge
 * bypass and require a valid token on every call. This is the strongest posture
 * (defends operator memory from other local processes), but it requires the
 * admin-ui to forward a token to agentos-d, which the rewrite-based proxy does
 * not do yet — enable only with a token-forwarding proxy in front.
 *
 * Everything else → 401.
 */

import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { ALL_SCOPES, resolvePrincipal } from "../auth/principal.js";
import * as dbIndex from "../db/index.js";

// ---------------------------------------------------------------------------
// Shared token resolution — identical to admin.ts adminToken()
// ---------------------------------------------------------------------------

export function resolveAdminToken(config: Config): string {
  return (
    process.env.AGENTOS_ADMIN_TOKEN ??
    // AGENTOS_API_KEY is the documented auth token env var.
    process.env.AGENTOS_API_KEY ??
    config.legacyBridgeApiKey ??
    "local-trusted"
  );
}

// ---------------------------------------------------------------------------
// Constant-time token comparison (guards against timing side-channels)
// ---------------------------------------------------------------------------

export function isValidToken(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export function hasValidBearerToken(req: Request, config: Config): boolean {
  const authHeader = req.header("authorization") ?? "";
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return false;
  return isValidToken(authHeader.slice(prefix.length), resolveAdminToken(config));
}

// ---------------------------------------------------------------------------
// Source-address trust — loopback and the Docker bridge range
// ---------------------------------------------------------------------------

/** Normalize an IPv6-mapped IPv4 address (::ffff:172.18.0.2 → 172.18.0.2). */
function normalizeIp(remote: string): string {
  return remote.startsWith("::ffff:") ? remote.slice("::ffff:".length) : remote;
}

export function isLoopback(req: Request): boolean {
  const remote = normalizeIp(req.socket.remoteAddress ?? "");
  return remote === "127.0.0.1" || remote === "::1";
}

/**
 * True when the source is in 172.16.0.0/12 — the range Docker allocates to
 * user-defined bridge networks. Sibling compose containers reach agentos-d
 * from this range; the LAN cannot, because the host port is bound to 127.0.0.1.
 */
export function isDockerBridge(req: Request): boolean {
  const remote = normalizeIp(req.socket.remoteAddress ?? "");
  const parts = remote.split(".");
  if (parts.length !== 4) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  // 172.16.0.0 – 172.31.255.255
  return a === 172 && b >= 16 && b <= 31;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * sqlite is optional for backward compatibility with tests that construct
 * the middleware without an initialized DB. When omitted the middleware
 * lazily calls getSqlite() from the DB module on each request — safe because
 * the DB is always initialized before any request arrives in production.
 */
export function createRequireAuthMiddleware(config: Config, sqlite?: Database.Database) {
  return function requireAuth(req: Request, res: Response, next: NextFunction): void {
    let db: Database.Database;
    if (sqlite !== undefined) {
      db = sqlite;
    } else {
      // Lazy import — avoids a circular dependency at module load time
      // and keeps the existing test signatures working (no DB arg).
      try {
        db = dbIndex.getSqlite();
      } catch {
        // DB not initialized yet (e.g. in unit tests for the middleware itself).
        // Fall back to admission logic without agent-key lookup.
        const requireTokenAlways = process.env.AGENTOS_REQUIRE_TOKEN === "true";
        if (hasValidBearerToken(req, config)) {
          req.principal = { kind: "owner", id: "owner", scopes: new Set(ALL_SCOPES), tenants: "*" };
          next();
          return;
        }
        if (!requireTokenAlways && (isLoopback(req) || isDockerBridge(req))) {
          req.principal = { kind: "owner", id: "owner", scopes: new Set(ALL_SCOPES), tenants: "*" };
          next();
          return;
        }
        res.status(401).json({ error: "unauthorized" });
        return;
      }
    }

    const principal = resolvePrincipal(req, config, db);
    if (principal !== null) {
      req.principal = principal;
      next();
      return;
    }

    res.status(401).json({ error: "unauthorized" });
  };
}
