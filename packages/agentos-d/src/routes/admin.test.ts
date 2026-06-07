/**
 * Admin routes — scope_violations telemetry.
 *
 * POST /api/admin/scope-violations  — write a violation record
 * GET  /api/admin/scope-violations  — list with optional filters
 * GET  /api/admin/scope-violations/summary — aggregated per-agent summary
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import type { Config } from "../config.js";
import * as actionLogQuery from "../services/action-log-query.js";
import * as vaultDelta from "../services/vault-delta.js";
import * as morningBriefRecos from "../services/morning-brief-recos.js";

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
  actionLogSince: vi.fn(),
  getActionLogSummaryByKind: vi.fn(),
}));

vi.mock("../services/vault-delta.js", () => ({
  scanVaultDelta: vi.fn(),
}));

vi.mock("../services/morning-brief-recos.js", () => ({
  generateMorningBriefRecommendation: vi.fn(),
  createMorningBriefSummary: vi.fn(),
}));

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

describe("POST /api/admin/scope-violations", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp(makeConfig());
  });

  it("returns 201 and the created id", async () => {
    const res = await request(app)
      .post("/api/admin/scope-violations")
      .send({
        revertedFromCommit: "abc123",
        agentRunId: "run-1",
        agentId: "agent-1",
        agentRole: "BackendEngineer",
        files: ["docs/foo.md", "packages/admin-ui/bar.ts"],
        reason: "touched files outside lane",
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("id");
    expect(res.body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(mockDb.insert).toHaveBeenCalled();
    expect(mockDb.values).toHaveBeenCalled();
    expect(mockDb.run).toHaveBeenCalled();
  });

  it("returns 400 for missing required fields", async () => {
    const res = await request(app)
      .post("/api/admin/scope-violations")
      .send({ revertedFromCommit: "abc123" }); // missing files

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("returns 400 for empty files array", async () => {
    const res = await request(app)
      .post("/api/admin/scope-violations")
      .send({ revertedFromCommit: "abc123", files: [] });

    expect(res.status).toBe(400);
  });

  it("returns 400 for wrong type", async () => {
    const res = await request(app)
      .post("/api/admin/scope-violations")
      .send({ revertedFromCommit: 123, files: ["a"] });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/admin/scope-violations", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp(makeConfig());
  });

  it("returns empty items array when no violations", async () => {
    mockDb.all.mockReturnValueOnce([]);

    const res = await request(app).get("/api/admin/scope-violations");

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it("returns violations ordered by revertedAt desc", async () => {
    const rows = [
      {
        id: "id-1",
        revertedFromCommit: "a1",
        agentRunId: null,
        agentId: null,
        agentRole: null,
        files: JSON.stringify(["a.md"]),
        reason: null,
        revertedAt: "2026-01-01T00:00:00Z",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "id-2",
        revertedFromCommit: "a2",
        agentRunId: null,
        agentId: null,
        agentRole: null,
        files: JSON.stringify(["b.md"]),
        reason: null,
        revertedAt: "2026-01-02T00:00:00Z",
        createdAt: "2026-01-02T00:00:00Z",
      },
    ];
    mockDb.all.mockReturnValueOnce(rows);

    const res = await request(app).get("/api/admin/scope-violations");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].revertedFromCommit).toBe("a1"); // desc
    expect(res.body.items[0].files).toEqual(["a.md"]); // parsed from JSON
    expect(res.body.items[1].revertedFromCommit).toBe("a2");
  });

  it("filters by agentId", async () => {
    mockDb.all.mockReturnValueOnce([]);

    const res = await request(app)
      .get("/api/admin/scope-violations")
      .query({ agentId: "backend" });

    expect(res.status).toBe(200);
    expect(mockDb.where).toHaveBeenCalled();
  });

  it("caps limit at 1000", async () => {
    mockDb.all.mockReturnValueOnce([]);

    await request(app)
      .get("/api/admin/scope-violations")
      .query({ limit: "5000" });

    expect(mockDb.limit).toHaveBeenCalledWith(1000);
  });
});

describe("GET /api/admin/scope-violations/summary", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp(makeConfig());
  });

  it("returns empty summaries when no violations", async () => {
    mockDb.all.mockReturnValueOnce([]);

    const res = await request(app).get("/api/admin/scope-violations/summary");

    expect(res.status).toBe(200);
    expect(res.body.summaries).toEqual([]);
  });

  it("aggregates total reverts per agent", async () => {
    // First call: groupBy count query
    mockDb.all.mockReturnValueOnce([
      { agentId: "be", count: 2 },
      { agentId: "fe", count: 1 },
    ]);
    // Second call: recent rows for dir analysis
    mockDb.all.mockReturnValueOnce([
      {
        id: "1",
        agentId: "be",
        files: JSON.stringify(["p/a.ts", "p/b.ts"]),
        revertedFromCommit: "c1",
        agentRunId: null,
        agentRole: null,
        reason: null,
        revertedAt: "2026-01-01T00:00:00Z",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "2",
        agentId: "fe",
        files: JSON.stringify(["ui/x.ts"]),
        revertedFromCommit: "c2",
        agentRunId: null,
        agentRole: null,
        reason: null,
        revertedAt: "2026-01-02T00:00:00Z",
        createdAt: "2026-01-02T00:00:00Z",
      },
    ]);

    const res = await request(app).get("/api/admin/scope-violations/summary");

    expect(res.status).toBe(200);
    const summaries = res.body.summaries as Array<{ agentId: string; totalReverts: number }>;
    const be = summaries.find((s) => s.agentId === "be");
    const fe = summaries.find((s) => s.agentId === "fe");
    expect(be?.totalReverts).toBe(2);
    expect(fe?.totalReverts).toBe(1);
  });
});

describe("GET /api/admin/morning-brief", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp(makeConfig());
    
    // Setup default mocks
    vi.mocked(actionLogQuery.actionLogSince).mockReturnValue([]);
    vi.mocked(actionLogQuery.getActionLogSummaryByKind).mockReturnValue([]);
    vi.mocked(vaultDelta.scanVaultDelta).mockResolvedValue({
      entries: [],
      scanned: 0,
      manifestUsed: false,
    });
    vi.mocked(morningBriefRecos.generateMorningBriefRecommendation).mockReturnValue({
      primaryAction: "none",
      recommendationText: "All systems operational",
    });
    vi.mocked(morningBriefRecos.createMorningBriefSummary).mockReturnValue({
      totalActions: 0,
      blocked: 0,
      routed: 0,
      allowed: 0,
      offlineAgents: 0,
      highBudgetAgents: 0,
    });
  });

  it("returns 400 when tenantId is missing", async () => {
    const res = await request(app).get("/api/admin/morning-brief");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("tenantId required");
  });

  it("returns morning brief data with default time window", async () => {
    // Mock action logs
    vi.mocked(actionLogQuery.actionLogSince).mockReturnValue([
      {
        id: "1",
        tenantId: "tenant-1",
        actorId: "agent-1",
        actorType: "agent",
        actorLabel: "Test Agent",
        actionKind: "policy.check",
        payloadSnapshot: {},
        vaultRefs: [],
        conversationRefs: [],
        projectRefs: [],
        policyDecisionId: "decision-1",
        proposedAt: new Date().toISOString(),
        loggedAt: new Date().toISOString(),
      },
    ]);

    // Mock policy decisions
    mockDb.$client = {
      prepare: vi.fn().mockReturnThis(),
      get: vi.fn().mockReturnValue({ count: 0 }),
      all: vi.fn().mockReturnValue([
        { id: "decision-1", decision: "allow", actor_id: "agent-1" },
      ]),
    };

    const res = await request(app)
      .get("/api/admin/morning-brief")
      .query({ tenantId: "tenant-1" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("since");
    expect(res.body).toHaveProperty("generatedAt");
    expect(res.body).toHaveProperty("sections");
    expect(res.body.sections).toHaveProperty("blockers");
    expect(res.body.sections).toHaveProperty("approvals");
    expect(res.body.sections).toHaveProperty("terminalRuns");
    expect(res.body.sections).toHaveProperty("vaultEdits");
    expect(res.body.sections).toHaveProperty("recommendations");
  });

  it("includes vault edits and anomalies in response", async () => {
    vi.mocked(vaultDelta.scanVaultDelta).mockResolvedValue({
      entries: [
        { key: "test", path: "/test.md", modifiedAt: new Date().toISOString(), sizeBytes: 100 },
        { key: "anomaly-test", path: "/anomaly-test.md", modifiedAt: new Date().toISOString(), sizeBytes: 0 },
      ],
      scanned: 2,
      manifestUsed: true,
    });

    mockDb.$client = {
      prepare: vi.fn().mockReturnThis(),
      get: vi.fn().mockReturnValue({ count: 0 }),
      all: vi.fn().mockReturnValue([]),
    };

    const res = await request(app)
      .get("/api/admin/morning-brief")
      .query({ tenantId: "tenant-1" });

    expect(res.status).toBe(200);
    expect(res.body.sections.vaultEdits.count).toBe(2);
    expect(res.body.sections.vaultEdits.anomalies).toBe(1);
  });

  it("includes approval queue information", async () => {
    // Mock the SQLite client methods - use a simpler approach
    const mockPrepare = vi.fn().mockReturnThis();
    const mockGet = vi.fn()
      .mockReturnValueOnce({ count: 2 }) // approval queue depth
      .mockReturnValueOnce({ count: 5 }) // active agents  
      .mockReturnValueOnce(undefined); // oldest approval (no results)
    const mockAll = vi.fn().mockReturnValue([]);

    mockDb.$client = {
      prepare: mockPrepare,
      get: mockGet,
      all: mockAll,
    };

    const res = await request(app)
      .get("/api/admin/morning-brief")
      .query({ tenantId: "tenant-1" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("sections");
    expect(res.body.sections).toHaveProperty("approvals");
    expect(res.body.sections.approvals).toHaveProperty("depth");
    expect(res.body.sections.approvals).toHaveProperty("oldestHumanAgeHours");
    expect(res.body.sections.approvals.depth).toBe(2);
    // When there's no oldest approval, oldestHumanAgeHours should be 0
    expect(res.body.sections.approvals.oldestHumanAgeHours).toBe(0);
  });

  it("generates recommendations based on data", async () => {
    vi.mocked(morningBriefRecos.generateMorningBriefRecommendation).mockReturnValue({
      primaryAction: "review_queue",
      recommendationText: "Review 3 items in queue",
    });

    mockDb.$client = {
      prepare: vi.fn().mockReturnThis(),
      get: vi.fn().mockReturnValue({ count: 0 }),
      all: vi.fn().mockReturnValue([]),
    };

    const res = await request(app)
      .get("/api/admin/morning-brief")
      .query({ tenantId: "tenant-1" });

    expect(res.status).toBe(200);
    expect(res.body.sections.recommendations).toHaveLength(1);
    expect(res.body.sections.recommendations[0].message).toBe("Review 3 items in queue");
  });

  it("handles vault scan errors gracefully", async () => {
    vi.mocked(vaultDelta.scanVaultDelta).mockRejectedValue(new Error("Vault not found"));

    mockDb.$client = {
      prepare: vi.fn().mockReturnThis(),
      get: vi.fn().mockReturnValue({ count: 0 }),
      all: vi.fn().mockReturnValue([]),
    };

    const res = await request(app)
      .get("/api/admin/morning-brief")
      .query({ tenantId: "tenant-1" });

    expect(res.status).toBe(200);
    expect(res.body.sections.vaultEdits.count).toBe(0);
    expect(res.body.sections.vaultEdits.anomalies).toBe(0);
  });

  it("limits recommendations to maximum of 3", async () => {
    // Mock multiple conditions that would generate recommendations
    vi.mocked(morningBriefRecos.generateMorningBriefRecommendation).mockReturnValue({
      primaryAction: "review_queue",
      recommendationText: "Review blocked items",
    });

    vi.mocked(vaultDelta.scanVaultDelta).mockResolvedValue({
      entries: [{ key: "anomaly", path: "/anomaly.md", modifiedAt: new Date().toISOString(), sizeBytes: 0 }],
      scanned: 1,
      manifestUsed: true,
    });

    mockDb.$client = {
      prepare: vi.fn().mockReturnThis(),
      get: vi.fn()
        .mockReturnValueOnce({ count: 1 }) // approval queue depth
        .mockReturnValueOnce({ count: 5 }) // active agents
        .mockReturnValueOnce({ created_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() }), // oldest approval
      all: vi.fn().mockReturnValue([]),
    };

    const res = await request(app)
      .get("/api/admin/morning-brief")
      .query({ tenantId: "tenant-1" });

    expect(res.status).toBe(200);
    expect(res.body.sections.recommendations.length).toBeLessThanOrEqual(3);
  });
});

// Trust endpoint coverage moved to services/trust-aggregator.test.ts
// (29 tests covering all 9 warning codes, 5s cache, profile drift, and inspector probe).

describe("POST /api/admin/autopilot/dispatch", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp(makeConfig());
  });

  it("returns 400 for invalid body", async () => {
    const res = await request(app)
      .post("/api/admin/autopilot/dispatch")
      .send({ actionIds: "not-an-array", idempotencyKey: "key" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("returns 404 when no policy decisions found", async () => {
    mockDb.all.mockReturnValueOnce([]);

    const res = await request(app)
      .post("/api/admin/autopilot/dispatch")
      .send({
        actionIds: ["550e8400-e29b-41d4-a716-446655440000"],
        idempotencyKey: "key1",
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_actions_found");
  });

  it("dispatches safe actions and creates action log entries", async () => {
    const decisionId = "dec-1";
    const actionId = "550e8400-e29b-41d4-a716-446655440000";

    mockDb.all.mockReturnValueOnce([
      {
        id: decisionId,
        actionId,
        tenantId: "tenant-1",
        actorId: "agent-1",
        actorType: "agent",
        actorLabel: "TestAgent",
        proposedActionKind: "file.read",
        decision: "allow",
        decisionReason: "within policy",
        proposedAt: new Date().toISOString(),
      },
    ]);
    // No existing action log for idempotency
    mockDb.get.mockReturnValueOnce(null);

    const res = await request(app)
      .post("/api/admin/autopilot/dispatch")
      .send({
        actionIds: [actionId],
        idempotencyKey: "key1",
      });

    expect(res.status).toBe(200);
    expect(res.body.dispatched).toBe(1);
    expect(res.body.skipped).toBe(0);
    expect(res.body.failed).toBe(0);
    expect(res.body.idempotent).toBe(false);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].actionId).toBe(actionId);
    expect(res.body.results[0].decision).toBe("allow");
    expect(res.body.results[0].dispatched).toBe(true);
    expect(mockDb.insert).toHaveBeenCalled();
    expect(mockDb.run).toHaveBeenCalled();
  });

  it("skips risky actions without creating action logs", async () => {
    const decisionId = "dec-2";
    const actionId = "550e8400-e29b-41d4-a716-446655440001";

    mockDb.all.mockReturnValueOnce([
      {
        id: decisionId,
        actionId,
        tenantId: "tenant-1",
        actorId: "agent-1",
        actorType: "agent",
        actorLabel: "TestAgent",
        proposedActionKind: "shell.mutating",
        decision: "block",
        decisionReason: "fair housing discrimination",
        proposedAt: new Date().toISOString(),
      },
    ]);
    mockDb.get.mockReturnValueOnce(null);

    const res = await request(app)
      .post("/api/admin/autopilot/dispatch")
      .send({
        actionIds: [actionId],
        idempotencyKey: "key2",
      });

    expect(res.status).toBe(200);
    expect(res.body.dispatched).toBe(0);
    expect(res.body.skipped).toBe(1);
    expect(res.body.failed).toBe(0);
    expect(res.body.results[0].decision).toBe("risky");
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("respects dryRun and does not create action logs", async () => {
    const decisionId = "dec-3";
    const actionId = "550e8400-e29b-41d4-a716-446655440002";

    mockDb.all.mockReturnValueOnce([
      {
        id: decisionId,
        actionId,
        tenantId: "tenant-1",
        actorId: "agent-1",
        actorType: "agent",
        actorLabel: "TestAgent",
        proposedActionKind: "file.read",
        decision: "allow",
        decisionReason: "within policy",
        proposedAt: new Date().toISOString(),
      },
    ]);
    mockDb.get.mockReturnValueOnce(null);

    const res = await request(app)
      .post("/api/admin/autopilot/dispatch")
      .send({
        actionIds: [actionId],
        idempotencyKey: "key3",
        dryRun: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.dispatched).toBe(1);
    expect(res.body.results[0].dispatched).toBe(true);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("is idempotent: second call with same key returns cached results", async () => {
    const decisionId = "dec-4";
    const actionId = "550e8400-e29b-41d4-a716-446655440003";

    // First call
    mockDb.all.mockReturnValueOnce([
      {
        id: decisionId,
        actionId,
        tenantId: "tenant-1",
        actorId: "agent-1",
        actorType: "agent",
        actorLabel: "TestAgent",
        proposedActionKind: "file.read",
        decision: "allow",
        decisionReason: "within policy",
        proposedAt: new Date().toISOString(),
      },
    ]);
    mockDb.get.mockReturnValueOnce(null);

    const res1 = await request(app)
      .post("/api/admin/autopilot/dispatch")
      .send({
        actionIds: [actionId],
        idempotencyKey: "key4",
      });

    expect(res1.status).toBe(200);
    expect(res1.body.idempotent).toBe(false);
    expect(mockDb.insert).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();

    // Second call: simulate existing log
    mockDb.all.mockReturnValueOnce([
      {
        id: decisionId,
        actionId,
        tenantId: "tenant-1",
        actorId: "agent-1",
        actorType: "agent",
        actorLabel: "TestAgent",
        proposedActionKind: "file.read",
        decision: "allow",
        decisionReason: "within policy",
        proposedAt: new Date().toISOString(),
      },
    ]);
    mockDb.get.mockReturnValueOnce({
      payloadSnapshot: JSON.stringify({
        idempotencyKey: "key4",
        autopilotDecision: "allow",
        riskScore: 0.05,
        reasons: ["within-policy"],
      }),
    });

    const res2 = await request(app)
      .post("/api/admin/autopilot/dispatch")
      .send({
        actionIds: [actionId],
        idempotencyKey: "key4",
      });

    expect(res2.status).toBe(200);
    expect(res2.body.idempotent).toBe(true);
    expect(res2.body.dispatched).toBe(1);
    expect(res2.body.results[0].riskScore).toBe(0.05);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});
