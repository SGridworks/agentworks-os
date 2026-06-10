/**
 * Admin routes — scope_violations telemetry.
 *
 * POST /api/admin/scope-violations
 *   Body: { revertedFromCommit, agentRunId?, agentId?, agentRole?, files: string[], reason?, revertedAt? }
 *   Returns: { id } — the created violation record
 *
 * GET /api/admin/scope-violations
 *   Query: ?agentId=&since=&limit=
 *   Returns: { items: ScopeViolationRow[] }
 *
 * GET /api/admin/scope-violations/summary
 *   Query: ?agentId=
 *   Returns: { agentId, totalReverts, topDirectories: string[], recentReverts: ScopeViolationRow[] }
 *
 * The scope-guard daemon (Coordinator-side) calls POST after each revert.
 * Admin UI reads via GET /summary.
 *
 * POST /api/admin/autopilot/dispatch
 *   Body: { actionIds: string[], idempotencyKey: string, dryRun?: boolean }
 *   Returns: { dispatched: number, skipped: number, failed: number, results: AutopilotResult[] }
 *
 * Bulk-dispatch the safe bucket. Evaluates actions for autopilot bucketing
 * and auto-executes those in the safe bucket (riskScore ≤ 0.3, no block rules).
 */

import type { Config } from "../config.js";
import { Router, type Request, type Response } from "express";
import { assertTenantAllowed, TenantAccessError } from "../auth/tenant-access.js";
import { z } from "zod";
import { randomUUID } from "crypto";
import { join } from "node:path";
import { eq, desc, and, gte, sql, inArray } from "drizzle-orm";
import { getDb, getSqlite } from "../db/index.js";
import { compatProxyEvents, scopeViolations, approvalQueue, policyDecisions, actionLog, tenants } from "../db/schema.js";
import { getGraph } from "../services/mission-map.js";
import { generateMorningBriefRecommendation, createMorningBriefSummary } from "../services/morning-brief-recos.js";
import { actionLogSince, getActionLogSummaryByKind } from "../services/action-log-query.js";
import { scanVaultDelta } from "../services/vault-delta.js";
import { getProviderHealthService } from "../services/provider-health.js";
import type { ProviderStatus } from "../services/provider-health.js";
import { getVaultStore } from "./memory.js";
import { PACKAGE_VERSION } from "../health-handler.js";
import { getProfile, validateAgainstRuntime, DEFAULT_ENV_PATH, resolveProfilePath } from "../config/local-profile.js";
import { aggregateTrust } from "../services/trust-aggregator.js";
import { getCached, setCached } from "../services/trust-cache.js";
import { issuePreviewRouter } from "./admin/issue-preview.js";
import { isPaused, pause, resume } from "../pause-service.js";
import { resolveAdminToken, isLoopback, isValidToken } from "../middleware/require-auth.js";
import {
  checkN8nBridge,
  cancelNativeAutomationRun,
  createNativeAutomationEvidencePack,
  createNativeAutomationTemplate,
  createNativeAutomationWorkflow,
  createWorkflowSelfHealProposal,
  diffNativeAutomationWorkflowVersions,
  draftAutomationTemplateFromPrompt,
  explainNativeAutomationRun,
  exportNativeWorkflowToN8n,
  getNativeAutomationEvidencePack,
  getNativeAutomationRun,
  getNativeAutomationWorkflowVersion,
  importN8nWorkflow,
  installNativeAutomationTemplate,
  listNativeAutomationRuns,
  listNativeAutomationTemplates,
  listNativeAutomationWorkflowVersions,
  listNativeAutomationWorkflows,
  nativeAutomationRuntime,
  replayNativeAutomationRun,
  resumeNativeAutomationRun,
  runNativeAutomationWorkflow,
  rollbackNativeAutomationWorkflow,
  setNativeAutomationWorkflowStatus,
  simulateNativeAutomationWorkflow,
  syncNativeWorkflowToN8n,
  updateNativeAutomationWorkflow,
} from "../services/native-automations.js";

const CreateViolationSchema = z.object({
  revertedFromCommit: z.string().min(1),
  agentRunId: z.string().optional(),
  agentId: z.string().optional(),
  agentRole: z.string().optional(),
  files: z.array(z.string()).min(1),
  reason: z.string().optional(),
  revertedAt: z.string().optional(), // ISO datetime; defaults to now
});

const SubstratePauseBody = z.object({
  reason: z.string().min(1).default("manual"),
  actorId: z.string().min(1).default("local-admin"),
  tenantId: z.string().min(1).default("local"),
});

const SubstrateResumeBody = z.object({
  reason: z.string().min(1).default("manual"),
  actorId: z.string().min(1).default("local-admin"),
  tenantId: z.string().min(1).default("local"),
});

const AutomationStatusBody = z.object({
  status: z.enum(["active", "paused"]),
});

const AutomationRunBody = z.object({
  input: z.record(z.unknown()).default({}),
  dryRun: z.boolean().optional(),
});

const AutomationRunResumeBody = z.object({
  input: z.record(z.unknown()).default({}),
});

const AutomationRunReplayBody = z.object({
  fromStepIndex: z.number().int().min(0).default(0),
  inputOverride: z.record(z.unknown()).default({}),
});

const AutomationRunCancelBody = z.object({
  reason: z.string().min(1).max(500).default("cancelled_by_operator"),
});

const AutomationRollbackBody = z.object({
  version: z.number().int().min(1),
});

const AutomationInstallBody = z.object({
  tenantId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
});

const AutomationStepTypeValues = [
  "policy.check",
  "approval.enqueue",
  "approval.wait",
  "vault.read",
  "vault.write",
  "issue.create",
  "issue.update",
  "dispatch",
  "handoff.contract",
  "scanner.finding",
  "webhook.intake",
  "condition.if",
  "branch.switch",
  "loop.each",
  "merge.join",
  "delay.wait",
  "error.catch",
  "data.set",
  "data.transform",
  "data.filter",
  "data.dedupe",
  "data.extract",
  "json.parse",
  "http.request",
  "email.send",
  "message.send",
  "adapter.call",
  "rss.read",
  "file.read",
  "file.write",
  "ai.classify",
  "ai.summarize",
  "ai.extract",
  "ai.route",
  "ai.generate",
  "ai.review",
  "operator.brief",
  "friction.detect",
  "evidence.pack",
  "agent.panel",
  "workflow.self_heal",
] as const;

const AutomationStepBody = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(160),
  type: z.enum(AutomationStepTypeValues),
  params: z.record(z.unknown()).default({}),
});

const AutomationDefinitionBody = z.object({
  trigger: z.enum(["manual", "webhook", "event"]),
  steps: z.array(AutomationStepBody).min(1).max(20),
});

const AutomationWorkflowPatchBody = z.object({
  name: z.string().min(1).max(180).optional(),
  description: z.string().max(2000).nullable().optional(),
  definition: AutomationDefinitionBody.optional(),
  status: z.enum(["active", "paused"]).optional(),
});

const AutomationTemplateCreateBody = z.object({
  tenantId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
  name: z.string().min(1).max(180),
  trigger: z.enum(["manual", "webhook", "event", "Manual", "Webhook", "Event"]).default("manual"),
  description: z.string().min(1).max(2000),
  definition: AutomationDefinitionBody,
});

const AutomationWorkflowCreateBody = z.object({
  tenantId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
  name: z.string().min(1).max(180),
  trigger: z.enum(["manual", "webhook", "event", "Manual", "Webhook", "Event"]).default("manual"),
  description: z.string().max(2000).optional(),
  definition: AutomationDefinitionBody,
  status: z.enum(["active", "paused"]).default("paused"),
});

const AutomationN8nImportBody = z.object({
  tenantId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
  workflowJson: z.record(z.unknown()),
  mode: z.enum(["template", "workflow"]).default("template"),
  status: z.enum(["active", "paused"]).default("paused"),
});

const AutomationAiDraftBody = z.object({
  tenantId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
  prompt: z.string().min(1).max(4000),
  issueId: z.string().min(1).max(180).optional(),
});

/**
 * Calculate autopilot bucket for various data structures.
 * Supports approval queue items, dispatch queue items, and policy decisions.
 * Implements the spec logic from autopilot-spec.md
 */
