import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Request } from "express";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { resolvePrincipal, ALL_SCOPES } from "./principal.js";
import type { Config } from "../config.js";
import { migrate } from "../db/migrations/index.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 7710,
    logLevel: "silent",
    awcpVersion: "awcp/v0.1",
    dataDir: "/tmp/test-data",
    scannerSidecarUrl: "http://127.0.0.1:3101",
    scannerPollIntervalMs: 30_000,
    auditLogRetentionDays: 30,
    companyId: "",
    standingIssueId: "standing",
    legacyBridgeUrl: "http://127.0.0.1:3100",
    legacyBridgeApiKey: "test-bridge-key",
    legacyBridgeEnabled: false,
    executionDatabaseUrl: undefined,
    agentsRoot: "",
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
    } as unknown as Config["logger"],
    ...overrides,
  };
}

function makeReq(opts: { remoteAddress?: string; authHeader?: string } = {}): Request {
  return {
    socket: { remoteAddress: opts.remoteAddress ?? "127.0.0.1" },
    header: (name: string) => {
      if (name.toLowerCase() === "authorization") return opts.authHeader;
      return undefined;
    },
  } as unknown as Request;
}

function sha256hex(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function openTestDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "awos-test-principal-"));
  const sqlite = new Database(join(dir, "test.db"));
  sqlite.pragma("foreign_keys = ON");
  migrate(sqlite);
  return sqlite;
}

