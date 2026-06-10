import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { createRequireAuthMiddleware, resolveAdminToken, isValidToken, isLoopback } from "./require-auth.js";
import type { Config } from "../config.js";

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
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() } as unknown as Config["logger"],
    ...overrides,
  };
}

function makeReq(overrides: { remoteAddress?: string; authHeader?: string } = {}): Request {
  return {
    socket: { remoteAddress: overrides.remoteAddress ?? "127.0.0.1" },
    header: (name: string) => {
      if (name.toLowerCase() === "authorization") return overrides.authHeader;
      return undefined;
    },
  } as unknown as Request;
}

function makeRes(): { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

// ---------------------------------------------------------------------------
// resolveAdminToken
// ---------------------------------------------------------------------------

describe("resolveAdminToken", () => {
  beforeEach(() => {
    delete process.env.AGENTOS_ADMIN_TOKEN;
    delete process.env.AGENTOS_API_KEY;
  });

  it("prefers AGENTOS_ADMIN_TOKEN", () => {
    process.env.AGENTOS_ADMIN_TOKEN = "admin-tok";
    process.env.AGENTOS_API_KEY = "api-key";
    expect(resolveAdminToken(makeConfig())).toBe("admin-tok");
    delete process.env.AGENTOS_ADMIN_TOKEN;
    delete process.env.AGENTOS_API_KEY;
  });

  it("falls back to AGENTOS_API_KEY", () => {
    process.env.AGENTOS_API_KEY = "api-key";
    expect(resolveAdminToken(makeConfig())).toBe("api-key");
    delete process.env.AGENTOS_API_KEY;
  });

  it("falls back to config.legacyBridgeApiKey", () => {
    expect(resolveAdminToken(makeConfig({ legacyBridgeApiKey: "bridge-key" }))).toBe("bridge-key");
  });
});

// ---------------------------------------------------------------------------
// isValidToken
// ---------------------------------------------------------------------------

describe("isValidToken", () => {
  it("returns true for matching tokens", () => {
    expect(isValidToken("abc123", "abc123")).toBe(true);
  });

  it("returns false for mismatched tokens of equal length", () => {
    expect(isValidToken("abc123", "xyz789")).toBe(false);
  });

  it("returns false when lengths differ", () => {
    expect(isValidToken("short", "a-much-longer-token")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isLoopback
// ---------------------------------------------------------------------------

describe("isLoopback", () => {
  it("admits 127.0.0.1", () => expect(isLoopback(makeReq({ remoteAddress: "127.0.0.1" }))).toBe(true));
  it("admits ::1", () => expect(isLoopback(makeReq({ remoteAddress: "::1" }))).toBe(true));
  it("admits ::ffff:127.0.0.1", () => expect(isLoopback(makeReq({ remoteAddress: "::ffff:127.0.0.1" }))).toBe(true));
  it("rejects external IP", () => expect(isLoopback(makeReq({ remoteAddress: "192.168.1.10" }))).toBe(false));
  it("rejects empty string (in-process supertest socket)", () => expect(isLoopback(makeReq({ remoteAddress: "" }))).toBe(false));
});

// ---------------------------------------------------------------------------
// createRequireAuthMiddleware
// ---------------------------------------------------------------------------

describe("createRequireAuthMiddleware", () => {
  const config = makeConfig({ legacyBridgeApiKey: "test-token" });
  const middleware = createRequireAuthMiddleware(config);
  const next = vi.fn() as unknown as NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENTOS_ADMIN_TOKEN;
    delete process.env.AGENTOS_API_KEY;
  });

  it("returns 401 for an untrusted remote IP with no token", () => {
    const req = makeReq({ remoteAddress: "192.168.1.50" });
    const res = makeRes();
    middleware(req, res as unknown as Response, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "unauthorized" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 for an untrusted remote IP with a wrong token", () => {
    const req = makeReq({ remoteAddress: "10.0.0.5", authHeader: "Bearer wrong-token" });
    const res = makeRes();
    middleware(req, res as unknown as Response, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("admits an untrusted remote IP when it carries a valid token (escalation path)", () => {
    const req = makeReq({ remoteAddress: "10.0.0.5", authHeader: "Bearer test-token" });
    const res = makeRes();
    middleware(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("admits a loopback request with no token (local trust)", () => {
    const req = makeReq({ remoteAddress: "127.0.0.1" });
    const res = makeRes();
    middleware(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("admits a Docker bridge request with no token (sibling container)", () => {
    const req = makeReq({ remoteAddress: "172.18.0.4" });
    const res = makeRes();
    middleware(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects 172.32.x (outside the Docker bridge range) with no token", () => {
    const req = makeReq({ remoteAddress: "172.32.0.4" });
    const res = makeRes();
    middleware(req, res as unknown as Response, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("requires a valid token even from loopback when AGENTOS_REQUIRE_TOKEN=true", () => {
    process.env.AGENTOS_REQUIRE_TOKEN = "true";
    const strict = createRequireAuthMiddleware(config);
    const denied = makeReq({ remoteAddress: "127.0.0.1" });
    const deniedRes = makeRes();
    strict(denied, deniedRes as unknown as Response, next);
    expect(deniedRes.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();

    const allowed = makeReq({ remoteAddress: "127.0.0.1", authHeader: "Bearer test-token" });
    const allowedRes = makeRes();
    strict(allowed, allowedRes as unknown as Response, next);
    expect(next).toHaveBeenCalled();
    delete process.env.AGENTOS_REQUIRE_TOKEN;
  });

  it("calls next() when loopback + correct token", () => {
    const req = makeReq({ remoteAddress: "127.0.0.1", authHeader: "Bearer test-token" });
    const res = makeRes();
    middleware(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("calls next() for ::1 loopback + correct token", () => {
    const req = makeReq({ remoteAddress: "::1", authHeader: "Bearer test-token" });
    const res = makeRes();
    middleware(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it("respects AGENTOS_API_KEY env override at call time", () => {
    process.env.AGENTOS_API_KEY = "env-key";
    const req = makeReq({ remoteAddress: "127.0.0.1", authHeader: "Bearer env-key" });
    const res = makeRes();
    middleware(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalled();
    delete process.env.AGENTOS_API_KEY;
  });
});