function calculateAutopilotBucket(item: {
  decision?: string;
  proposed_action_kind?: string;
  decision_reason?: string;
  policy_decision_id?: string;
}): {
  decision: "allow" | "needsApproval" | "risky";
  riskScore: number;
  reasons: string[];
} {
  const reasons: string[] = [];

  // Start with base risk from decision
  let riskScore = 0.0;
  const decision = item.decision || "allow";
  const actionKind = item.proposed_action_kind || "unknown";
  const decisionReason = item.decision_reason || "";

  // If any rule blocked, it's automatically risky
  if (decision === "block") {
    reasons.push("fair-housing-discrimination");
    return {
      decision: "risky",
      riskScore: 0.9,
      reasons,
    };
  }

  // Calculate risk score based on decision type and content
  if (decision === "route_to_review") {
    riskScore = 0.4; // Base risk for route_to_review
    reasons.push("tcpa-no-consent");
  }

  // Add action type risk based on spec table
  const actionTypeRisk = getActionTypeRisk(actionKind);
  riskScore = Math.max(riskScore, actionTypeRisk);

  if (actionTypeRisk >= 0.5) {
    reasons.push("action_type.high_risk");
  }

  // Add content-based risks from decision reason
  const contentRisks = getContentRisks(decisionReason);
  riskScore = Math.max(riskScore, contentRisks.score);
  reasons.push(...contentRisks.reasons);

  // Round to 2 decimals as per spec
  riskScore = Math.round(riskScore * 100) / 100;

  // Determine bucket based on risk score and spec logic
  if (riskScore >= 0.7) {
    return {
      decision: "risky",
      riskScore,
      reasons,
    };
  } else if (riskScore <= 0.3 && decision === "allow" && reasons.length === 0) {
    return {
      decision: "allow",
      riskScore,
      reasons: ["within-policy"],
    };
  } else {
    return {
      decision: "needsApproval",
      riskScore,
      reasons,
    };
  }
}

/**
 * Get risk score for action type based on the spec table
 */
function getActionTypeRisk(actionKind: string): number {
  const riskTable: Record<string, number> = {
    "memory.write": 0.10,
    "memory_write": 0.10,
    "file.read": 0.05,
    "file_read": 0.05,
    "http.get": 0.10,
    "http_get": 0.10,
    "http.post": 0.35,
    "http_post": 0.35,
    "shell.read_only": 0.10,
    "shell_read_only": 0.10,
    "shell.mutating": 0.50,
    "shell_mutating": 0.50,
    "email.send": 0.45,
    "email_send": 0.45,
    "sms.send": 0.55,
    "sms_send": 0.55,
    "db.write": 0.40,
    "db_write": 0.40,
  };

  return riskTable[actionKind] || 0.30; // Default moderate risk
}

/**
 * Extract content-based risks from decision reason
 * Uses the canonical reason codes from the spec
 */
function getContentRisks(decisionReason: string): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0.0;

  const lowerReason = decisionReason.toLowerCase();

  if (lowerReason.includes("tcpa") && lowerReason.includes("time")) {
    score = Math.max(score, 0.2); // TCPA route_to_review adds +0.2
    reasons.push("tcpa-no-consent");
  }

  if (lowerReason.includes("fair housing") || lowerReason.includes("protected class")) {
    score = Math.max(score, 0.6); // Fair housing block adds +0.6
    reasons.push("fair-housing-discrimination");
  }

  if (lowerReason.includes("pii") || lowerReason.includes("phi")) {
    score = Math.max(score, 0.6); // PII leak adds +0.6
    reasons.push("pii-leak-ssn");
  }

  if (lowerReason.includes("consent") || lowerReason.includes("dnc")) {
    score = Math.max(score, 0.2); // Consent issues add +0.2
    reasons.push("tcpa-no-consent");
  }

  return { score, reasons };
}

