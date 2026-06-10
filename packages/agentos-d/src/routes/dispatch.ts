/**
 * Dispatch routes — substrate-initiated tasks for target agents.
 *
 * The complement to policy.check: when a workflow (n8n, REST caller, MCP
 * tool) wants the substrate to hand a task to an agent, it POSTs here.
 * The route writes a tenant-scoped `dispatch_queue` row at status='queued'
 * and returns the task id. v1 has no in-process worker draining the queue;
 * adapters poll, or webhook fan-out can be wired later.
 *
 * POST /api/dispatch              { tenantId, taskKind, targetAgentId, input } → { taskId, status }
 * GET  /api/dispatch?tenantId=&status= …  paginated list
 * GET  /api/dispatch/:id          single row with parsed input
 * PATCH /api/dispatch/:id         { status, error? } — adapter side transitions
 */

import { Router, type Response } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { eq, and, desc, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { dispatchQueue, type NewDispatchQueueRow } from "../db/schema.js";
import { isPaused } from "../pause-service.js";
import type { Config } from "../config.js";
import { assertTenantAllowed, resolveTenantId, TenantAccessError } from "../auth/tenant-access.js";
import { requireScope } from "../auth/scope-guard.js";

const ACTION_KIND_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
const DISPATCH_STATUSES = ["queued", "waiting", "dispatched", "completed", "failed", "dead_letter", "cancelled"] as const;
type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

function denyTenant(res: Response, err: unknown): boolean {
  if (err instanceof TenantAccessError) {
    res.status(403).json({ error: "forbidden", message: err.message });
    return true;
  }
  return false;
}

export function createDispatchRouter(_config: Config): Router {
  const router = Router();

  const DispatchRequestSchema = z.object({
    tenantId: z.string().uuid(),
    taskKind: z
      .string()
      .min(1)
      .regex(ACTION_KIND_RE, {
        message: "taskKind must be lowercase dot-separated (e.g. outbound.sms)",
      }),
    targetAgentId: z.string().min(1),
    input: z.record(z.unknown()).default({}),
    policyDecisionId: z.string().uuid().optional(),
    maxRetries: z.number().int().min(0).max(20).optional(),
    contract: z.record(z.unknown()).optional(),
  });

  const TransitionSchema = z.object({
    status: z.enum(DISPATCH_STATUSES),
    error: z.string().optional(),
    leaseExpiresAt: z.string().optional(),
    acceptedAt: z.string().optional(),
    acceptanceError: z.string().optional(),
  });

  const DispatchRepairSchema = z.object({
    error: z.string().optional(),
  });

  const VALID_TRANSITIONS: Record<DispatchStatus, DispatchStatus[]> = {
    queued: ["waiting", "dispatched", "failed", "cancelled"],
    waiting: ["queued", "dispatched", "failed", "dead_letter", "cancelled"],
    dispatched: ["completed", "failed", "dead_letter", "cancelled"],
    completed: [],
    failed: ["queued", "dead_letter"],
    dead_letter: [],
    cancelled: [],
  };

  router.post("/", requireScope("dispatch:write"), (req, res) => {
    if (isPaused()) {
      res.status(503).json({ error: "substrate_paused", reason: "substrate is paused" });
      return;
    }
    const parsed = DispatchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const body = parsed.data;
    try {
      assertTenantAllowed(req.principal!, body.tenantId);
    } catch (err) {
      if (denyTenant(res, err)) return;
      throw err;
    }
    const db = getDb();
    const now = new Date().toISOString();
    const taskId = randomUUID();

    const row: NewDispatchQueueRow = {
      id: taskId,
      tenantId: body.tenantId,
      taskKind: body.taskKind,
      targetAgentId: body.targetAgentId,
      input: JSON.stringify(body.input),
      status: "queued",
      policyDecisionId: body.policyDecisionId ?? null,
      createdAt: now,
      dispatchedAt: null,
      completedAt: null,
      retryCount: 0,
      maxRetries: body.maxRetries ?? 0,
      leaseExpiresAt: null,
      contractJson: body.contract ? JSON.stringify(body.contract) : null,
      acceptedAt: null,
      acceptanceError: null,
      error: null,
    };
    db.insert(dispatchQueue).values(row).run();

    res.status(201).json({
      taskId,
      status: "queued",
      tenantId: body.tenantId,
      taskKind: body.taskKind,
      targetAgentId: body.targetAgentId,
      createdAt: now,
    });
  });

  router.get("/stats", requireScope("dispatch:write"), (req, res) => {
    const db = getDb();
    const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : undefined;
    const stuckMinutes = Number(req.query.stuckMinutes ?? 5);
    const stuckThreshold = Number.isFinite(stuckMinutes) && stuckMinutes > 0 ? stuckMinutes : 5;
    const stuckCutoff = new Date(Date.now() - stuckThreshold * 60_000).toISOString();

    const baseConditions = [];
    if (tenantId) {
      try {
        assertTenantAllowed(req.principal!, tenantId);
      } catch (err) {
        if (denyTenant(res, err)) return;
        throw err;
      }
      baseConditions.push(eq(dispatchQueue.tenantId, tenantId));
    } else if (req.principal?.tenants !== "*") {
      res.status(403).json({ error: "tenant_required" });
      return;
    }

    const counts = db
      .select({ status: dispatchQueue.status, count: sql<number>`count(*)` })
      .from(dispatchQueue)
      .where(baseConditions.length ? and(...baseConditions) : undefined)
      .groupBy(dispatchQueue.status)
      .all();

    const byStatus: Record<DispatchStatus, number> = {
      queued: 0,
      waiting: 0,
      dispatched: 0,
      completed: 0,
      failed: 0,
      dead_letter: 0,
      cancelled: 0,
    };
    for (const c of counts) byStatus[c.status] = Number(c.count);

    const oldestQueued = db
      .select({ createdAt: dispatchQueue.createdAt })
      .from(dispatchQueue)
      .where(
        and(
          ...baseConditions,
          sql`${dispatchQueue.status} IN ('queued','waiting','dispatched')`,
        )
      )
      .orderBy(dispatchQueue.createdAt)
      .limit(1)
      .get();

    const stuckConditions = [
      ...baseConditions,
      sql`${dispatchQueue.status} IN ('queued','waiting','dispatched')`,
      sql`${dispatchQueue.createdAt} < ${stuckCutoff}`,
    ];
    const stuck = db
      .select({ count: sql<number>`count(*)` })
      .from(dispatchQueue)
      .where(and(...stuckConditions))
      .get()?.count ?? 0;

    res.json({
      byStatus,
      queuedTotal: byStatus.queued,
      waitingTotal: byStatus.waiting,
      dispatchedTotal: byStatus.dispatched,
      stuckCount: Number(stuck),
      stuckThresholdMinutes: stuckThreshold,
      oldestQueuedAt: oldestQueued?.createdAt ?? null,
    });
  });

  router.get("/", requireScope("dispatch:write"), (req, res) => {
    const db = getDb();
    const { tenantId, status, targetAgentId, limit = "50", offset = "0" } = req.query;

    const conditions = [];
    if (typeof tenantId === "string") {
      try {
        assertTenantAllowed(req.principal!, tenantId);
      } catch (err) {
        if (denyTenant(res, err)) return;
        throw err;
      }
      conditions.push(eq(dispatchQueue.tenantId, tenantId));
    } else if (req.principal?.tenants !== "*") {
      res.status(403).json({ error: "tenant_required" });
      return;
    }
    if (status)
      conditions.push(
        eq(
          dispatchQueue.status,
          status as DispatchStatus,
        ),
      );
    if (targetAgentId)
      conditions.push(eq(dispatchQueue.targetAgentId, targetAgentId as string));

    const rows = db
      .select()
      .from(dispatchQueue)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(dispatchQueue.createdAt))
      .limit(Number(limit))
      .offset(Number(offset))
      .all();

    const total =
      db
        .select({ count: sql<number>`count(*)` })
        .from(dispatchQueue)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .get()?.count ?? 0;

    const items = rows.map((row) => ({
      ...row,
      input: safeParseJson(row.input),
    }));
    res.json({ items, total, limit: Number(limit), offset: Number(offset) });
  });

  router.get("/:id", requireScope("dispatch:write"), (req, res) => {
    const db = getDb();
    const id = String(req.params.id ?? "");
    const row = db
      .select()
      .from(dispatchQueue)
      .where(eq(dispatchQueue.id, id))
      .get();
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    try {
      assertTenantAllowed(req.principal!, row.tenantId);
    } catch (err) {
      if (denyTenant(res, err)) return;
      throw err;
    }
    res.json({ ...row, input: safeParseJson(row.input) });
  });

  router.patch("/:id", requireScope("dispatch:write"), (req, res) => {
    const id = String(req.params.id ?? "");
    const parsed = TransitionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const db = getDb();
    const existing = db
      .select()
      .from(dispatchQueue)
      .where(eq(dispatchQueue.id, id))
      .get();
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    try {
      assertTenantAllowed(req.principal!, existing.tenantId);
    } catch (err) {
      if (denyTenant(res, err)) return;
      throw err;
    }

    const now = new Date().toISOString();
    const { status, error } = parsed.data;

    const allowed = VALID_TRANSITIONS[existing.status] ?? [];
    if (!allowed.includes(status)) {
      res.status(409).json({
        error: "invalid_transition",
        message: `Cannot transition from '${existing.status}' to '${status}'`,
        current_status: existing.status,
        requested_status: status,
        allowed_transitions: allowed,
      });
      return;
    }

    const update: Partial<NewDispatchQueueRow> = { status };
    if (status === "dispatched") update.dispatchedAt = now;
    if (status === "completed" || status === "failed" || status === "dead_letter" || status === "cancelled") {
      update.completedAt = now;
    }
    if (error !== undefined) update.error = error;
    if (parsed.data.leaseExpiresAt !== undefined) update.leaseExpiresAt = parsed.data.leaseExpiresAt;
    if (parsed.data.acceptedAt !== undefined) update.acceptedAt = parsed.data.acceptedAt;
    if (parsed.data.acceptanceError !== undefined) update.acceptanceError = parsed.data.acceptanceError;

    db.update(dispatchQueue)
      .set(update)
      .where(eq(dispatchQueue.id, id))
      .run();

    const updated = db
      .select()
      .from(dispatchQueue)
      .where(eq(dispatchQueue.id, id))
      .get();
    res.json({ ...updated, input: safeParseJson(updated?.input ?? "{}") });
  });

  router.post("/:id/retry", requireScope("dispatch:write"), (req, res) => {
    const id = String(req.params.id ?? "");
    const suppliedTenantId = resolveTenantId(req);
    if (suppliedTenantId) {
      try {
        assertTenantAllowed(req.principal!, suppliedTenantId);
      } catch (err) {
        if (denyTenant(res, err)) return;
        throw err;
      }
    }
    const parsed = DispatchRepairSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const db = getDb();
    const existing = db
      .select()
      .from(dispatchQueue)
      .where(eq(dispatchQueue.id, id))
      .get();
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    try {
      assertTenantAllowed(req.principal!, existing.tenantId);
    } catch (err) {
      if (denyTenant(res, err)) return;
      throw err;
    }
    if (!VALID_TRANSITIONS[existing.status as DispatchStatus]?.includes("queued")) {
      res.status(409).json({
        error: "invalid_transition",
        current_status: existing.status,
        requested_status: "queued",
      });
      return;
    }
    db.update(dispatchQueue)
      .set({
        status: "queued",
        retryCount: (existing.retryCount ?? 0) + 1,
        dispatchedAt: null,
        completedAt: null,
        leaseExpiresAt: null,
        error: parsed.data.error ?? null,
      })
      .where(eq(dispatchQueue.id, id))
      .run();
    const updated = db.select().from(dispatchQueue).where(eq(dispatchQueue.id, id)).get();
    res.json({ ...updated, input: safeParseJson(updated?.input ?? "{}") });
  });

  router.post("/:id/dead-letter", requireScope("dispatch:write"), (req, res) => {
    const id = String(req.params.id ?? "");
    const suppliedTenantId = resolveTenantId(req);
    if (suppliedTenantId) {
      try {
        assertTenantAllowed(req.principal!, suppliedTenantId);
      } catch (err) {
        if (denyTenant(res, err)) return;
        throw err;
      }
    }
    const parsed = DispatchRepairSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const db = getDb();
    const existing = db
      .select()
      .from(dispatchQueue)
      .where(eq(dispatchQueue.id, id))
      .get();
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    try {
      assertTenantAllowed(req.principal!, existing.tenantId);
    } catch (err) {
      if (denyTenant(res, err)) return;
      throw err;
    }
    if (!VALID_TRANSITIONS[existing.status as DispatchStatus]?.includes("dead_letter")) {
      res.status(409).json({
        error: "invalid_transition",
        current_status: existing.status,
        requested_status: "dead_letter",
      });
      return;
    }
    db.update(dispatchQueue)
      .set({
        status: "dead_letter",
        completedAt: new Date().toISOString(),
        error: parsed.data.error ?? existing.error ?? "Moved to dead letter by operator",
      })
      .where(eq(dispatchQueue.id, id))
      .run();
    const updated = db.select().from(dispatchQueue).where(eq(dispatchQueue.id, id)).get();
    res.json({ ...updated, input: safeParseJson(updated?.input ?? "{}") });
  });

  return router;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