function insertAgentKey(
  sqlite: Database.Database,
  opts: {
    id: string;
    agentId?: string;
    token: string;
    scopes: string[];
    tenantAllowlist: string[] | "*";
    revokedAt?: string;
  },
): void {
  // Insert a stub execution_agent row if it doesn't already exist
  const agentId = opts.agentId ?? "agent-001";
  const existingAgent = sqlite
    .prepare("SELECT 1 FROM execution_agents WHERE id = ?")
    .get(agentId);
  if (!existingAgent) {
    sqlite.exec(`
      INSERT OR IGNORE INTO execution_companies (id, tenant_id, name, created_at, updated_at)
      VALUES ('co-001', 'tenant-001', 'Test Co', datetime('now'), datetime('now'));
    `);
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO execution_agents
         (id, tenant_id, company_id, name, created_at, updated_at)
         VALUES (?, 'tenant-001', 'co-001', 'Test Agent', datetime('now'), datetime('now'))`,
      )
      .run(agentId);
  }

  sqlite
    .prepare(
      `INSERT INTO agent_api_keys
       (id, agent_id, key_hash, key_prefix, scopes, tenant_allowlist, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
    )
    .run(
      opts.id,
      agentId,
      sha256hex(opts.token),
      opts.token.slice(0, 8),
      JSON.stringify(opts.scopes),
      opts.tenantAllowlist === "*" ? "*" : JSON.stringify(opts.tenantAllowlist),
      opts.revokedAt ?? null,
    );
}

describe("resolvePrincipal", () => {
  let sqlite: Database.Database;
  const config = makeConfig({ legacyBridgeApiKey: "owner-token" });

  beforeEach(() => {
    delete process.env.AGENTOS_ADMIN_TOKEN;
    delete process.env.AGENTOS_API_KEY;
    delete process.env.AGENTOS_REQUIRE_TOKEN;
    sqlite = openTestDb();
  });

  afterEach(() => {
    sqlite.close();
    delete process.env.AGENTOS_ADMIN_TOKEN;
    delete process.env.AGENTOS_API_KEY;
    delete process.env.AGENTOS_REQUIRE_TOKEN;
  });

  // ---------------------------------------------------------------------------
  // Case a: owner token → OWNER
  // ---------------------------------------------------------------------------
  it("owner token → OWNER principal with all scopes", () => {
    const req = makeReq({ remoteAddress: "10.0.0.1", authHeader: "Bearer owner-token" });
    const principal = resolvePrincipal(req, config, sqlite);
    expect(principal).not.toBeNull();
    expect(principal!.kind).toBe("owner");
    expect(principal!.id).toBe("owner");
    expect(principal!.tenants).toBe("*");
    for (const scope of ALL_SCOPES) {
      expect(principal!.scopes.has(scope)).toBe(true);
    }
  });

  it("AGENTOS_ADMIN_TOKEN overrides legacyBridgeApiKey for owner token", () => {
    process.env.AGENTOS_ADMIN_TOKEN = "admin-tok";
    const req = makeReq({ remoteAddress: "10.0.0.1", authHeader: "Bearer admin-tok" });
    const principal = resolvePrincipal(req, config, sqlite);
    expect(principal?.kind).toBe("owner");
  });

  // ---------------------------------------------------------------------------
  // Case b: valid agent key → scoped AGENT
  // ---------------------------------------------------------------------------
  it("valid agent key on remote IP → scoped AGENT principal", () => {
    insertAgentKey(sqlite, {
      id: "key-001",
      token: "agtk_validtoken1",
      scopes: ["memory:read", "policy:check"],
      tenantAllowlist: ["tenant-abc"],
    });

    const req = makeReq({ remoteAddress: "10.0.0.1", authHeader: "Bearer agtk_validtoken1" });
    const principal = resolvePrincipal(req, config, sqlite);
    expect(principal).not.toBeNull();
    expect(principal!.kind).toBe("agent");
    expect(principal!.scopes.has("memory:read")).toBe(true);
    expect(principal!.scopes.has("policy:check")).toBe(true);
    expect(principal!.scopes.has("memory:write")).toBe(false);
    expect(principal!.tenants).toEqual(["tenant-abc"]);
  });

  it("valid agent key with wildcard tenant allowlist", () => {
    insertAgentKey(sqlite, {
      id: "key-002",
      token: "agtk_wildcardtoken",
      scopes: ["dispatch:write"],
      tenantAllowlist: "*",
    });

    const req = makeReq({ remoteAddress: "10.0.0.1", authHeader: "Bearer agtk_wildcardtoken" });
    const principal = resolvePrincipal(req, config, sqlite);
    expect(principal?.kind).toBe("agent");
    expect(principal?.tenants).toBe("*");
  });

  // ---------------------------------------------------------------------------
  // Critical: valid agent key on loopback stays AGENT, NOT elevated to OWNER
  // ---------------------------------------------------------------------------
  it("valid agent key on loopback stays scoped AGENT, not elevated to owner", () => {
    insertAgentKey(sqlite, {
      id: "key-003",
      token: "agtk_loopbackagent",
      scopes: ["memory:read"],
      tenantAllowlist: ["tenant-xyz"],
    });

    const req = makeReq({ remoteAddress: "127.0.0.1", authHeader: "Bearer agtk_loopbackagent" });
    const principal = resolvePrincipal(req, config, sqlite);
    expect(principal?.kind).toBe("agent");
    expect(principal?.scopes.has("admin")).toBe(false);
    expect(principal?.tenants).toEqual(["tenant-xyz"]);
  });

  // ---------------------------------------------------------------------------
  // Case c: bearer present but unmatched → null
  // ---------------------------------------------------------------------------
  it("unknown Bearer token → null (wrong token)", () => {
    const req = makeReq({ remoteAddress: "10.0.0.1", authHeader: "Bearer no-such-token" });
    const principal = resolvePrincipal(req, config, sqlite);
    expect(principal).toBeNull();
  });

  it("revoked agent key → null", () => {
    insertAgentKey(sqlite, {
      id: "key-004",
      token: "agtk_revokedtoken",
      scopes: ["memory:read"],
      tenantAllowlist: ["tenant-abc"],
      revokedAt: new Date().toISOString(),
    });

    const req = makeReq({ remoteAddress: "10.0.0.1", authHeader: "Bearer agtk_revokedtoken" });
    const principal = resolvePrincipal(req, config, sqlite);
    expect(principal).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Case d: no bearer + loopback (no AGENTOS_REQUIRE_TOKEN) → OWNER
  // ---------------------------------------------------------------------------
  it("no bearer on loopback → OWNER (zero-config default)", () => {
    const req = makeReq({ remoteAddress: "127.0.0.1" });
    const principal = resolvePrincipal(req, config, sqlite);
    expect(principal?.kind).toBe("owner");
    expect(principal?.tenants).toBe("*");
  });

  it("no bearer on Docker bridge → OWNER", () => {
    const req = makeReq({ remoteAddress: "172.18.0.4" });
    const principal = resolvePrincipal(req, config, sqlite);
    expect(principal?.kind).toBe("owner");
  });

  // ---------------------------------------------------------------------------
  // Case e: no bearer + external IP → null
  // ---------------------------------------------------------------------------
  it("no bearer on external IP → null", () => {
    const req = makeReq({ remoteAddress: "10.0.0.1" });
    const principal = resolvePrincipal(req, config, sqlite);
    expect(principal).toBeNull();
  });

  it("AGENTOS_REQUIRE_TOKEN=true + loopback + no bearer → null", () => {
    process.env.AGENTOS_REQUIRE_TOKEN = "true";
    const req = makeReq({ remoteAddress: "127.0.0.1" });
    const principal = resolvePrincipal(req, config, sqlite);
    expect(principal).toBeNull();
  });

  it("AGENTOS_REQUIRE_TOKEN=true + loopback + owner bearer → OWNER", () => {
    process.env.AGENTOS_REQUIRE_TOKEN = "true";
    const req = makeReq({ remoteAddress: "127.0.0.1", authHeader: "Bearer owner-token" });
    const principal = resolvePrincipal(req, config, sqlite);
    expect(principal?.kind).toBe("owner");
  });
});