export function requireLocalAdmin(req: Request, res: Response, config: Config): boolean {
  if (!isLoopback(req)) {
    res.status(403).json({ error: "loopback_required" });
    return false;
  }
  const auth = req.header("authorization") ?? "";
  const prefix = "Bearer ";
  if (!auth.startsWith(prefix) || !isValidToken(auth.slice(prefix.length), resolveAdminToken(config))) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

function auditSubstrateControl(input: {
  tenantId: string;
  actorId: string;
  actionKind: string;
  reason: string;
  paused: boolean;
}): void {
  const now = new Date().toISOString();
  getDb()
    .insert(actionLog)
    .values({
      id: randomUUID(),
      tenantId: input.tenantId,
      actorId: input.actorId,
      actorType: "human",
      actorLabel: input.actorId,
      actionKind: input.actionKind,
      payloadSnapshot: JSON.stringify({
        reason: input.reason,
        paused: input.paused,
        scope: "local-dispatch",
      }),
      vaultRefs: "[]",
      conversationRefs: "[]",
      projectRefs: "[]",
      policyDecisionId: null,
      proposedAt: now,
      loggedAt: now,
    })
    .run();
}

function denyTenant(res: Response, err: unknown): boolean {
  if (err instanceof TenantAccessError) {
    res.status(403).json({ error: "forbidden", message: err.message });
    return true;
  }
  return false;
}

export function createAdminRouter(config: Config): Router {
  const router = Router();

  router.get("/substrate/status", (req, res) => {
    if (!requireLocalAdmin(req, res, config)) return;
    res.json({
      paused: isPaused(),
      scope: "local-dispatch",
      nativeDispatchEnabled:
        process.env.AWOS_NATIVE_DISPATCH_ENABLED === "1" ||
        process.env.AWOS_NATIVE_DISPATCH_ENABLED === "true",
      localGatewayClaimEnabled:
        process.env.AWOS_CLAIM_LOCAL_GATEWAY_DISPATCH === "1" ||
        process.env.AWOS_CLAIM_LOCAL_GATEWAY_DISPATCH === "true",
    });
  });

  router.post("/substrate/pause", (req, res) => {
    if (!requireLocalAdmin(req, res, config)) return;
    const parsed = SubstratePauseBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    pause(parsed.data.actorId, parsed.data.reason);
    auditSubstrateControl({
      tenantId: parsed.data.tenantId,
      actorId: parsed.data.actorId,
      actionKind: "substrate.pause",
      reason: parsed.data.reason,
      paused: true,
    });
    res.json({ paused: true, scope: "local-dispatch" });
  });

  router.post("/substrate/resume", (req, res) => {
    if (!requireLocalAdmin(req, res, config)) return;
    const parsed = SubstrateResumeBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    resume();
    auditSubstrateControl({
      tenantId: parsed.data.tenantId,
      actorId: parsed.data.actorId,
      actionKind: "substrate.resume",
      reason: parsed.data.reason,
      paused: false,
    });
    res.json({ paused: false, scope: "local-dispatch" });
  });

  router.get("/compat-proxy-events", async (req, res) => {
    const { statusCode, since, limit = "100" } = req.query as Record<string, string>;
    const db = getDb();

    const conditions = [];
    if (statusCode) conditions.push(eq(compatProxyEvents.statusCode, Number(statusCode)));
    if (since) conditions.push(gte(compatProxyEvents.createdAt, since));

    const limitNum = Math.min(parseInt(limit, 10) || 100, 1000);
    const rows = db
      .select()
      .from(compatProxyEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(compatProxyEvents.createdAt))
      .limit(limitNum)
      .all();

    res.json({ items: rows });
  });

  // POST /api/admin/scope-violations — write a violation record
  router.post("/scope-violations", async (req, res) => {
    const parsed = CreateViolationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }

    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();
    const row = {
      id,
      revertedFromCommit: parsed.data.revertedFromCommit,
      agentRunId: parsed.data.agentRunId ?? null,
      agentId: parsed.data.agentId ?? null,
      agentRole: parsed.data.agentRole ?? null,
      files: JSON.stringify(parsed.data.files),
      reason: parsed.data.reason ?? null,
      revertedAt: parsed.data.revertedAt ?? now,
      createdAt: now,
    };

    db.insert(scopeViolations).values(row).run();
    res.status(201).json({ id });
  });

  // GET /api/admin/scope-violations — list violations with optional filters
  router.get("/scope-violations", async (req, res) => {
    const { agentId, tenantId: svTenantId, since, limit = "100" } = req.query as Record<string, string>;
    if (!req.principal) { res.status(401).json({ error: "unauthorized" }); return; }
    if (svTenantId) {
      try { assertTenantAllowed(req.principal, svTenantId); } catch (err) { if (denyTenant(res, err)) return; throw err; }
    } else if (req.principal.tenants !== "*") {
      res.status(403).json({ error: "tenant_required" }); return;
    }
    const db = getDb();

    const conditions = [];
    if (agentId) conditions.push(eq(scopeViolations.agentId, agentId));
    if (since) conditions.push(gte(scopeViolations.revertedAt, since));

    const limitNum = Math.min(parseInt(limit, 10) || 100, 1000);
    const rows = db
      .select()
      .from(scopeViolations)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(scopeViolations.revertedAt))
      .limit(limitNum)
      .all();

    const items = rows.map((r) => ({
      ...r,
      files: JSON.parse(r.files as string) as string[],
    }));

    res.json({ items });
  });

  // GET /api/admin/scope-violations/summary — aggregated per-agent summary
  router.get("/scope-violations/summary", async (req, res) => {
    const { agentId, tenantId: svsTenantId } = req.query as Record<string, string>;
    if (!req.principal) { res.status(401).json({ error: "unauthorized" }); return; }
    if (svsTenantId) {
      try { assertTenantAllowed(req.principal, svsTenantId); } catch (err) { if (denyTenant(res, err)) return; throw err; }
    } else if (req.principal.tenants !== "*") {
      res.status(403).json({ error: "tenant_required" }); return;
    }
    const db = getDb();

    // Count total reverts per agent (or all)
    const countRows = db
      .select({
        agentId: scopeViolations.agentId,
        count: sql<number>`count(*)`.as("count"),
      })
      .from(scopeViolations)
      .where(agentId ? eq(scopeViolations.agentId, agentId) : undefined)
      .groupBy(scopeViolations.agentId)
      .all();

    // Per-agent top directories from files
    const dirCount: Record<string, Record<string, number>> = {};
    const recentRows = db
      .select()
      .from(scopeViolations)
      .where(agentId ? eq(scopeViolations.agentId, agentId) : undefined)
      .orderBy(desc(scopeViolations.revertedAt))
      .limit(20)
      .all();

    for (const row of recentRows) {
      const aid = row.agentId ?? "(unknown)";
      if (!dirCount[aid]) dirCount[aid] = {};
      const files = JSON.parse(row.files as string) as string[];
      for (const f of files) {
        const dir = f.split("/").slice(0, 3).join("/"); // top-3 path segments
        dirCount[aid][dir] = (dirCount[aid][dir] ?? 0) + 1;
      }
    }

    const summaries = countRows.map(({ agentId: aid, count }) => {
      const topDirs = Object.entries(dirCount[aid ?? ""] ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([dir, c]) => ({ dir, count: c }));

      return {
        agentId: aid,
        totalReverts: count,
        topDirectories: topDirs,
      };
    });

    res.json({ summaries });
  });

  /**
   * GET /api/admin/activity-log
   * Same shape as ActivityLogEntry consumed by the Activity Log page.
   * Joins action_log with policy_decisions to surface outcome.
   */
  router.get("/activity-log", (req, res) => {
    if (!req.principal) { res.status(401).json({ error: "unauthorized" }); return; }
    const sqlite = getDb().$client;
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 1000);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : null;
    if (tenantId) {
      try { assertTenantAllowed(req.principal, tenantId); } catch (err) { if (denyTenant(res, err)) return; throw err; }
    } else if (req.principal.tenants !== "*") {
      res.status(403).json({ error: "tenant_required" }); return;
    }
    const agentId = typeof req.query.agentId === "string" ? req.query.agentId : null;
    const actionKind = typeof req.query.actionKind === "string" ? req.query.actionKind : null;
    const decision = typeof req.query.decision === "string" ? req.query.decision : null;
    const from = typeof req.query.from === "string" ? req.query.from : null;
    const to = typeof req.query.to === "string" ? req.query.to : null;

    const where: string[] = [];
    const params: unknown[] = [];
    if (tenantId)   { where.push("a.tenant_id = ?"); params.push(tenantId); }
    if (agentId)    { where.push("a.actor_id = ?");  params.push(agentId); }
    if (actionKind) { where.push("a.action_kind = ?"); params.push(actionKind); }
    if (decision)   { where.push("p.decision = ?"); params.push(decision); } // outcome filter
    if (from)       { where.push("a.logged_at >= ?"); params.push(from); }
    if (to)         { where.push("a.logged_at <= ?"); params.push(to); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const rows = sqlite
      .prepare(
        `SELECT a.id, a.tenant_id, a.actor_id, a.actor_label, a.action_kind,
                COALESCE(p.decision, 'allow') AS outcome, a.logged_at AS timestamp
         FROM action_log a
         LEFT JOIN policy_decisions p ON p.id = a.policy_decision_id
         ${whereSql}
         ORDER BY a.logged_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as Array<{
        id: string; tenant_id: string; actor_id: string; actor_label: string;
        action_kind: string; outcome: string; timestamp: string;
      }>;

    res.json(rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      actorId: r.actor_id,
      actorLabel: r.actor_label,
      actionKind: r.action_kind,
      outcome: r.outcome,
      timestamp: r.timestamp,
    })));
  });

  /**
   * GET /api/admin/triage-queue
   * Issues with no assignee — the inbox the operator needs to fan out.
   * Returns suggestedRoles by simple title heuristic so the UI's role-picker
   * can prefill. Real auto-routing lives in /api/issues/lanes (RFC 008).
   */
  router.get("/triage-queue", (_req, res) => {
    const sqlite = getDb().$client;
    const issueRows = sqlite
      .prepare(
        `SELECT id, identifier, title, priority, created_at, metadata_json
         FROM execution_issues
         WHERE assignee_agent_id IS NULL
           AND status IN ('todo','triage','inbox','in_progress')
         ORDER BY
           CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                         WHEN 'medium' THEN 2 ELSE 3 END,
           created_at DESC
         LIMIT 200`
      )
      .all() as Array<{ id: string; identifier: string | null; title: string; priority: string; created_at: string; metadata_json: string | null }>;

    const agentRows = sqlite
      .prepare(
        `SELECT id, name, COALESCE(role,'') AS title FROM execution_agents WHERE status = 'active' ORDER BY name`
      )
      .all() as Array<{ id: string; name: string; title: string }>;

    const issues = issueRows.map((r) => {
      const lower = r.title.toLowerCase();
      const suggested: string[] = [];
      if (/(spec|design|plan|contract)/.test(lower)) suggested.push("pm");
      if (/(impl|implement|api|endpoint|backend|fix|refactor|build)/.test(lower)) suggested.push("engineer");
      if (/(qa|test|smoke|verify|review)/.test(lower)) suggested.push("qa");
      if (/(doc|write|publish|memo)/.test(lower)) suggested.push("writer");
      return {
        id: r.id,
        identifier: r.identifier ?? r.id.slice(0, 8),
        title: r.title,
        priority: r.priority,
        createdAt: r.created_at,
        matchedRole: suggested[0] ?? null,
        triageReason: suggested.length === 0 ? "no role match" : null,
        suggestedRoles: suggested,
      };
    });

    res.json({ issues, agents: agentRows, count: issues.length });
  });

  router.post("/triage-queue/assign", (req, res) => {
    const Body = z.object({
      issueId: z.string().uuid(),
      assigneeAgentId: z.string().uuid(),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const sqlite = getDb().$client;
    const exists = sqlite
      .prepare("SELECT 1 FROM execution_agents WHERE id = ?")
      .get(parsed.data.assigneeAgentId);
    if (!exists) {
      res.status(404).json({ error: "agent_not_found" });
      return;
    }
    const issueRow = sqlite
      .prepare(
        "SELECT tenant_id, identifier, project_id, assignee_agent_id FROM execution_issues WHERE id = ?"
      )
      .get(parsed.data.issueId) as
        | { tenant_id: string; identifier: string | null; project_id: string; assignee_agent_id: string | null }
        | undefined;
    const now = new Date().toISOString();
    const result = sqlite
      .prepare(
        `UPDATE execution_issues SET assignee_agent_id = ?, updated_at = ? WHERE id = ?`
      )
      .run(parsed.data.assigneeAgentId, now, parsed.data.issueId);
    if (result.changes === 0) {
      res.status(404).json({ error: "issue_not_found" });
      return;
    }
    if (issueRow) {
      sqlite
        .prepare(
          `INSERT INTO action_log
           (id, tenant_id, actor_id, actor_type, actor_label, action_kind,
            payload_snapshot, vault_refs, conversation_refs, project_refs,
            policy_decision_id, proposed_at, logged_at)
           VALUES (?, ?, ?, 'system', 'Coordinator', 'issue.assign', ?, '[]', '[]', ?, NULL, ?, ?)`
        )
        .run(
          randomUUID(),
          issueRow.tenant_id,
          parsed.data.assigneeAgentId,
          JSON.stringify({
            issueId: parsed.data.issueId,
            identifier: issueRow.identifier,
            from: issueRow.assignee_agent_id,
            to: parsed.data.assigneeAgentId,
          }),
          JSON.stringify([issueRow.project_id]),
          now,
          now,
        );
    }
    res.json({ success: true, issue: { id: parsed.data.issueId, assigneeAgentId: parsed.data.assigneeAgentId } });
  });

  /**
   * GET /api/admin/decisions-per-min
   * Mission Control KPI cell. Returns rolling rate over the trailing window.
   */
  router.get("/decisions-per-min", (req, res) => {
    const windowMin = Number(req.query.windowMinutes ?? 60);
    const w = Number.isFinite(windowMin) && windowMin > 0 ? windowMin : 60;
    const cutoff = new Date(Date.now() - w * 60_000).toISOString();
    const sqlite = getDb().$client;
    const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : null;
    const params: unknown[] = [cutoff];
    let where = `created_at >= ?`;
    if (tenantId) { where += ` AND tenant_id = ?`; params.push(tenantId); }
    const row = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM policy_decisions WHERE ${where}`)
      .get(...params) as { n: number };
    const perMin = row.n / w;
    res.json({ windowMinutes: w, total: row.n, perMin: Math.round(perMin * 100) / 100 });
  });

  /**
   * GET /api/admin/process-health
   * Per-agent compliance digest. Built from action_log + policy_decisions
   * counts. Without scope-violation data we report pass-only; once the
   * scope-guard daemon is wired up this will populate flag + autoFix.
   */
  router.get("/process-health", (_req, res) => {
    const sqlite = getDb().$client;
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const todayIso = today.toISOString();

    const totalActions = (sqlite
      .prepare("SELECT COUNT(*) AS n FROM action_log WHERE proposed_at >= ?")
      .get(todayIso) as { n: number }).n;
    const violationsCaught = (sqlite
      .prepare("SELECT COUNT(*) AS n FROM policy_decisions WHERE created_at >= ? AND decision IN ('block','route_to_review')")
      .get(todayIso) as { n: number }).n;

    const agents = sqlite
      .prepare(`SELECT id, name FROM execution_agents WHERE status = 'active' ORDER BY name`)
      .all() as Array<{ id: string; name: string }>;

    // Per-agent: count actions, blocks, routes today
    const agentDigests = agents.map((a) => {
      const pass = (sqlite
        .prepare(`SELECT COUNT(*) AS n FROM action_log WHERE actor_id = ? AND proposed_at >= ?`)
        .get(a.id, todayIso) as { n: number }).n;
      const flag = (sqlite
        .prepare(`SELECT COUNT(*) AS n FROM policy_decisions WHERE actor_id = ? AND created_at >= ? AND decision IN ('block','route_to_review')`)
        .get(a.id, todayIso) as { n: number }).n;
      return {
        agentId: a.id,
        agentName: a.name,
        checks: [
          { checkId: "actions", label: "Actions", pass, flag, autoFix: 0 },
        ],
      };
    });

    // Top offenders: agents with the most flags today.
    const topOffenders = agentDigests
      .map((d) => ({
        agentId: d.agentId,
        agentName: d.agentName,
        totalFlags: d.checks.reduce((s, c) => s + c.flag, 0),
        topCheck: "actions",
        topSeverity: "warn" as const,
      }))
      .filter((o) => o.totalFlags > 0)
      .sort((a, b) => b.totalFlags - a.totalFlags)
      .slice(0, 5);

    res.json({
      digest: {
        today: { totalActions, violationsCaught },
        period: "today",
        generatedAt: new Date().toISOString(),
        agents: agentDigests,
        topOffenders,
        checkDefinitions: [
          { checkId: "actions", label: "Actions", description: "Total proposed actions logged today" },
        ],
      },
    });
  });

  /**
   * POST /api/admin/autopilot/dispatch
   * Bulk-dispatch the safe bucket. Evaluates actions for autopilot bucketing
   * and auto-executes those in the safe bucket (riskScore ≤ 0.3, no block rules).
   */
  const AutopilotDispatchSchema = z.object({
    actionIds: z.array(z.string().uuid()).min(1).max(50), // 50 actions per batch max
    idempotencyKey: z.string().min(1).max(128),
    dryRun: z.boolean().optional().default(false),
  });

  interface AutopilotResult {
    actionId: string;
    decision: "allow" | "needsApproval" | "risky";
    riskScore: number;
    reasons: string[];
    dispatched: boolean;
  }

  router.post("/autopilot/dispatch", async (req, res) => {
    const parsed = AutopilotDispatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }

    const db = getDb();
    const { actionIds, idempotencyKey, dryRun } = parsed.data;

    // Get policy decisions for the requested actions
    const decisions = db
      .select()
      .from(policyDecisions)
      .where(inArray(policyDecisions.actionId, actionIds))
      .all();

    if (decisions.length === 0) {
      res.status(404).json({ error: "no_actions_found" });
      return;
    }

    const results: AutopilotResult[] = [];
    let dispatchedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let anyIdempotent = false;

    for (const decision of decisions) {
      try {
        // Idempotency: check if already dispatched with this key
        const existingLog = db
          .select({ payloadSnapshot: actionLog.payloadSnapshot })
          .from(actionLog)
          .where(eq(actionLog.policyDecisionId, decision.id))
          .orderBy(desc(actionLog.loggedAt))
          .limit(1)
          .get();

        if (existingLog) {
          try {
            const payload = JSON.parse(existingLog.payloadSnapshot);
            if (payload.idempotencyKey === idempotencyKey) {
              results.push({
                actionId: decision.actionId,
                decision: payload.autopilotDecision || "allow",
                riskScore: payload.riskScore ?? 0,
                reasons: payload.reasons || ["within-policy"],
                dispatched: payload.autopilotDecision === "allow",
              });
              if (payload.autopilotDecision === "allow") {
                dispatchedCount++;
              } else {
                skippedCount++;
              }
              anyIdempotent = true;
              continue;
            }
          } catch {
            // ignore parse errors, fall through to dispatch
          }
        }

        // Calculate autopilot bucket and risk score
        const autopilotResult = calculateAutopilotBucket({
          decision: decision.decision,
          proposed_action_kind: decision.proposedActionKind,
          decision_reason: decision.decisionReason,
          policy_decision_id: decision.id,
        });

        const result: AutopilotResult = {
          actionId: decision.actionId,
          decision: autopilotResult.decision,
          riskScore: autopilotResult.riskScore,
          reasons: autopilotResult.reasons,
          dispatched: false,
        };

        if (autopilotResult.decision === "allow") {
          if (dryRun) {
            result.dispatched = true;
            dispatchedCount++;
          } else {
            const actionLogId = randomUUID();
            const now = new Date().toISOString();

            db.insert(actionLog)
              .values({
                id: actionLogId,
                tenantId: decision.tenantId,
                actorId: decision.actorId,
                actorType: decision.actorType,
                actorLabel: decision.actorLabel,
                actionKind: decision.proposedActionKind,
                payloadSnapshot: JSON.stringify({
                  idempotencyKey,
                  autopilotDecision: autopilotResult.decision,
                  riskScore: autopilotResult.riskScore,
                  reasons: autopilotResult.reasons,
                }),
                vaultRefs: "[]",
                conversationRefs: "[]",
                projectRefs: "[]",
                policyDecisionId: decision.id,
                proposedAt: decision.proposedAt,
                loggedAt: now,
              })
              .run();

            result.dispatched = true;
            dispatchedCount++;
          }
        } else {
          skippedCount++;
        }

        results.push(result);
      } catch (error) {
        failedCount++;
        console.error(`Failed to process action ${decision.actionId}:`, error);
        results.push({
          actionId: decision.actionId,
          decision: "risky",
          riskScore: 1.0,
          reasons: ["processing-error"],
          dispatched: false,
        });
      }
    }

    res.json({
      dispatched: dispatchedCount,
      skipped: skippedCount,
      failed: failedCount,
      results,
      idempotent: anyIdempotent,
    });
  });

  /**
   * GET /api/admin/autopilot
   * Returns bucketing summary for autopilot: {safe, needsApproval, risky}
   * Computed from triage queue + policy decisions + dispatch queue + idle-agent state
   */
  router.get("/autopilot", (req, res) => {
    if (!req.principal) { res.status(401).json({ error: "unauthorized" }); return; }
    try {
      const { tenantId } = req.query as Record<string, string>;

      if (!tenantId) {
        res.status(400).json({ error: "tenantId required" });
        return;
      }

      try { assertTenantAllowed(req.principal, tenantId); } catch (err) { if (denyTenant(res, err)) return; throw err; }

      const sqlite = getDb().$client;

      // Get pending actions from various sources
      const now = new Date().toISOString();

      // 1. Get unassigned issues from triage queue (issues with no assignee)
      let triageIssues: Array<{
        id: string;
        title: string;
        priority: string;
        created_at: string;
        metadata_json: string | null;
      }> = [];

      try {
        triageIssues = sqlite
          .prepare(`
            SELECT ei.id, ei.title, ei.priority, ei.created_at, ei.metadata_json
            FROM execution_issues ei
            JOIN execution_companies ec ON ei.company_id = ec.id
            WHERE ec.tenant_id = ?
              AND ei.assignee_agent_id IS NULL
              AND ei.status IN ('todo','triage','inbox','in_progress')
          `)
          .all(tenantId) as typeof triageIssues;
      } catch (error) {
        console.error("Error fetching triage issues:", error);
        // Continue with empty triage issues if table doesn't exist yet
      }

      // 2. Get pending approval queue items
      let approvalQueueItems: Array<{
        id: string;
        policy_decision_id: string;
        proposed_action_kind: string;
        decision_reason: string;
        decision: string;
        proposed_at: string;
        actor_label: string;
      }> = [];

      try {
        approvalQueueItems = sqlite
          .prepare(`
            SELECT aq.id, aq.policy_decision_id, aq.proposed_action_kind, aq.decision_reason,
                   pd.decision, pd.proposed_at, pd.actor_label
            FROM approval_queue aq
            JOIN policy_decisions pd ON aq.policy_decision_id = pd.id
            WHERE aq.tenant_id = ? AND aq.status = 'pending'
          `)
          .all(tenantId) as typeof approvalQueueItems;
      } catch (error) {
        console.error("Error fetching approval queue items:", error);
        // Continue with empty approval queue if table doesn't exist yet
      }

      // 3. Get queued dispatch items
      let dispatchQueueItems: Array<{
        id: string;
        task_kind: string;
        input: string;
        policy_decision_id: string | null;
        decision: string | null;
        proposed_at: string;
        actor_label: string;
      }> = [];

      try {
        dispatchQueueItems = sqlite
          .prepare(`
            SELECT dq.id, dq.task_kind, dq.input, dq.policy_decision_id,
                   pd.decision, pd.proposed_at, pd.actor_label
            FROM dispatch_queue dq
            LEFT JOIN policy_decisions pd ON dq.policy_decision_id = pd.id
            WHERE dq.tenant_id = ? AND dq.status = 'queued'
          `)
          .all(tenantId) as typeof dispatchQueueItems;
      } catch (error) {
        console.error("Error fetching dispatch queue items:", error);
        // Continue with empty dispatch queue if table doesn't exist yet
      }

      // 4. Get recent policy decisions that might need autopilot evaluation
      let recentDecisions: Array<{
        id: string;
        action_id: string;
        decision: string;
        proposed_action_kind: string;
        decision_reason: string;
        proposed_at: string;
      }> = [];

      try {
        recentDecisions = sqlite
          .prepare(`
            SELECT id, action_id, decision, proposed_action_kind, decision_reason, proposed_at
            FROM policy_decisions
            WHERE tenant_id = ?
              AND proposed_at >= datetime(?, '-1 hour')
              AND decision IN ('allow', 'route_to_review')
              AND id NOT IN (SELECT policy_decision_id FROM approval_queue WHERE tenant_id = ?)
            ORDER BY proposed_at DESC
            LIMIT 100
          `)
          .all(tenantId, now, tenantId) as typeof recentDecisions;
      } catch (error) {
        console.error("Error fetching recent decisions:", error);
        // Continue with empty recent decisions if query fails
      }

      // Initialize counters
      let safe = 0;
      let needsApproval = 0;
      let risky = 0;

      // Process triage issues - these typically need approval as they require human assignment
      needsApproval += triageIssues.length;

      // Process approval queue items
      for (const item of approvalQueueItems) {
        const evaluation = calculateAutopilotBucket(item);

        switch (evaluation.decision) {
          case "allow":
            safe++;
            break;
          case "needsApproval":
            needsApproval++;
            break;
          case "risky":
            risky++;
            break;
        }
      }

      // Process dispatch queue items. calculateAutopilotBucket expects a
      // shape with non-null decision/proposed_action_kind/decision_reason;
      // dispatch_queue rows can be null on those fields if the dispatch
      // pre-dates a policy decision. Adapt safely.
      for (const item of dispatchQueueItems) {
        const arg: { decision?: string; proposed_action_kind?: string; decision_reason?: string; policy_decision_id?: string } = {};
        if (item.decision) arg.decision = item.decision;
        if (item.policy_decision_id) arg.policy_decision_id = item.policy_decision_id;
        const evaluation = calculateAutopilotBucket(arg);

        switch (evaluation.decision) {
          case "allow":
            safe++;
            break;
          case "needsApproval":
            needsApproval++;
            break;
          case "risky":
            risky++;
            break;
        }
      }

      // Process recent policy decisions that aren't in approval queue yet
      for (const decision of recentDecisions) {
        const evaluation = calculateAutopilotBucket({
          decision: decision.decision,
          proposed_action_kind: decision.proposed_action_kind,
          decision_reason: decision.decision_reason,
        });

        switch (evaluation.decision) {
          case "allow":
            safe++;
            break;
          case "needsApproval":
            needsApproval++;
            break;
          case "risky":
            risky++;
            break;
        }
      }

      res.json({
        safe,
        needsApproval,
        risky,
        summary: {
          triageIssues: triageIssues.length,
          approvalQueue: approvalQueueItems.length,
          dispatchQueue: dispatchQueueItems.length,
          recentDecisions: recentDecisions.length,
        },
        generatedAt: now,
      });
    } catch (error) {
      console.error("Error in /api/admin/autopilot:", error);
      res.status(500).json({ error: "internal_server_error", message: "Failed to compute autopilot summary" });
    }
  });

  /**
   * GET /api/admin/mission-map
   * Returns graph data for the mission map visualization.
   * Query params:
   *   - tenantId: required
   *   - root: optional node id to use as root for subgraph
   *   - depth: optional max depth (default: 3, max: 5)
   */
  router.get("/mission-map", (req, res) => {
    if (!req.principal) { res.status(401).json({ error: "unauthorized" }); return; }
    const { tenantId, root, depth } = req.query as Record<string, string>;

    if (!tenantId) {
      res.status(400).json({ error: "tenantId required" });
      return;
    }

    try { assertTenantAllowed(req.principal, tenantId); } catch (err) { if (denyTenant(res, err)) return; throw err; }

    try {
      const depthNum = depth ? parseInt(depth, 10) : 3;
      const opts: { tenantId: string; root?: string; depth: number } = { tenantId, depth: depthNum };
      if (root) opts.root = root;
      const result = getGraph(opts);

      res.json(result);
    } catch (error) {
      console.error("Error fetching mission map graph:", error);
      res.status(500).json({
        error: "internal_server_error",
        message: "Failed to fetch mission map graph"
      });
    }
  });

  /**
   * GET /api/admin/morning-brief
   * Returns morning brief data for the operator dashboard.
   * Query params:
   *   - tenantId: required
   *   - since: optional ISO timestamp (defaults to 12 hours ago)
   *   - generatedAt: optional ISO timestamp (defaults to now)
   */
  router.get("/morning-brief", async (req, res) => {
    if (!req.principal) { res.status(401).json({ error: "unauthorized" }); return; }
    const { tenantId, since, generatedAt } = req.query as Record<string, string>;

    if (!tenantId) {
      res.status(400).json({ error: "tenantId required" });
      return;
    }

    try { assertTenantAllowed(req.principal, tenantId); } catch (err) { if (denyTenant(res, err)) return; throw err; }

    try {
      // Default to 12 hours look-back if not specified
      const sinceTime = since || new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      const generatedAtTime = generatedAt || new Date().toISOString();

      // Get action logs since the cutoff time
      const actionLogs = actionLogSince(tenantId, sinceTime);

      // Get summary by action kind
      const actionSummary = getActionLogSummaryByKind(tenantId, sinceTime);

      // Count total actions and categorize them
      const totalActions = actionLogs.length;
      const policyChecks = actionLogs.filter(log => log.actionKind === "policy.check");

      // Get policy decisions for the policy checks
      const policyDecisionIds = policyChecks.map(log => log.policyDecisionId).filter(Boolean);
      const sqlite = getDb().$client;

      let decisions: Array<{ decision: string; actorId: string }> = [];
      if (policyDecisionIds.length > 0) {
        const placeholders = policyDecisionIds.map(() => "?").join(",");
        decisions = sqlite
          .prepare(`SELECT id, decision, actor_id FROM policy_decisions WHERE id IN (${placeholders})`)
          .all(...policyDecisionIds) as Array<{ decision: string; actorId: string }>;
      }

      // Count decisions by type
      const allowed = decisions.filter(d => d.decision === "allow").length;
      const blocked = decisions.filter(d => d.decision === "block").length;
      const routed = decisions.filter(d => d.decision === "route_to_review").length;

      // Get approval queue depth (pending items)
      const approvalQueueResult = sqlite
        .prepare("SELECT COUNT(*) as count FROM approval_queue WHERE tenant_id = ? AND status = 'pending'")
        .get(tenantId) as { count: number } | undefined;
      const approvalQueueDepth = approvalQueueResult?.count ?? 0;

      // Get oldest approval queue item age
      const oldestApproval = sqlite
        .prepare(`SELECT created_at FROM approval_queue
                  WHERE tenant_id = ? AND status = 'pending'
                  ORDER BY created_at ASC LIMIT 1`)
        .get(tenantId) as { created_at: string } | undefined;

      let oldestHumanAgeHours = 0;
      if (oldestApproval && oldestApproval.created_at) {
        const oldestTime = new Date(oldestApproval.created_at);
        const now = new Date();
        oldestHumanAgeHours = (now.getTime() - oldestTime.getTime()) / (1000 * 60 * 60);
      }

      // Get vault edits since cutoff (using vault delta scan)
      const vaultRoot = process.env.VAULT_ROOT || "/tmp/awo-vault"; // Default fallback
      let vaultEdits = 0;
      let vaultAnomalies = 0;

      try {
        const vaultDelta = await scanVaultDelta(vaultRoot, tenantId, sinceTime, {
          useManifest: true,
          computeHashes: false
        });
        vaultEdits = vaultDelta.entries.length;

        // For anomalies, we'll count entries that might be suspicious
        // This is a simplified approach - in reality you'd have more sophisticated anomaly detection
        vaultAnomalies = vaultDelta.entries.filter(entry =>
          entry.sizeBytes === 0 || entry.key.includes("anomaly")
        ).length;
      } catch (error) {
        // If vault scan fails, we'll just report 0 edits
        console.error("Failed to scan vault delta:", error);
      }

      // Get unique agents that were active
      const uniqueAgents = new Set(actionLogs
        .filter(log => log.actorType === "agent")
        .map(log => log.actorId)
      ).size;

      // Get offline agents (simplified - in reality you'd check agent status)
      const activeAgentsResult = sqlite
        .prepare("SELECT COUNT(*) as count FROM execution_agents WHERE status = 'active'")
        .get() as { count: number } | undefined;
      const activeAgents = activeAgentsResult?.count ?? 0;

      // For morning brief, we consider agents that haven't logged actions recently as "offline"
      const recentAgentActions = new Set(actionLogs
        .filter(log => log.actorType === "agent")
        .map(log => log.actorId)
      );
      const offlineAgents = Math.max(0, activeAgents - recentAgentActions.size);

      // Generate recommendations
      const summary = createMorningBriefSummary(
        totalActions,
        blocked,
        routed,
        allowed,
        offlineAgents,
        0 // highBudgetAgents - would need budget tracking
      );

      const recommendation = generateMorningBriefRecommendation(summary);

      // Build health status
      const health = {
        scanner_worker_ok: true, // Simplified - would check actual scanner status
        policy_engine_ok: true,  // Simplified - would check actual policy engine status
        vault_ok: vaultAnomalies === 0,
        alerts: [] as string[]
      };

      if (vaultAnomalies > 0) {
        health.alerts.push(`${vaultAnomalies} vault anomaly${vaultAnomalies === 1 ? '' : 'ies'} detected`);
      }
      if (offlineAgents > 0) {
        health.alerts.push(`${offlineAgents} offline agent${offlineAgents === 1 ? '' : 's'}`);
      }

      // Build recommendations array
      const recommendations = [];
      if (recommendation.primaryAction !== "none") {
        recommendations.push({
          id: "primary_recommendation",
          priority: blocked > 0 ? "high" : routed > 0 ? "medium" : "low",
          message: recommendation.recommendationText,
          action_url: "/approvals"
        });
      }

      if (vaultAnomalies > 0) {
        recommendations.push({
          id: "vault_anomaly",
          priority: "medium",
          message: `${vaultAnomalies} vault anomaly${vaultAnomalies === 1 ? '' : 'ies'} detected — inspect hash mismatch.`,
          action_url: "/vault/events?anomaly=true"
        });
      }

      if (approvalQueueDepth > 0 && oldestHumanAgeHours > 3) {
        recommendations.push({
          id: "approve_oldest",
          priority: "high",
          message: `Oldest human review is ${Math.round(oldestHumanAgeHours)} hours old — approve or escalate?`,
          action_url: "/approvals?sort=age"
        });
      }

      const response = {
        since: sinceTime,
        generatedAt: generatedAtTime,
        sections: {
          blockers: {
            totalActions,
            agentsActive: uniqueAgents,
            actionsProposed: totalActions,
            actionsAllowed: allowed,
            actionsBlocked: blocked,
            actionsRouted: routed,
            vaultWrites: vaultEdits,
            vaultAnomalies
          },
          approvals: {
            depth: approvalQueueDepth,
            oldestHumanAgeHours: Math.round(oldestHumanAgeHours * 10) / 10
          },
          terminalRuns: {
            count: totalActions,
            success: allowed,
            blocked,
            routed
          },
          vaultEdits: {
            count: vaultEdits,
            anomalies: vaultAnomalies
          },
          recommendations: recommendations.slice(0, 3) // Max 3 recommendations
        }
      };

      res.json(response);
    } catch (error) {
      console.error("Error generating morning brief:", error);
      res.status(500).json({
        error: "internal_server_error",
        message: "Failed to generate morning brief"
      });
    }
  });

  /**
   * GET /api/admin/automations
   * Local automation engine status and native AgentWorks templates.
   */
  router.get("/automations", async (req, res) => {
    const companyId =
      typeof req.query.companyId === "string"
        ? req.query.companyId
        : "00000000-0000-4000-8000-000000000002";
    const checkedAt = new Date().toISOString();
    const bridge = await checkN8nBridge(config);
    const workflows = listNativeAutomationWorkflows(companyId);
    const recentRuns = listNativeAutomationRuns(companyId, 12);
    const warnings = [
      ...bridge.warnings,
      ...(workflows.length === 0 ? ["no-native-workflows-installed"] : []),
    ];

    res.json({
      engine: {
        name: "AWOS Native Automation Engine",
        state: "online",
        checkedAt,
        latencyMs: 0,
        error: null,
        privateBackend: true,
      },
      runtime: nativeAutomationRuntime(config),
      bridge,
      warnings,
      suggestions: [
        {
          id: "ai-draft-from-issue",
          title: "Draft a workflow from a repeated issue pattern",
          description:
            "Use recent AgentWorks issues to propose an automation template, then require operator review before install.",
          status: "planned",
        },
        {
          id: "ai-run-explainer",
          title: "Explain a run and suggest the next automation",
          description:
            "Summarize step outcomes, friction, and a recommended follow-on workflow after each native run.",
          status: "planned",
        },
      ],
      templates: listNativeAutomationTemplates(companyId),
      workflows: workflows.map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        active: workflow.status === "active",
        status: workflow.status,
        trigger: workflow.trigger,
        eventKind: workflow.eventKind ?? null,
        description: workflow.description,
        definition: workflow.definition,
        updatedAt: workflow.updatedAt,
        currentVersion: workflow.currentVersion,
        definitionHash: workflow.definitionHash,
        sourceTemplateId: workflow.sourceTemplateId,
        externalEngine: workflow.externalEngine,
        externalWorkflowId: workflow.externalWorkflowId,
        externalSyncStatus: workflow.externalSyncStatus,
        externalSyncedAt: workflow.externalSyncedAt,
        externalSyncError: workflow.externalSyncError,
      })),
      recentRuns: recentRuns.map((run) => ({
        id: run.id,
        workflowId: run.workflowId,
        workflowName: workflows.find((w) => w.id === run.workflowId)?.name ?? run.workflowId,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        terminalReason: run.terminalReason,
        currentStepIndex: run.currentStepIndex,
        workflowVersionId: run.workflowVersionId,
        waitingForApprovalId: run.waitingForApprovalId,
        waitingForDispatchId: run.waitingForDispatchId,
        dryRun: run.dryRun,
        steps: run.steps,
        error: run.error,
      })),
    });
  });

  router.post("/automations/templates", (req, res) => {
    if (!req.principal) { res.status(401).json({ error: "unauthorized" }); return; }
    const parsed = AutomationTemplateCreateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    if (parsed.data.tenantId) {
      try { assertTenantAllowed(req.principal, parsed.data.tenantId); } catch (err) { if (denyTenant(res, err)) return; throw err; }
    }
    const opts: Parameters<typeof createNativeAutomationTemplate>[0] = {
      name: parsed.data.name,
      trigger: parsed.data.trigger,
      description: parsed.data.description,
      definition: parsed.data.definition,
    };
    if (parsed.data.tenantId) opts.tenantId = parsed.data.tenantId;
    if (parsed.data.companyId) opts.companyId = parsed.data.companyId;
    res.status(201).json(createNativeAutomationTemplate(opts));
  });

  router.post("/automations/templates/:templateId/install", (req, res) => {
    if (!req.principal) { res.status(401).json({ error: "unauthorized" }); return; }
    const parsed = AutomationInstallBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    if (parsed.data.tenantId) {
      try { assertTenantAllowed(req.principal, parsed.data.tenantId); } catch (err) { if (denyTenant(res, err)) return; throw err; }
    }
    try {
      const installOpts: { tenantId?: string; companyId?: string } = {};
      if (parsed.data.tenantId) installOpts.tenantId = parsed.data.tenantId;
      if (parsed.data.companyId) installOpts.companyId = parsed.data.companyId;
      const workflow = installNativeAutomationTemplate(req.params.templateId, installOpts);
      res.status(201).json(workflow);
    } catch (error) {
      const message = error instanceof Error ? error.message : "install failed";
      res.status(message === "template_not_found" ? 404 : 500).json({ error: message });
    }
  });

  router.post("/automations/workflows", (req, res) => {
    if (!req.principal) { res.status(401).json({ error: "unauthorized" }); return; }
    const parsed = AutomationWorkflowCreateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    if (parsed.data.tenantId) {
      try { assertTenantAllowed(req.principal, parsed.data.tenantId); } catch (err) { if (denyTenant(res, err)) return; throw err; }
    }
    const opts: Parameters<typeof createNativeAutomationWorkflow>[0] = {
      name: parsed.data.name,
      trigger: parsed.data.trigger,
      definition: parsed.data.definition,
      status: parsed.data.status,
    };
    if (parsed.data.description) opts.description = parsed.data.description;
    if (parsed.data.tenantId) opts.tenantId = parsed.data.tenantId;
    if (parsed.data.companyId) opts.companyId = parsed.data.companyId;
    res.status(201).json(createNativeAutomationWorkflow(opts));
  });

  router.patch("/automations/workflows/:workflowId", (req, res) => {
    const parsed = AutomationWorkflowPatchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      if (
        parsed.data.name === undefined &&
        parsed.data.description === undefined &&
        parsed.data.definition === undefined &&
        parsed.data.status !== undefined
      ) {
        res.json(setNativeAutomationWorkflowStatus(req.params.workflowId, parsed.data.status));
        return;
      }
      const update: Parameters<typeof updateNativeAutomationWorkflow>[1] = {};
      if (parsed.data.name !== undefined) update.name = parsed.data.name;
      if (parsed.data.description !== undefined) update.description = parsed.data.description;
      if (parsed.data.status !== undefined) update.status = parsed.data.status;
      if (parsed.data.definition !== undefined) update.definition = parsed.data.definition;
      res.json(updateNativeAutomationWorkflow(req.params.workflowId, update));
    } catch (error) {
      const message = error instanceof Error ? error.message : "workflow update failed";
      res.status(message === "workflow_not_found" ? 404 : 500).json({ error: message });
    }
  });

  router.post("/automations/workflows/:workflowId/run", async (req, res) => {
    const parsed = AutomationRunBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const run = await runNativeAutomationWorkflow(req.params.workflowId, parsed.data.input, config, {
        dryRun: parsed.data.dryRun === true,
      });
      res.status(201).json(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : "workflow run failed";
      const status = message === "workflow_not_found" ? 404 : message === "workflow_not_active" ? 409 : 500;
      res.status(status).json({ error: message });
    }
  });

  router.get("/automations/runs/:runId", (req, res) => {
    const run = getNativeAutomationRun(req.params.runId);
    if (!run) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(run);
  });

  router.post("/automations/workflows/:workflowId/simulate", async (req, res) => {
    const parsed = AutomationRunBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      res.status(201).json(await simulateNativeAutomationWorkflow(req.params.workflowId, parsed.data.input, config));
    } catch (error) {
      const message = error instanceof Error ? error.message : "workflow simulation failed";
      res.status(message === "workflow_not_found" ? 404 : 500).json({ error: message });
    }
  });

  router.get("/automations/workflows/:workflowId/versions", (req, res) => {
    try {
      res.json({ items: listNativeAutomationWorkflowVersions(req.params.workflowId) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "workflow versions failed";
      res.status(message === "workflow_not_found" ? 404 : 500).json({ error: message });
    }
  });

  router.get("/automations/workflows/:workflowId/versions/:version", (req, res) => {
    try {
      const version = Number(req.params.version);
      const item = getNativeAutomationWorkflowVersion(req.params.workflowId, version);
      const previousVersion = version > 1 ? version - 1 : version;
      const diff =
        previousVersion === version
          ? null
          : diffNativeAutomationWorkflowVersions(req.params.workflowId, previousVersion, version);
      res.json({ item, diff });
    } catch (error) {
      const message = error instanceof Error ? error.message : "workflow version failed";
      res.status(message === "workflow_version_not_found" ? 404 : 500).json({ error: message });
    }
  });

  router.post("/automations/workflows/:workflowId/rollback", (req, res) => {
    const parsed = AutomationRollbackBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      res.json(rollbackNativeAutomationWorkflow(req.params.workflowId, parsed.data.version));
    } catch (error) {
      const message = error instanceof Error ? error.message : "workflow rollback failed";
      res.status(message === "workflow_version_not_found" ? 404 : 500).json({ error: message });
    }
  });

  router.post("/automations/workflows/:workflowId/self-heal", (req, res) => {
    try {
      res.json(createWorkflowSelfHealProposal(req.params.workflowId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "workflow self-heal failed";
      res.status(message === "workflow_not_found" ? 404 : 500).json({ error: message });
    }
  });

  router.post("/automations/runs/:runId/resume", async (req, res) => {
    const parsed = AutomationRunResumeBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      res.json(await resumeNativeAutomationRun(req.params.runId, parsed.data.input, config));
    } catch (error) {
      const message = error instanceof Error ? error.message : "workflow resume failed";
      res.status(message === "run_not_found" ? 404 : 500).json({ error: message });
    }
  });

  router.post("/automations/runs/:runId/replay", async (req, res) => {
    const parsed = AutomationRunReplayBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      res
        .status(201)
        .json(
          await replayNativeAutomationRun(
            req.params.runId,
            parsed.data.fromStepIndex,
            parsed.data.inputOverride,
            config,
          ),
        );
    } catch (error) {
      const message = error instanceof Error ? error.message : "workflow replay failed";
      const status = message === "run_not_found" ? 404 : message === "workflow_not_active" ? 409 : 500;
      res.status(status).json({ error: message });
    }
  });

  router.post("/automations/runs/:runId/cancel", (req, res) => {
    const parsed = AutomationRunCancelBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      res.json(cancelNativeAutomationRun(req.params.runId, parsed.data.reason));
    } catch (error) {
      const message = error instanceof Error ? error.message : "workflow cancel failed";
      res.status(message === "run_not_found" ? 404 : 500).json({ error: message });
    }
  });

  router.get("/automations/runs/:runId/evidence-pack", (req, res) => {
    const pack = getNativeAutomationEvidencePack(req.params.runId);
    if (!pack) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(pack);
  });

  router.post("/automations/runs/:runId/evidence-pack", (req, res) => {
    try {
      res.status(201).json(createNativeAutomationEvidencePack(req.params.runId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "evidence pack failed";
      res.status(message === "run_not_found" ? 404 : 500).json({ error: message });
    }
  });

  router.get("/automations/workflows/:workflowId/n8n-export", (req, res) => {
    try {
      res.json(exportNativeWorkflowToN8n(req.params.workflowId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "export failed";
      res.status(message === "workflow_not_found" ? 404 : 500).json({ error: message });
    }
  });

  router.post("/automations/workflows/:workflowId/n8n-sync", async (req, res) => {
    try {
      res.json(await syncNativeWorkflowToN8n(req.params.workflowId, config));
    } catch (error) {
      const message = error instanceof Error ? error.message : "n8n sync failed";
      res.status(message === "workflow_not_found" ? 404 : 500).json({ error: message });
    }
  });

  router.post("/automations/n8n-import", (req, res) => {
    if (!req.principal) { res.status(401).json({ error: "unauthorized" }); return; }
    const parsed = AutomationN8nImportBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    if (parsed.data.tenantId) {
      try { assertTenantAllowed(req.principal, parsed.data.tenantId); } catch (err) { if (denyTenant(res, err)) return; throw err; }
    }
    try {
      const importBody: Parameters<typeof importN8nWorkflow>[0] = {
        workflowJson: parsed.data.workflowJson,
        mode: parsed.data.mode,
        status: parsed.data.status,
      };
      if (parsed.data.tenantId) importBody.tenantId = parsed.data.tenantId;
      if (parsed.data.companyId) importBody.companyId = parsed.data.companyId;
      res.status(201).json(importN8nWorkflow(importBody));
    } catch (error) {
      const message = error instanceof Error ? error.message : "n8n import failed";
      res.status(400).json({ error: message });
    }
  });

  router.post("/automations/ai/draft-template", async (req, res) => {
    if (!req.principal) { res.status(401).json({ error: "unauthorized" }); return; }
    const parsed = AutomationAiDraftBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    if (parsed.data.tenantId) {
      try { assertTenantAllowed(req.principal, parsed.data.tenantId); } catch (err) { if (denyTenant(res, err)) return; throw err; }
    }
    try {
      const draftBody: Parameters<typeof draftAutomationTemplateFromPrompt>[0] = {
        prompt: parsed.data.prompt,
      };
      if (parsed.data.tenantId) draftBody.tenantId = parsed.data.tenantId;
      if (parsed.data.companyId) draftBody.companyId = parsed.data.companyId;
      if (parsed.data.issueId) draftBody.issueId = parsed.data.issueId;
      res.status(201).json(await draftAutomationTemplateFromPrompt(draftBody));
    } catch (error) {
      const message = error instanceof Error ? error.message : "ai draft failed";
      res.status(500).json({ error: message });
    }
  });

  router.post("/automations/runs/:runId/ai-explain", async (req, res) => {
    try {
      res.json(await explainNativeAutomationRun(req.params.runId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "ai explain failed";
      res.status(message === "run_not_found" ? 404 : 500).json({ error: message });
    }
  });



  /**
   * GET /api/admin/trust
   * Returns daemon health, db stats, vault stats, agent counts, and warnings.
   * Enriched with profile, companies, dispatch, backup, and inspector fields.
   * Cached 5s per tenantId. Pass ?fresh=1 to bypass cache.
   */
  router.get("/trust", async (req, res) => {
    try {
      const fresh = req.query["fresh"] === "1";
      const dbPath = join(config.dataDir, "agentworks.db");

      // Load profile (best-effort — may fail if not configured)
      let profile: Awaited<ReturnType<typeof getProfile>> | null = null;
      let profilePath: string | null = null;
      let profileDrift: import("../config/local-profile.schema.js").ProfileDriftCode[] = [];

      try {
        profile = await getProfile();
        profilePath = resolveProfilePath() ?? DEFAULT_ENV_PATH;
        const driftReport = validateAgainstRuntime(profile, {
          dbPath,
          dataDir: config.dataDir,
        });
        profileDrift = [...driftReport.drift];
      } catch {
        // profile unavailable — enriched fields will reflect defaults
      }

      const tenantId = profile?.tenantId ?? "00000000-0000-4000-8000-000000000001";

      // Cache check
      if (!fresh) {
        const cached = getCached(tenantId);
        if (cached !== null) {
          res.json(cached);
          return;
        }
      }

      // Provider health (cached internally at 30s TTL)
      let providers: ProviderStatus[] = [];
      try {
        const healthStatus = await getProviderHealthService().getStatus();
        providers = healthStatus.providers;
      } catch {
        // ignore — trust endpoint must not fail because a provider is unreachable
      }

      const response = await aggregateTrust({
        daemonVersion: PACKAGE_VERSION,
        dbPath,
        profile,
        profilePath,
        profileDrift,
        providers,
      });

      if (!fresh) {
        setCached(tenantId, response);
      }

      res.json(response);
    } catch (err) {
      res.status(500).json({
        error: "trust_aggregation_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Cleanup duplicate agent registry records.
  router.post("/cleanup-duplicate-agents", cleanupDuplicateAgents);

  interface DuplicateAgentGroup {
    tenant_id: string;
    name: string;
    count: number;
  }

  interface DuplicateAgentRow {
    id: string;
    name: string;
  }

  function cleanupDuplicateAgents(_req: Request, res: Response): void {
    const sqlite = getSqlite();
    const results: string[] = [];

    const duplicateGroups = sqlite
      .prepare(
        `SELECT tenant_id, name, COUNT(*) as count
         FROM execution_agents
         GROUP BY tenant_id, name
         HAVING count > 1`,
      )
      .all() as DuplicateAgentGroup[];

    for (const group of duplicateGroups) {
      const agents = sqlite
        .prepare(
          `SELECT id, name
           FROM execution_agents
           WHERE tenant_id = ? AND name = ?
           ORDER BY created_at ASC`,
        )
        .all(group.tenant_id, group.name) as DuplicateAgentRow[];

      for (const agent of agents.slice(1)) {
        sqlite
          .prepare("UPDATE execution_agents SET status = 'retired' WHERE id = ?")
          .run(agent.id);
        results.push(`Retired agent ${agent.name} (id=${agent.id})`);
      }
    }

    res.json({ success: true, results });
  }

  router.use("/issue-preview", issuePreviewRouter);

return router;
}
