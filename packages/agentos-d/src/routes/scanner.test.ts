import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { migrate } from "../db/migrations/index.js";
import type { Scope } from "../auth/principal.js";

// vi.hoisted ensures _dbState is available inside the vi.mock factory
// even though vi.mock is hoisted to the top of the module by vitest.
const _dbState = vi.hoisted(() => ({ sqlite: null as Database.Database | null }));

vi.mock("../db/index.js", async () => {
  const { drizzle: _drizzle } = await import("drizzle-orm/better-sqlite3");
  const mockDb = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    run: vi.fn().mockReturnThis(),
    all: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(null),
  };
  return {
    // When _dbState.sqlite is set, use real drizzle (for scoped-principal tests).
    // Otherwise return the mock (for all existing tests).
    getDb: () => (_dbState.sqlite !== null ? _drizzle(_dbState.sqlite) : mockDb),
    // getSqlite is called by require-auth middleware to look up agent keys.
    // Throws when _dbState.sqlite is null → middleware falls back to loopback=owner.
    getSqlite: () => {
      if (_dbState.sqlite !== null) return _dbState.sqlite;
      throw new Error("SQLite not initialized");
    },
  };
});

// Capture the real globalThis.fetch once at module load — before any vi.fn() wrappers
// are installed. This is the anchor we restore to in afterEach.
const originalFetch: typeof global.fetch = globalThis.fetch;

