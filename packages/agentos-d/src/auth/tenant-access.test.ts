import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { resolveTenantId, assertTenantAllowed, TenantAccessError } from "./tenant-access.js";
import type { Principal } from "./principal.js";

function makeReq(opts: {
  body?: Record<string, unknown>;
  query?: Record<string, string>;
  params?: Record<string, string>;
}): Request {
  return {
    body: opts.body ?? {},
    query: opts.query ?? {},
    params: opts.params ?? {},
  } as unknown as Request;
}

function ownerPrincipal(): Principal {
  return {
    kind: "owner",
    id: "owner",
    scopes: new Set(["memory:read", "memory:write", "admin"] as const),
    tenants: "*",
  };
}

function agentPrincipal(tenants: string[]): Principal {
  return {
    kind: "agent",
    id: "agent-001",
    scopes: new Set(["memory:read"] as const),
    tenants,
  };
}

// ---------------------------------------------------------------------------
// resolveTenantId
// ---------------------------------------------------------------------------

describe("resolveTenantId", () => {
  it("reads tenantId from body (camelCase)", () => {
    const req = makeReq({ body: { tenantId: "t-body" } });
    expect(resolveTenantId(req)).toBe("t-body");
  });

  it("reads tenant_id from body (snake_case)", () => {
    const req = makeReq({ body: { tenant_id: "t-snake" } });
    expect(resolveTenantId(req)).toBe("t-snake");
  });

  it("reads tenantId from query", () => {
    const req = makeReq({ query: { tenantId: "t-query" } });
    expect(resolveTenantId(req)).toBe("t-query");
  });

  it("reads tenant_id from query (snake_case)", () => {
    const req = makeReq({ query: { tenant_id: "t-query-snake" } });
    expect(resolveTenantId(req)).toBe("t-query-snake");
  });

  it("reads tenantId from params", () => {
    const req = makeReq({ params: { tenantId: "t-param" } });
    expect(resolveTenantId(req)).toBe("t-param");
  });

  it("body takes precedence over query", () => {
    const req = makeReq({ body: { tenantId: "from-body" }, query: { tenantId: "from-query" } });
    expect(resolveTenantId(req)).toBe("from-body");
  });

  it("query takes precedence over params", () => {
    const req = makeReq({ query: { tenantId: "from-query" }, params: { tenantId: "from-params" } });
    expect(resolveTenantId(req)).toBe("from-query");
  });

  it("returns undefined when tenantId is absent everywhere", () => {
    const req = makeReq({});
    expect(resolveTenantId(req)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// assertTenantAllowed
// ---------------------------------------------------------------------------

describe("assertTenantAllowed", () => {
  it("owner with tenants='*' is always allowed", () => {
    expect(() => assertTenantAllowed(ownerPrincipal(), "any-tenant")).not.toThrow();
  });

  it("agent scoped to tenant-a is allowed for tenant-a", () => {
    expect(() => assertTenantAllowed(agentPrincipal(["tenant-a"]), "tenant-a")).not.toThrow();
  });

  it("agent scoped to tenant-a is denied for tenant-b", () => {
    expect(() => assertTenantAllowed(agentPrincipal(["tenant-a"]), "tenant-b")).toThrow(
      TenantAccessError,
    );
  });

  it("agent with empty tenant list is denied for any tenant", () => {
    expect(() => assertTenantAllowed(agentPrincipal([]), "tenant-a")).toThrow(TenantAccessError);
  });

  it("agent with wildcard tenants='*' is always allowed", () => {
    const wildcardAgent: Principal = {
      kind: "agent",
      id: "agent-002",
      scopes: new Set(["memory:read"] as const),
      tenants: "*",
    };
    expect(() => assertTenantAllowed(wildcardAgent, "any-tenant")).not.toThrow();
  });

  it("thrown error message includes the tenant id", () => {
    try {
      assertTenantAllowed(agentPrincipal(["tenant-a"]), "tenant-b");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TenantAccessError);
      expect((err as TenantAccessError).message).toContain("tenant-b");
    }
  });
});
