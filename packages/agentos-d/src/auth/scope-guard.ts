/**
 * Scope guard — Express middleware and boolean helper for scope-based access control.
 */

import type { RequestHandler, Request, Response, NextFunction } from "express";
import type { Scope } from "./principal.js";
import type { Principal } from "./principal.js";

// ---------------------------------------------------------------------------
// hasScope
// ---------------------------------------------------------------------------

export function hasScope(principal: Principal, scope: Scope): boolean {
  return principal.scopes.has(scope);
}

// ---------------------------------------------------------------------------
// requireScope
// ---------------------------------------------------------------------------

/**
 * Express middleware that enforces a required scope on req.principal.
 * - No principal attached → 401 (auth middleware did not run or failed).
 * - Principal lacks scope → 403 with the required scope in the response body.
 * - Principal has scope → next().
 */
export function requireScope(scope: Scope): RequestHandler {
  return function scopeGuard(req: Request, res: Response, next: NextFunction): void {
    const principal = req.principal;
    if (principal === undefined) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!hasScope(principal, scope)) {
      res.status(403).json({ error: "forbidden", required_scope: scope });
      return;
    }
    next();
  };
}
