import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { migrate } from "../db/migrations/index.js";
import type { Scope } from "../auth/principal.js";
import { _resetVaultStoreForTesting } from "./memory.js";

let sqlite: Database.Database;

vi.mock("../db/index.js", () => ({
  getDb: () => drizzle(sqlite),
  getSqlite: () => sqlite,
}));

vi.mock("../services/embed-client.js", () => ({
  EmbedClient: class {},
}));

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_TOKEN = "owner-test-token";

let vaultRoot: string;

function sha256hex(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function seedAgent(): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO execution_companies
       (id, tenant_id, name, status, metadata_json, source, created_at, updated_at)
       VALUES (?, ?, 'Test Company', 'active', '{}', 'awos', ?, ?)`,
    )
    .run(COMPANY_A, TENANT_A, now, now);
  sqlite
    .prepare(
      `INSERT INTO execution_agents
       (id, tenant_id, company_id, name, role, status, config_json, source, created_at, updated_at)
       VALUES (?, ?, ?, 'Test Agent', 'worker', 'active', '{}', 'awos', ?, ?)`,
    )
    .run(AGENT_ID, TENANT_A, COMPANY_A, now, now);
}

function insertAgentKey(opts: {
  token: string;
  scopes: Scope[];
  tenants: string[] | "*";
  revokedAt?: string | null;
}): void {
  sqlite
    .prepare(
      `INSERT INTO agent_api_keys
       (id, agent_id, key_hash, key_prefix, scopes, tenant_allowlist, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      AGENT_ID,
      sha256hex(opts.token),
      opts.token.slice(0, 8),
      JSON.stringify(opts.scopes),
      opts.tenants === "*" ? "*" : JSON.stringify(opts.tenants),
      new Date().toISOString(),
      opts.revokedAt ?? null,
    );
}

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

describe("security identity enforcement", () => {
  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    migrate(sqlite);
    seedAgent();
    vaultRoot = mkdtempSync(join(tmpdir(), "awos-security-identity-"));
    process.env.VAULT_ROOT = vaultRoot;
    process.env.AGENTOS_API_KEY = OWNER_TOKEN;
    process.env.AGENTOS_REQUIRE_TOKEN = "true";
    _resetVaultStoreForTesting();
  });

  afterEach(() => {
    sqlite.close();
    rmSync(vaultRoot, { recursive: true, force: true });
    delete process.env.VAULT_ROOT;
    delete process.env.AGENTOS_API_KEY;
    delete process.env.AGENTOS_REQUIRE_TOKEN;
    vi.clearAllMocks();
  });

  it("denies memory writes when an agent lacks memory:write", async () => {
    const token = "agtk_memory_read_only";
    insertAgentKey({ token, scopes: ["memory:read"], tenants: [TENANT_A] });

    const app = createApp(loadConfig({ AGENTOS_LOG_LEVEL: "fatal" }));
    const res = await request(app)
      .post("/api/memory/write")
      .set(auth(token))
      .send({ tenantId: TENANT_A, key: "notes/a", body: "blocked" });

    expect(res.status).toBe(403);
    expect(res.body.required_scope).toBe("memory:write");
  });

  it("denies MCP operator-memory reads without operator-memory:read", async () => {
    const token = "agtk_no_operator_memory";
    insertAgentKey({ token, scopes: ["memory:read"], tenants: [TENANT_A] });

    const app = createApp(loadConfig({ AGENTOS_LOG_LEVEL: "fatal" }));
    const res = await request(app)
      .post("/api/mcp")
      .set(auth(token))
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory.read",
          arguments: { tenantId: TENANT_A, namespace: "operator", key: "missing" },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.required_scope).toBe("operator-memory:read");
  });

  it("allows the owner token through scoped endpoints", async () => {
    const app = createApp(loadConfig({ AGENTOS_LOG_LEVEL: "fatal" }));
    const write = await request(app)
      .post("/api/memory/write")
      .set(auth(OWNER_TOKEN))
      .send({ tenantId: TENANT_A, key: "notes/a", body: "ok" });

    expect(write.status).toBe(201);

    const operatorRead = await request(app)
      .post("/api/mcp")
      .set(auth(OWNER_TOKEN))
      .send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "memory.read",
          arguments: { tenantId: TENANT_A, namespace: "operator", key: "missing" },
        },
      });

    expect(operatorRead.status).toBe(200);
  });

  it("binds body, query, and param tenantIds to the agent allowlist", async () => {
    const token = "agtk_tenant_a_only";
    insertAgentKey({
      token,
      scopes: ["memory:read", "memory:write", "dispatch:write"],
      tenants: [TENANT_A],
    });

    const app = createApp(loadConfig({ AGENTOS_LOG_LEVEL: "fatal" }));
    const bodyRes = await request(app)
      .post("/api/memory/read")
      .set(auth(token))
      .send({ tenantId: TENANT_B, key: "notes/a" });
    const queryRes = await request(app)
      .get("/api/memory/metadata")
      .set(auth(token))
      .query({ tenantId: TENANT_B });
    const paramRes = await request(app)
      .post(`/api/dispatch/${randomUUID()}/retry`)
      .set(auth(token))
      .send({ tenantId: TENANT_B });

    expect(bodyRes.status).toBe(403);
    expect(queryRes.status).toBe(403);
    expect(paramRes.status).toBe(403);
  });

  it("mints plaintext once, hides hash/plaintext on list, and revoked keys stop authenticating", async () => {
    const app = createApp(loadConfig({ AGENTOS_LOG_LEVEL: "fatal" }));
    const created = await request(app)
      .post(`/api/admin/agents/${AGENT_ID}/keys`)
      .set(auth(OWNER_TOKEN))
      .send({ scopes: ["memory:read"], tenantAllowlist: [TENANT_A] });

    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^agtk_/);
    expect(created.body.key.keyHash).toBeUndefined();

    const row = sqlite
      .prepare("SELECT key_hash, key_prefix FROM agent_api_keys WHERE id = ?")
      .get(created.body.key.id) as { key_hash: string; key_prefix: string };
    expect(row.key_hash).toBe(sha256hex(created.body.token));
    expect(row.key_hash).not.toContain(created.body.token);
    expect(row.key_prefix).toBe(created.body.token.slice(0, 8));

    const listed = await request(app)
      .get(`/api/admin/agents/${AGENT_ID}/keys`)
      .set(auth(OWNER_TOKEN));
    expect(listed.status).toBe(200);
    expect(listed.body.keys).toHaveLength(1);
    expect(listed.body.keys[0].token).toBeUndefined();
    expect(listed.body.keys[0].keyHash).toBeUndefined();

    const beforeRevoke = await request(app)
      .post("/api/memory/read")
      .set(auth(created.body.token as string))
      .send({ tenantId: TENANT_A, key: "notes/a" });
    expect(beforeRevoke.status).toBe(200);

    const revoked = await request(app)
      .post(`/api/admin/agents/${AGENT_ID}/keys/${created.body.key.id}/revoke`)
      .set(auth(OWNER_TOKEN))
      .send({});
    expect(revoked.status).toBe(200);

    const afterRevoke = await request(app)
      .post("/api/memory/read")
      .set(auth(created.body.token as string))
      .send({ tenantId: TENANT_A, key: "notes/a" });
    expect(afterRevoke.status).toBe(401);
  });
});
