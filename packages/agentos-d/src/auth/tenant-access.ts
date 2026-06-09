/**
 * Tenant access helpers — extract tenantId from a request and enforce
 * that the calling principal is allowed to act on that tenant.
 */

import type { Request } from "express";
import type { Principal } from "./principal.js";

// ---------------------------------------------------------------------------
// TenantAccessError
// ---------------------------------------------------------------------------

export class TenantAccessError extends Error {
  readonly statusCode = 403;

  constructor(tenantId: string) {
    super(`Principal is not authorized to access tenant: ${tenantId}`);
    this.name = "TenantAccessError";
  }
}

// ---------------------------------------------------------------------------
// resolveTenantId
// ---------------------------------------------------------------------------

/**
 * Extract tenantId from the request in the order: body → query → params.
 * Both camelCase (tenantId) and snake_case (tenant_id) are checked so all
 * route conventions are covered (compliance route uses snake_case).
 */
export function resolveTenantId(req: Request): string | undefined {
  const body = req.body as Record<string, unknown>;
  const query = req.query as Record<string, string>;
  const params = req.params as Record<string, string>;

  const fromBody =
    typeof body["tenantId"] === "string"
      ? body["tenantId"]
      : typeof body["tenant_id"] === "string"
        ? body["tenant_id"]
        : undefined;
  if (fromBody !== undefined) return fromBody;

  const fromQuery =
    typeof query["tenantId"] === "string"
      ? query["tenantId"]
      : typeof query["tenant_id"] === "string"
        ? query["tenant_id"]
        : undefined;
  if (fromQuery !== undefined) return fromQuery;

  const fromParams =
    typeof params["tenantId"] === "string"
      ? params["tenantId"]
      : typeof params["tenant_id"] === "string"
        ? params["tenant_id"]
        : undefined;
  return fromParams;
}

// ---------------------------------------------------------------------------
// assertTenantAllowed
// ---------------------------------------------------------------------------

/**
 * Throw TenantAccessError if the principal is not allowed to act on tenantId.
 * Owner principals (tenants="*") are always allowed.
 * Agent principals with wildcard tenants="*" are always allowed.
 * Otherwise the tenantId must appear in principal.tenants.
 */
export function assertTenantAllowed(principal: Principal, tenantId: string): void {
  if (principal.tenants === "*") return;
  if (principal.tenants.includes(tenantId)) return;
  throw new TenantAccessError(tenantId);
}
