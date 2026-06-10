/**
 * Tenant-access guards on admin routes.
 *
 * Verifies that:
 *   - A scoped agent principal (tenants: ["tenant-A"]) calling with tenant B's id → 403
 *   - An owner principal (tenants: "*") is always allowed (existing behaviour preserved)
 *   - A list route (activity-log, scope-violations) called without tenantId by a scoped
 *     principal → 403 { error: "tenant_required" }
 *
 * The require-auth middleware is mocked so we can control req.principal without
 * a real sqlite or network; the routes' own db calls use the existing mockDb stub.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type { Request, Response, NextFunction } from "express";
import { createApp } from "../app.js";
import type { Config } from "../config.js";
import type { Principal } from "../auth/principal.js";
import * as actionLogQuery from "../services/action-log-query.js";
import * as vaultDelta from "../services/vault-delta.js";
import * as morningBriefRecos from "../services/morning-brief-recos.js";

// ---------------------------------------------------------------------------
// Controllable principal — updated per-test via the module-level variable
// ---------------------------------------------------------------------------

let activePrincipal: Principal | null = null;

vi.mock("../middleware/require-auth.js", () => ({
  createRequireAuthMiddleware: () =>
    (req: Request, _res: Response, next: NextFunction) => {
      if (activePrincipal !== null) {
        req.principal = activePrincipal;
      }
      next();
    },
  resolveAdminToken: () => "local-trusted",
  isValidToken: () => false,
  isLoopback: () => false,
  isDockerBridge: () => false,
  hasValidBearerToken: () => false,
}));

// ---------------------------------------------------------------------------
// Shared DB mock (same shape as admin.test.ts)
// ---------------------------------------------------------------------------

const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  offset: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  run: vi.fn().mockReturnThis(),
  all: vi.fn().mockReturnValue([]),
  get: vi.fn().mockReturnValue(null),
  update: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
  groupBy: vi.fn().mockReturnThis(),
  $client: {
    prepare: vi.fn().mockReturnThis(),
    get: vi.fn().mockReturnValue({ count: 0 }),
    all: vi.fn().mockReturnValue([]),
  },
};

vi.mock("../db/index.js", () => ({
  getDb: () => mockDb,
  getSqlite: () => mockDb.$client,
}));

vi.mock("../db/client.js", () => ({
  getDb: () => mockDb,
  initDb: vi.fn(),
  resetDb: vi.fn(),
}));

vi.mock("../services/action-log-query.js", () => ({
  actionLogSince: vi.fn().mockReturnValue([]),
  getActionLogSummaryByKind: vi.fn().mockReturnValue([]),
}));

vi.mock("../services/vault-delta.js", () => ({
  scanVaultDelta: vi.fn().mockResolvedValue({ entries: [], scanned: 0, manifestUsed: false }),
}));

vi.mock("../services/morning-brief-recos.js", () => ({
  generateMorningBriefRecommendation: vi.fn().mockReturnValue({
    primaryAction: "none",
    recommendationText: "All clear",
  }),
  createMorningBriefSummary: vi.fn().mockReturnValue({
    totalActions: 0, blocked: 0, routed: 0, allowed: 0, offlineAgents: 0, highBudgetAgents: 0,
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): Config {
  return {
    companyId: "00000000-0000-4000-8000-000000000001",
    logLevel: "silent",
    sessionSecret: "test-secret",
    listenPort: 0,
    vaultDir: "",
    dataDir: "",
    legacyBridgeUrl: "http://127.0.0.1:3100",
    legacyBridgeApiKey: "test",
    legacyBridgeEnabled: false,
    jwtSecret: "test",
    googleClientId: "",
    googleClientSecret: "",
    redirectUrl: "",
    allowedOrigins: ["http://localhost:3000"],
    costMeterUrl: "",
    costMeterApiKey: "",
  };
}

const TENANT_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

function ownerPrincipal(): Principal {
  return {
    kind: "owner",
    id: "owner",
    scopes: new Set(["admin", "memory:read", "memory:write", "policy:check",
      "dispatch:write", "approvals:decide", "operator-memory:read"] as const),
    tenants: "*",
  };
}

function scopedPrincipal(tenants: string[]): Principal {
  return {
    kind: "agent",
    id: "agent-scoped",
    scopes: new Set(["admin"] as const),
    tenants,
  };
}

// ---------------------------------------------------------------------------
// Tests: GET /api/admin/activity-log
// ---------------------------------------------------------------------------

describe("GET /api/admin/activity-log — tenant-access guard", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.all.mockReturnValue([]);
    mockDb.$client = {
      prepare: vi.fn().mockReturnThis(),
      get: vi.fn().mockReturnValue({ count: 0 }),
      all: vi.fn().mockReturnValue([]),
    };
    app = createApp(makeConfig());
  });

  it("scoped principal + cross-tenant tenantId → 403 forbidden", async () => {
    activePrincipal = scopedPrincipal([TENANT_A]);
    const res = await request(app)
      .get("/api/admin/activity-log")
      .query({ tenantId: TENANT_B });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("owner principal + any tenantId → allowed (200)", async () => {
    activePrincipal = ownerPrincipal();
    mockDb.$client.all = vi.fn().mockReturnValue([]);
    const res = await request(app)
      .get("/api/admin/activity-log")
      .query({ tenantId: TENANT_B });

    expect(res.status).toBe(200);
  });

  it("scoped principal + own tenantId → allowed (200)", async () => {
    activePrincipal = scopedPrincipal([TENANT_A]);
    mockDb.$client.all = vi.fn().mockReturnValue([]);
    const res = await request(app)
      .get("/api/admin/activity-log")
      .query({ tenantId: TENANT_A });

    expect(res.status).toBe(200);
  });

  it("scoped principal + no tenantId → 403 tenant_required", async () => {
    activePrincipal = scopedPrincipal([TENANT_A]);
    const res = await request(app).get("/api/admin/activity-log");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("tenant_required");
  });

  it("owner principal + no tenantId → allowed (list all)", async () => {
    activePrincipal = ownerPrincipal();
    mockDb.$client.all = vi.fn().mockReturnValue([]);
    const res = await request(app).get("/api/admin/activity-log");

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/admin/autopilot
// ---------------------------------------------------------------------------

describe("GET /api/admin/autopilot — tenant-access guard", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.$client = {
      prepare: vi.fn().mockReturnThis(),
      get: vi.fn().mockReturnValue({ count: 0 }),
      all: vi.fn().mockReturnValue([]),
    };
    app = createApp(makeConfig());
  });

  it("scoped principal + cross-tenant tenantId → 403 forbidden", async () => {
    activePrincipal = scopedPrincipal([TENANT_A]);
    const res = await request(app)
      .get("/api/admin/autopilot")
      .query({ tenantId: TENANT_B });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("owner principal + any tenantId → allowed (200)", async () => {
    activePrincipal = ownerPrincipal();
    const res = await request(app)
      .get("/api/admin/autopilot")
      .query({ tenantId: TENANT_B });

    // Route itself may error on empty DB but auth passed (not 403)
    expect(res.status).not.toBe(403);
  });

  it("scoped principal + own tenantId → allowed (not 403)", async () => {
    activePrincipal = scopedPrincipal([TENANT_A]);
    const res = await request(app)
      .get("/api/admin/autopilot")
      .query({ tenantId: TENANT_A });

    expect(res.status).not.toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/admin/scope-violations  (list, no tenantId column in table)
// ---------------------------------------------------------------------------

describe("GET /api/admin/scope-violations — tenant-access guard", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.all.mockReturnValue([]);
    app = createApp(makeConfig());
  });

  it("scoped principal + no tenantId → 403 tenant_required", async () => {
    activePrincipal = scopedPrincipal([TENANT_A]);
    const res = await request(app).get("/api/admin/scope-violations");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("tenant_required");
  });

  it("owner principal + no tenantId → 200 (list all)", async () => {
    activePrincipal = ownerPrincipal();
    const res = await request(app).get("/api/admin/scope-violations");

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: principal.ts scope filter (defence-in-depth)
// ---------------------------------------------------------------------------

describe("principal.ts scope filter", () => {
  it("filters unrecognised scopes out of agent key rows", async () => {
    const { resolvePrincipal } = await import("../auth/principal.js");
    const { ALL_SCOPES } = await import("../auth/principal.js");
    const { createHash } = await import("node:crypto");

    const token = "test-scope-filter-token";
    const hash = createHash("sha256").update(token).digest("hex");

    // Build a minimal in-memory sqlite stub
    const mockSqlite = {
      prepare: (sql: string) => ({
        get: (_h: string) => {
          if (sql.includes("agent_api_keys")) {
            return {
              id: "key-1",
              agent_id: "agent-001",
              scopes: JSON.stringify(["admin", "INVALID_SCOPE", "memory:read", "not_a_scope"]),
              tenant_allowlist: JSON.stringify([TENANT_A]),
              revoked_at: null,
            };
          }
          return undefined;
        },
        run: () => {},
      }),
    };

    const config = {
      legacyBridgeApiKey: "different-token",
    } as Parameters<typeof resolvePrincipal>[1];

    const req = {
      header: (name: string) => name === "authorization" ? `Bearer ${token}` : undefined,
      socket: { remoteAddress: "10.0.0.1" },
    } as Parameters<typeof resolvePrincipal>[0];

    const principal = resolvePrincipal(req, config, mockSqlite as Parameters<typeof resolvePrincipal>[2]);
    expect(principal).not.toBeNull();
    expect(principal!.kind).toBe("agent");

    // Only valid scopes survive the filter
    for (const scope of principal!.scopes) {
      expect(ALL_SCOPES.has(scope)).toBe(true);
    }
    expect(principal!.scopes.has("admin")).toBe(true);
    expect(principal!.scopes.has("memory:read")).toBe(true);
    // Invalid ones stripped
    expect(principal!.scopes.size).toBe(2);
  });
});