describe("scanner routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    // Pin to localhost:1 so the "unreachable" test stays deterministic even
    // if the developer has the scanner-worker running on its real port.
    // loadConfig() doesn't expose scannerSidecarUrl through env vars, so we
    // build the Config object inline rather than threading another env hook.
    const base = loadConfig({});
    app = createApp({ ...base, scannerSidecarUrl: "http://127.0.0.1:1" });
    vi.clearAllMocks();
    // Always restore to the real globalThis.fetch before each test.
    // This prevents scanner.test.ts's mock from leaking into other test files
    // when pool=forks+singleFork runs everything in one process.
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("POST /api/scanner/submit", () => {
    it("returns 400 when neither targetUrl nor pasteContent is provided", async () => {
      const res = await request(app)
        .post("/api/scanner/submit")
        .send({ tenantId: "550e8400-e29b-41d4-a716-446655440000" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("returns 400 for invalid UUID", async () => {
      const res = await request(app)
        .post("/api/scanner/submit")
        .send({ tenantId: "not-a-uuid", pasteContent: "test" });
      expect(res.status).toBe(400);
    });

    it("returns 502 when scanner-worker is unreachable", async () => {
      // Mock fetch to throw so the route's try/catch fires and returns 502
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      global.fetch = vi.fn<any>().mockRejectedValue(new Error("ENOTFOUND"));

      const res = await request(app)
        .post("/api/scanner/submit")
        .send({
          tenantId: "550e8400-e29b-41d4-a716-446655440000",
          pasteContent: "test content",
        });
      expect(res.status).toBe(502);
      expect(res.body.error).toBe("scanner_worker_unreachable");
    });
  });

  describe("GET /api/scanner/jobs/:id", () => {
    it("returns 404 when job not found", async () => {
      // Mock fetch to return 404 so the route proxies it correctly
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      global.fetch = vi.fn<any>().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve("not found"),
      });

      const res = await request(app).get(
        "/api/scanner/jobs/nonexistent-id?tenantId=550e8400-e29b-41d4-a716-446655440000",
      );
      expect(res.status).toBe(404);
    });

    it("returns 400 when tenantId is missing or not a UUID", async () => {
      const noTenant = await request(app).get("/api/scanner/jobs/scan-123");
      expect(noTenant.status).toBe(400);

      const badTenant = await request(app).get(
        "/api/scanner/jobs/scan-123?tenantId=not-a-uuid",
      );
      expect(badTenant.status).toBe(400);
    });
  });

  describe("POST /api/scanner/findings", () => {
    it("persists an automation-submitted finding", async () => {
      const mockDb = vi.mocked(await import("../db/index.js")).getDb();
      const res = await request(app)
        .post("/api/scanner/findings")
        .send({
          tenantId: "550e8400-e29b-41d4-a716-446655440000",
          severity: "high",
          title: "Workflow credential exposure",
          description: "Credential appears in workflow JSON",
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("open");
      expect(mockDb.insert).toHaveBeenCalledOnce();
    });
  });

  describe("GET /api/scanner/findings", () => {
    it("returns paginated findings", async () => {
      const mockDb = vi.mocked(await import("../db/index.js")).getDb();
      vi.mocked(mockDb.select).mockReturnThis();
      vi.mocked(mockDb.from).mockReturnThis();
      vi.mocked(mockDb.where).mockReturnThis();
      vi.mocked(mockDb.orderBy).mockReturnThis();
      vi.mocked(mockDb.limit).mockReturnThis();
      vi.mocked(mockDb.offset).mockReturnThis();
      vi.mocked(mockDb.all).mockReturnValue([
        {
          id: "finding-1",
          tenantId: "tenant-1",
          originId: "origin-1",
          originKind: "scanner_finding",
          severity: "high",
          ruleId: "rule-1",
          title: "Test finding",
          description: "A test",
          remediation: "Fix it",
          affectedEndpoint: null,
          status: "open",
          resolvedBy: null,
          resolvedAt: null,
          resolutionNote: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);
      vi.mocked(mockDb.get).mockReturnValue({ count: 1 });

      const res = await request(app).get("/api/scanner/findings");
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.total).toBe(1);
    });

    it("filters findings by severity", async () => {
      const mockDb = vi.mocked(await import("../db/index.js")).getDb();
      vi.mocked(mockDb.select).mockReturnThis();
      vi.mocked(mockDb.from).mockReturnThis();
      vi.mocked(mockDb.where).mockReturnThis();
      vi.mocked(mockDb.orderBy).mockReturnThis();
      vi.mocked(mockDb.limit).mockReturnThis();
      vi.mocked(mockDb.offset).mockReturnThis();
      vi.mocked(mockDb.all).mockReturnValue([]);
      vi.mocked(mockDb.get).mockReturnValue({ count: 0 });

      const res = await request(app).get("/api/scanner/findings?severity=critical");
      expect(res.status).toBe(200);
      // Invalid severity is silently ignored (logs warning)
      expect(res.body.items).toHaveLength(0);
    });
  });

  describe("GET /api/scanner/health", () => {
    it("returns healthy when scanner-worker responds 200", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            scannerVersion: "0.1.0",
            definitionsLoaded: true,
            definitionsCount: 47,
          }),
      });
      // @ts-ignore — override fetch for this test scope
      global.fetch = mockFetch;

      const res = await request(app).get("/api/scanner/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("healthy");
      expect(res.body.scannerVersion).toBe("0.1.0");
      expect(res.body.definitionsCount).toBe(47);
    });

    it("returns 503 when scanner-worker is unreachable", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).get("/api/scanner/health");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("unhealthy");
      expect(res.body.reason).toBe("scanner_worker_unreachable");
    });

    it("returns 503 when scanner-worker returns non-200", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ reason: "definitions_failed_to_load" }),
      });
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).get("/api/scanner/health");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("unhealthy");
    });
  });

  describe("POST /api/scanner/batch", () => {
    const validBatch = {
      tenantId: "550e8400-e29b-41d4-a716-446655440000",
      targets: [
        { type: "claude_md", path: "/test/.claude.md", content: "# Test" },
        { type: "cursorrules", path: "/test/.cursorrules", content: "[]" },
      ],
      policyMode: "shadow",
      priority: "standard",
    };

    it("returns 400 when targets array is empty", async () => {
      const res = await request(app)
        .post("/api/scanner/batch")
        .send({ tenantId: "550e8400-e29b-41d4-a716-446655440000", targets: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("returns 400 for invalid target type", async () => {
      const res = await request(app)
        .post("/api/scanner/batch")
        .send({
          tenantId: "550e8400-e29b-41d4-a716-446655440000",
          targets: [{ type: "invalid_type", path: "/test", content: "x" }],
        });
      expect(res.status).toBe(400);
    });

    it("returns 502 when scanner-worker is unreachable", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).post("/api/scanner/batch").send(validBatch);
      expect(res.status).toBe(502);
      expect(res.body.error).toBe("scanner_worker_unreachable");
    });

    it("returns 501 when scanner-worker returns 404 (not implemented)", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve("Not Found"),
      });
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).post("/api/scanner/batch").send(validBatch);
      expect(res.status).toBe(501);
      expect(res.body.error).toBe("batch_not_implemented");
    });

    it("returns 202 with normalized snake_case keys when scanner-worker returns 202", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        json: () =>
          Promise.resolve({
            batch_id: "batch-123",
            status: "queued",
            targetCount: 2,
            estimatedSeconds: 30,
          }),
      });
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).post("/api/scanner/batch").send(validBatch);
      expect(res.status).toBe(202);
      expect(res.body.batchId).toBe("batch-123");
      expect(res.body.status).toBe("queued");
      expect(res.body.targetCount).toBe(2);
      expect(res.body.estimatedSeconds).toBe(30);
    });

    it("uses client-provided batchId if supplied", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        json: () =>
          Promise.resolve({
            batch_id: "client-batch-456",
            status: "queued",
            targetCount: 2,
          }),
      });
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app)
        .post("/api/scanner/batch")
        .send({ ...validBatch, batchId: "client-batch-456" });
      expect(res.status).toBe(202);
      expect(res.body.batchId).toBe("client-batch-456");
    });
  });

  describe("tenant isolation", () => {
    const TENANT_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const TENANT_B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

    // Build a config that uses a known owner token so we can send scoped requests.
    // The default loadConfig has no OWNER_TOKEN set, so loopback = owner. To test
    // a scoped principal we need a token.  We can't easily create a scoped agent key
    // in the mock-DB environment, but we CAN verify:
    //   1. UUID validation rejects non-UUIDs (400).
    //   2. Owner principal (loopback, no token) is allowed any tenant (existing behavior preserved).
    //   3. assertTenantAllowed is present in scanner.ts (static coverage test below).

    it("GET /jobs/:id returns 400 for non-UUID tenantId", async () => {
      const res = await request(app).get("/api/scanner/jobs/scan-abc?tenantId=NOT-A-UUID");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("GET /jobs/:id returns 400 when tenantId is absent", async () => {
      const res = await request(app).get("/api/scanner/jobs/scan-abc");
      expect(res.status).toBe(400);
    });

    it("GET /findings returns 400 for non-UUID tenantId filter", async () => {
      const res = await request(app).get("/api/scanner/findings?tenantId=bad-id");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("POST /jobs/:id/cancel returns 400 when tenantId is absent", async () => {
      const res = await request(app).post("/api/scanner/jobs/scan-abc/cancel");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("POST /jobs/:id/cancel returns 400 for non-UUID tenantId", async () => {
      const res = await request(app).post("/api/scanner/jobs/scan-abc/cancel?tenantId=NOT-A-UUID");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("GET /jobs/:id/sarif returns 400 when tenantId is absent", async () => {
      const res = await request(app).get("/api/scanner/jobs/scan-abc/sarif");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("GET /jobs/:id/sarif returns 400 for non-UUID tenantId", async () => {
      const res = await request(app).get("/api/scanner/jobs/scan-abc/sarif?tenantId=NOT-A-UUID");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("GET /jobs/:id/json returns 400 when tenantId is absent", async () => {
      const res = await request(app).get("/api/scanner/jobs/scan-abc/json");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("GET /jobs/:id/json returns 400 for non-UUID tenantId", async () => {
      const res = await request(app).get("/api/scanner/jobs/scan-abc/json?tenantId=NOT-A-UUID");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("POST /submit returns 400 for non-UUID tenantId", async () => {
      const res = await request(app)
        .post("/api/scanner/submit")
        .send({ tenantId: "bad-id", pasteContent: "test" });
      expect(res.status).toBe(400);
    });

    it("POST /batch returns 400 for non-UUID tenantId", async () => {
      const res = await request(app)
        .post("/api/scanner/batch")
        .send({ tenantId: "bad", targets: [{ type: "claude_md", path: "/x", content: "y" }] });
      expect(res.status).toBe(400);
    });

    it("POST /findings returns 400 for non-UUID tenantId", async () => {
      const res = await request(app)
        .post("/api/scanner/findings")
        .send({ tenantId: "not-uuid", title: "T" });
      expect(res.status).toBe(400);
    });

    it("owner principal (loopback) is allowed any valid tenantId on GET /findings", async () => {
      const mockDb = vi.mocked(await import("../db/index.js")).getDb();
      vi.mocked(mockDb.all).mockReturnValue([]);
      vi.mocked(mockDb.get).mockReturnValue({ count: 0 });

      const res = await request(app).get(`/api/scanner/findings?tenantId=${TENANT_A}`);
      expect(res.status).toBe(200);
    });

    it("owner principal (loopback) is allowed any valid tenantId on GET /jobs/:id", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      global.fetch = vi.fn<any>().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve("not found"),
      });

      const res = await request(app).get(`/api/scanner/jobs/scan-xyz?tenantId=${TENANT_B}`);
      // 404 from scanner-worker proxy = ownership check passed, job just doesn't exist
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /api/scanner/findings/:id", () => {
    it("returns 404 when finding does not exist", async () => {
      const mockDb = vi.mocked(await import("../db/index.js")).getDb();
      vi.mocked(mockDb.select).mockReturnThis();
      vi.mocked(mockDb.from).mockReturnThis();
      vi.mocked(mockDb.where).mockReturnThis();
      vi.mocked(mockDb.get).mockReturnValue(null);

      const res = await request(app)
        .patch("/api/scanner/findings/nonexistent")
        .send({ status: "resolved" });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/scanner/jobs/:id/sarif", () => {
    const sarifBody = JSON.stringify({
      version: "2.1.0",
      runs: [
        {
          results: [
            {
              ruleId: "AWCP-001",
              level: "error",
              message: { text: "Hardcoded credential detected" },
              locations: [{ physicalLocation: { artifactLocation: { uri: "src/auth.ts" } } }],
            },
          ],
        },
      ],
    });

    it("returns SARIF 2.1.0 with correct content-type when job exists", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(sarifBody),
        headers: new Headers({ "content-type": "application/json" }),
      });
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).get(
        "/api/scanner/jobs/scan-123/sarif?tenantId=550e8400-e29b-41d4-a716-446655440000",
      );
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      const parsed = JSON.parse(res.text);
      expect(parsed.version).toBe("2.1.0");
      expect(parsed.runs[0].results[0].ruleId).toBe("AWCP-001");
    });

    it("returns 404 when job not found", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve("not found"),
      });
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).get(
        "/api/scanner/jobs/nonexistent/sarif?tenantId=550e8400-e29b-41d4-a716-446655440000",
      );
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });

    it("returns 503 when scanner-worker is unavailable", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve(""),
      });
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).get(
        "/api/scanner/jobs/scan-123/sarif?tenantId=550e8400-e29b-41d4-a716-446655440000",
      );
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("scanner_unavailable");
    });

    it("returns 502 when scanner-worker is unreachable", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).get(
        "/api/scanner/jobs/scan-123/sarif?tenantId=550e8400-e29b-41d4-a716-446655440000",
      );
      expect(res.status).toBe(502);
      expect(res.body.error).toBe("scanner_worker_unreachable");
    });
  });

  describe("GET /api/scanner/jobs/:id/json", () => {
    const jsonFindings = JSON.stringify({
      scanId: "scan-123",
      status: "complete",
      findings: [
        {
          id: "finding-1",
          ruleId: "AWCP-001",
          severity: "high",
          title: "Hardcoded credential",
          description: "A hardcoded credential was detected",
          location: { file: "src/auth.ts", line: 42 },
          remediation: "Remove the credential and use environment variables",
        },
      ],
    });

    it("returns findings JSON with correct content-type when job exists", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(jsonFindings),
        headers: new Headers({ "content-type": "application/json" }),
      });
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).get(
        "/api/scanner/jobs/scan-123/json?tenantId=550e8400-e29b-41d4-a716-446655440000",
      );
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      const parsed = JSON.parse(res.text);
      expect(parsed.scanId).toBe("scan-123");
      expect(parsed.findings[0].ruleId).toBe("AWCP-001");
    });

    it("returns 404 when job not found", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve("not found"),
      });
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).get(
        "/api/scanner/jobs/nonexistent/json?tenantId=550e8400-e29b-41d4-a716-446655440000",
      );
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });

    it("returns 503 when scanner-worker is unavailable", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve(""),
      });
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).get(
        "/api/scanner/jobs/scan-123/json?tenantId=550e8400-e29b-41d4-a716-446655440000",
      );
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("scanner_unavailable");
    });

    it("returns 502 when scanner-worker is unreachable", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
      // @ts-ignore
      global.fetch = mockFetch;

      const res = await request(app).get(
        "/api/scanner/jobs/scan-123/json?tenantId=550e8400-e29b-41d4-a716-446655440000",
      );
      expect(res.status).toBe(502);
      expect(res.body.error).toBe("scanner_worker_unreachable");
    });
  });

  // ---------------------------------------------------------------------------
  // Scoped-principal tenant isolation
  // These tests use a real in-memory SQLite (with full migrations) so that the
  // auth middleware can look up agent API keys and produce a scoped principal.
  // ---------------------------------------------------------------------------

  describe("scoped-principal tenant isolation", () => {
    const TENANT_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const TENANT_B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
    const AGENT_ID = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
    const COMPANY_A = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
    const OWNER_TOKEN = "scanner-test-owner-token";
    const SCOPED_TOKEN_A = "scanner-test-scoped-token-a";

    function sha256hex(token: string): string {
      return createHash("sha256").update(token).digest("hex");
    }

    function seedAgent(sqlite: Database.Database): void {
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

    function insertAgentKey(
      sqlite: Database.Database,
      opts: { token: string; scopes: Scope[]; tenants: string[] | "*" },
    ): void {
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
          null,
        );
    }

    function insertFinding(
      sqlite: Database.Database,
      opts: { id: string; tenantId: string },
    ): void {
      const now = new Date().toISOString();
      sqlite
        .prepare(
          `INSERT INTO scanner_findings
           (id, tenant_id, origin_kind, origin_id, severity, rule_id, title, description,
            remediation, affected_endpoint, status, resolved_by, resolved_at, resolution_note,
            created_at, updated_at)
           VALUES (?, ?, 'scanner_finding', ?, 'high', NULL, 'Test Finding', '',
                   NULL, NULL, 'open', NULL, NULL, NULL, ?, ?)`,
        )
        .run(opts.id, opts.tenantId, randomUUID(), now, now);
    }

    beforeEach(() => {
      const sqlite = new Database(":memory:");
      sqlite.pragma("foreign_keys = ON");
      migrate(sqlite);
      seedAgent(sqlite);
      insertAgentKey(sqlite, {
        token: SCOPED_TOKEN_A,
        scopes: ["memory:read"],
        tenants: [TENANT_A],
      });
      _dbState.sqlite = sqlite;
      process.env.AGENTOS_API_KEY = OWNER_TOKEN;
      process.env.AGENTOS_REQUIRE_TOKEN = "true";
      const base = loadConfig({});
      app = createApp({ ...base, scannerSidecarUrl: "http://127.0.0.1:1" });
    });

    afterEach(() => {
      _dbState.sqlite?.close();
      _dbState.sqlite = null;
      delete process.env.AGENTOS_API_KEY;
      delete process.env.AGENTOS_REQUIRE_TOKEN;
      globalThis.fetch = originalFetch;
    });

    it("PATCH /findings/:id returns 403 when finding belongs to tenant B but principal is scoped to tenant A", async () => {
      const findingId = randomUUID();
      insertFinding(_dbState.sqlite!, { id: findingId, tenantId: TENANT_B });

      const res = await request(app)
        .patch(`/api/scanner/findings/${findingId}`)
        .set("Authorization", `Bearer ${SCOPED_TOKEN_A}`)
        .send({ status: "resolved" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    it("GET /findings returns 403 when tenantId is absent and principal is scoped", async () => {
      const res = await request(app)
        .get("/api/scanner/findings")
        .set("Authorization", `Bearer ${SCOPED_TOKEN_A}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("tenant_required");
    });

    it("GET /findings returns 200 when tenantId matches scoped principal's allowed tenant", async () => {
      const res = await request(app)
        .get(`/api/scanner/findings?tenantId=${TENANT_A}`)
        .set("Authorization", `Bearer ${SCOPED_TOKEN_A}`);

      expect(res.status).toBe(200);
    });

    it("GET /findings returns 403 when tenantId is a valid UUID but not in principal's tenant list", async () => {
      const res = await request(app)
        .get(`/api/scanner/findings?tenantId=${TENANT_B}`)
        .set("Authorization", `Bearer ${SCOPED_TOKEN_A}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    it("POST /jobs/:id/cancel returns 403 when tenantId is not in principal's tenant list", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      global.fetch = vi.fn<any>().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });

      const res = await request(app)
        .post(`/api/scanner/jobs/scan-xyz/cancel?tenantId=${TENANT_B}`)
        .set("Authorization", `Bearer ${SCOPED_TOKEN_A}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    it("POST /jobs/:id/cancel proceeds (proxy call) when tenantId is in principal's tenant list", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      global.fetch = vi.fn<any>().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: "cancelled" }),
      });

      const res = await request(app)
        .post(`/api/scanner/jobs/scan-xyz/cancel?tenantId=${TENANT_A}`)
        .set("Authorization", `Bearer ${SCOPED_TOKEN_A}`);

      // Auth passed; scanner-worker mock returned 200
      expect(res.status).toBe(200);
    });

    it("GET /jobs/:id/sarif returns 403 when tenantId is not in principal's tenant list", async () => {
      const res = await request(app)
        .get(`/api/scanner/jobs/scan-xyz/sarif?tenantId=${TENANT_B}`)
        .set("Authorization", `Bearer ${SCOPED_TOKEN_A}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    it("GET /jobs/:id/json returns 403 when tenantId is not in principal's tenant list", async () => {
      const res = await request(app)
        .get(`/api/scanner/jobs/scan-xyz/json?tenantId=${TENANT_B}`)
        .set("Authorization", `Bearer ${SCOPED_TOKEN_A}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    it("owner principal passes GET /findings without tenantId (tenants='*')", async () => {
      const res = await request(app)
        .get("/api/scanner/findings")
        .set("Authorization", `Bearer ${OWNER_TOKEN}`);

      expect(res.status).toBe(200);
    });
  });
});
