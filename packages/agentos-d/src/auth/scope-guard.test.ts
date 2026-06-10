import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requireScope, hasScope } from "./scope-guard.js";
import type { Principal, Scope } from "./principal.js";

function makeRes(): { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function principalWith(scopes: Scope[], kind: "owner" | "agent" = "agent"): Principal {
  return {
    kind,
    id: kind === "owner" ? "owner" : "agent-001",
    scopes: new Set(scopes),
    tenants: kind === "owner" ? "*" : ["tenant-a"],
  };
}

function makeReq(principal?: Principal): Request {
  return { principal } as unknown as Request;
}

// ---------------------------------------------------------------------------
// hasScope
// ---------------------------------------------------------------------------

describe("hasScope", () => {
  it("returns true when principal has the scope", () => {
    expect(hasScope(principalWith(["memory:read"]), "memory:read")).toBe(true);
  });

  it("returns false when principal lacks the scope", () => {
    expect(hasScope(principalWith(["memory:read"]), "memory:write")).toBe(false);
  });

  it("owner with all-scopes set has any scope", () => {
    const owner = principalWith(
      [
        "memory:read",
        "memory:write",
        "policy:check",
        "dispatch:write",
        "approvals:decide",
        "operator-memory:read",
        "admin",
      ],
      "owner",
    );
    expect(hasScope(owner, "admin")).toBe(true);
    expect(hasScope(owner, "operator-memory:read")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// requireScope
// ---------------------------------------------------------------------------

describe("requireScope", () => {
  const next = vi.fn() as unknown as NextFunction;

  it("calls next() when principal has the required scope", () => {
    vi.clearAllMocks();
    const guard = requireScope("memory:read");
    const req = makeReq(principalWith(["memory:read"]));
    const res = makeRes();
    guard(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 403 when principal lacks the scope", () => {
    vi.clearAllMocks();
    const guard = requireScope("memory:write");
    const req = makeReq(principalWith(["memory:read"]));
    const res = makeRes();
    guard(req, res as unknown as Response, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "forbidden", required_scope: "memory:write" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when no principal is attached", () => {
    vi.clearAllMocks();
    const guard = requireScope("memory:read");
    const req = makeReq(undefined);
    const res = makeRes();
    guard(req, res as unknown as Response, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("owner principal passes any scope guard", () => {
    vi.clearAllMocks();
    const guard = requireScope("admin");
    const owner = principalWith(
      [
        "memory:read",
        "memory:write",
        "policy:check",
        "dispatch:write",
        "approvals:decide",
        "operator-memory:read",
        "admin",
      ],
      "owner",
    );
    const req = makeReq(owner);
    const res = makeRes();
    guard(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalled();
  });
});
