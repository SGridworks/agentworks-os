/**
 * Memory routes — n8n-friendly REST wrappers around the tenant vault.
 *
 * The MCP server (routes/mcp.ts) exposes `memory.read` and `memory.write`
 * for MCP-aware clients (Claude Desktop, Cursor, Codex). These two routes
 * provide the same operations over plain HTTP for n8n custom nodes and
 * any other workflow tool that doesn't speak MCP.
 *
 * Both endpoints are tenant-scoped via the FileVaultStore — a tenant only
 * ever sees its own pages, even if it crafts a key that looks like another
 * tenant's path. Path traversal (`..`, leading `/`) is rejected by the
 * store with a thrown error which we surface as 400.
 *
 * POST /api/memory/read   { tenantId, key }                → page body + meta
 * POST /api/memory/write  { tenantId, key, body, mode? }   → write receipt
 */

import { Router } from "express";
import { z } from "zod";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  FileVaultStore,
  type VaultStore,
  type VaultWriteOptions,
  OperatorMemoryStore,
  OperatorMemoryError,
  lintVault,
  ALL_LINT_KINDS,
  type LintKind,
  buildVaultMetadataIndex,
  wordCount,
  UsageTracker,
} from "@agentworks/memory";
import { EmbedClient } from "../services/embed-client.js";
import { hybridSearch } from "../services/retrieval.js";
import { recordInsight, listInsights, updateInsight, archiveInsight } from "../services/insights.js";
import { rebuildHotMd } from "../services/hot-md-builder.js";
import {
  readPreviousReport,
  writeReportToHistory,
  diffAdded,
  diffRemoved,
  diffSummary,
} from "../services/lint-history.js";
import { loadPackFromFile } from "@agentworks/policy-engine";
import type { RulePack } from "@agentworks/shared";
import { getDb } from "../db/index.js";
import { getProvenance } from "../services/provenance.js";
import type { Config } from "../config.js";

function vaultRootDir(): string {
  return process.env.VAULT_ROOT ?? join(homedir(), "vault");
}

let _vaultStore: VaultStore | null = null;
export function getVaultStore(): VaultStore {
  if (_vaultStore) return _vaultStore;
  _vaultStore = new FileVaultStore({ root: vaultRootDir() });
  return _vaultStore;
}

let _usageTracker: UsageTracker | null = null;
function getUsageTracker(): UsageTracker {
  if (_usageTracker) return _usageTracker;
  _usageTracker = new UsageTracker(getVaultStore() as FileVaultStore, {
    batchSize: 50,
    flushIntervalMs: 3000, // 3 seconds
  });
  return _usageTracker;
}

// Test-only escape hatch — vitest needs to reset the singleton between
// suites that point at different VAULT_ROOTs. Prod code never calls this.
export function _resetVaultStoreForTesting(): void {
  _vaultStore = null;
  _usageTracker = null;
}

let _operatorStore: OperatorMemoryStore | null = null;
function getOperatorStore(): OperatorMemoryStore {
  if (_operatorStore) return _operatorStore;
  _operatorStore = new OperatorMemoryStore();
  return _operatorStore;
}

export function _resetOperatorStoreForTesting(): void {
  _operatorStore = null;
}

function inferKind(fmType: string | undefined, dir: string): string {
  if (fmType === "policy" || fmType === "runbook" || fmType === "template" || fmType === "evidence" || fmType === "schema" || fmType === "log" || fmType === "note") {
    return fmType;
  }
  if (dir.includes("policies")) return "policy";
  if (dir.includes("runbooks")) return "runbook";
  if (dir.includes("templates")) return "template";
  if (dir.includes("evidence")) return "evidence";
  if (dir.includes("schemas")) return "schema";
  if (dir.includes("logs") || dir.includes("audit")) return "log";
  return "note";
}

export function createMemoryRouter(_config: Config): Router {
  const router = Router();

  // Clean up usage tracker on process exit
  process.on('exit', () => {
    if (_usageTracker) {
      _usageTracker.destroy();
    }
  });

  process.on('SIGINT', () => {
    if (_usageTracker) {
      _usageTracker.destroy();
    }
  });

  process.on('SIGTERM', () => {
    if (_usageTracker) {
      _usageTracker.destroy();
    }
  });

  const ReadRequestSchema = z.object({
    tenantId: z.string().uuid(),
    key: z.string().min(1),
    actorId: z.string().optional(),

  });

  const WriteRequestSchema = z.object({
    tenantId: z.string().uuid(),
    key: z.string().min(1),
    body: z.string(),
    mode: z.enum(["replace", "append"]).default("replace"),
    actorId: z.string().optional(),

  });

  router.post("/read", async (req, res) => {
    const parsed = ReadRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const { tenantId, key, actorId } = parsed.data;
    try {
      const r = await getVaultStore().read(tenantId, key);
      

      if (actorId && r.existed) {
        getUsageTracker().recordUsage(tenantId, key, actorId);
      }
      
      res.status(200).json({
        ok: true,
        data: {
          tenantId: r.tenantId,
          key: r.key,
          body: r.body,
          sha256: r.sha256,
          updatedAt: r.updatedAt,
          existed: r.existed,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "vault read failed";
      res.status(400).json({ ok: false, error: message });
    }
  });

  const GraphRequestSchema = z.object({
    tenantId: z.string().uuid(),
  });

  router.get("/graph", async (req, res) => {
    const parsed = GraphRequestSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const { tenantId } = parsed.data;
    try {
      const index = await buildVaultMetadataIndex(vaultRootDir(), tenantId);

      const dirHueMap = new Map<string, number>();
      const dirCount = new Map<string, number>();
      const goldenAngle = 137.508;

      const notes = index.pages.map((p) => {
        const segments = p.key.split("/");
        const dir = segments.length > 1 ? segments.slice(0, -1).join("/") : "";
        const top = dir.split("/")[0] ?? "(root)";
        if (!dirHueMap.has(top)) {
          dirHueMap.set(top, (dirHueMap.size * goldenAngle) % 360);
        }
        dirCount.set(dir, (dirCount.get(dir) ?? 0) + 1);

        const fmType = typeof p.frontmatter["type"] === "string" ? p.frontmatter["type"].toLowerCase() : undefined;
        const kind = inferKind(fmType, dir);

        return {
          id: p.key,
          title: p.title || segments[segments.length - 1] || p.key,
          dir,
          kind,
          tags: p.tags,
          chars: p.bytes,
          edited: p.updatedAt,
          outgoing: 0,
          backlinks: 0,
          unresolvedOutgoing: p.links.filter((link) => !link.resolved).length,
        };
      });

      const edgeSet = new Set<string>();
      const outCount = new Map<string, number>();
      const inCount = new Map<string, number>();

      for (const link of index.links) {
        if (!link.targetKey || link.targetKey === link.source) continue;
        const sig = `${link.source}\0${link.targetKey}`;
        if (edgeSet.has(sig)) continue;
        edgeSet.add(sig);
        outCount.set(link.source, (outCount.get(link.source) ?? 0) + 1);
        inCount.set(link.targetKey, (inCount.get(link.targetKey) ?? 0) + 1);
      }
      const edges = Array.from(edgeSet).map((sig) => sig.split("\0") as [string, string]);

      for (const n of notes) {
        n.outgoing = outCount.get(n.id) ?? 0;
        n.backlinks = inCount.get(n.id) ?? 0;
      }

      const dirs = Array.from(dirCount.entries()).map(([dir, count]) => ({
        dir,
        count,
        hue: dirHueMap.get(dir.split("/")[0] ?? "") ?? 0,
      }));

      res.status(200).json({
        ok: true,
        data: {
          tenantId,
          notes,
          edges,
          dirs,
          generatedAt: index.generatedAt,
          unresolvedLinks: index.unresolvedLinks.length,
          duplicateSlugs: index.duplicateSlugs.length,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "vault graph failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  router.get("/metadata", async (req, res) => {
    const parsed = GraphRequestSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const index = await buildVaultMetadataIndex(vaultRootDir(), parsed.data.tenantId);
      res.status(200).json({ ok: true, data: index.toJSON() });
    } catch (err) {
      const message = err instanceof Error ? err.message : "vault metadata failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  // Operator (claude-code) memory — read-only bridge to ~/vault/memory/.
  // No tenant isolation: this is the operator's own cross-project memory.
  router.get("/operator", async (_req, res) => {
    try {
      const entries = await getOperatorStore().list();
      res.status(200).json({ ok: true, data: { count: entries.length, entries } });
    } catch (err) {
      const message = err instanceof Error ? err.message : "operator list failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  const OperatorReadRequestSchema = z.object({
    key: z.string().min(1),
  });

  router.post("/operator/read", async (req, res) => {
    const parsed = OperatorReadRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const r = await getOperatorStore().read(parsed.data.key);
      res.status(200).json({ ok: true, data: r });
    } catch (err) {
      if (err instanceof OperatorMemoryError) {
        res.status(400).json({ ok: false, error: err.code, message: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : "operator read failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  let embedClient: EmbedClient | null = null;
  const getEmbed = (): EmbedClient => {
    if (!embedClient) embedClient = new EmbedClient();
    return embedClient;
  };

  const SearchRequestSchema = z.object({
    tenantId: z.string().uuid(),
    query: z.string().min(1).max(2000),
    topK: z.number().int().positive().max(200).optional(),
    kinds: z.array(z.enum(["episode", "insight"])).optional(),
  });

  const InsightRequestSchema = z.object({
    tenantId: z.string().uuid(),
    frameType: z.enum(["preference", "fact", "plan", "constraint", "feedback", "error_pattern"]),
    content: z.string().min(1).max(4000),
    source: z.enum(["agent_reflection", "user_correction", "task_outcome", "manual"]),
    subject: z.string().max(240).optional(),
    episodeId: z.string().uuid().optional(),
    importance: z.number().int().min(1).max(5).optional(),
    validated: z.boolean().optional(),
  });

  router.post("/insight", async (req, res) => {
    const parsed = InsightRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const sqlite = (getDb() as unknown as { $client: import("better-sqlite3").Database }).$client;
      const r = await recordInsight(sqlite, parsed.data, { embedClient: getEmbed() });
      res.status(201).json({ ok: true, data: r });
    } catch (err) {
      const message = err instanceof Error ? err.message : "record_insight failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  const ListInsightsQuerySchema = z.object({
    tenantId: z.string().uuid(),
    frameType: z
      .enum(["preference", "fact", "plan", "constraint", "feedback", "error_pattern"])
      .optional(),
    subject: z.string().max(240).optional(),
    lifecycle: z.enum(["active", "archived", "invalidated"]).optional(),
    limit: z.coerce.number().int().positive().max(1000).optional(),
  });

  router.get("/insight", (req, res) => {
    const parsed = ListInsightsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const sqlite = (getDb() as unknown as { $client: import("better-sqlite3").Database }).$client;
      const rows = listInsights(sqlite, parsed.data);
      res.status(200).json({ ok: true, data: { count: rows.length, items: rows } });
    } catch (err) {
      const message = err instanceof Error ? err.message : "list_insights failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  const UpdateInsightSchema = z.object({
    tenantId: z.string().uuid(),
    content: z.string().min(1).max(4000).optional(),
    validated: z.boolean().optional(),
    importance: z.number().int().min(1).max(5).optional(),
    subject: z.string().max(240).nullable().optional(),
  });

  router.patch("/insight/:id", (req, res) => {
    const id = String(req.params.id);
    const parsed = UpdateInsightSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const sqlite = (getDb() as unknown as { $client: import("better-sqlite3").Database }).$client;
      const { tenantId, ...rest } = parsed.data;
      const updated = updateInsight(sqlite, tenantId, id, rest);
      res.status(200).json({ ok: true, data: updated });
    } catch (err) {
      const message = err instanceof Error ? err.message : "update_insight failed";
      const status = message === "insight not found" ? 404 : 500;
      res.status(status).json({ ok: false, error: message });
    }
  });

  const ArchiveInsightSchema = z.object({ tenantId: z.string().uuid() });

  router.delete("/insight/:id", (req, res) => {
    const id = String(req.params.id);
    const parsed = ArchiveInsightSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const sqlite = (getDb() as unknown as { $client: import("better-sqlite3").Database }).$client;
      archiveInsight(sqlite, parsed.data.tenantId, id);
      res.status(200).json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "archive_insight failed";
      const status = message.includes("not found") ? 404 : 500;
      res.status(status).json({ ok: false, error: message });
    }
  });

  router.post("/search", async (req, res) => {
    const parsed = SearchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const sqlite = (getDb() as unknown as { $client: import("better-sqlite3").Database }).$client;
      const hits = await hybridSearch(sqlite, getEmbed(), parsed.data);
      res.status(200).json({
        ok: true,
        data: { tenantId: parsed.data.tenantId, query: parsed.data.query, count: hits.length, hits },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "search failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  const LintKindEnum = z.enum(ALL_LINT_KINDS as [LintKind, ...LintKind[]]);

  const LintQuerySchema = z.object({
    tenantId: z.string().uuid(),
    /**
     * Optional subset of LintKind to run. Default: all 11. Repeat the
     * param or pass a comma-separated list:
     *   ?checks=source_drift&checks=page_oversize
     *   ?checks=source_drift,page_oversize
     *
     * Unknown check names are rejected with 400 — a silently-ignored
     * typo would mask a missing lint pass.
     */
    checks: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((v, ctx) => {
        if (!v) return undefined;
        const raw = Array.isArray(v) ? v.join(",") : v;
        const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
        const out: LintKind[] = [];
        for (const p of parts) {
          const r = LintKindEnum.safeParse(p);
          if (!r.success) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `unknown check name: '${p}'. Valid: ${ALL_LINT_KINDS.join(", ")}`,
            });
            return z.NEVER;
          }
          out.push(r.data);
        }
        return out;
      }),
  });

  router.get("/lint", async (req, res) => {
    const parsed = LintQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const report = await lintVault(vaultRootDir(), parsed.data.tenantId, {
        ...(parsed.data.checks ? { checks: parsed.data.checks } : {}),
      });
      // Best-effort history write. Failures here must not break the
      // /lint response (lint is read-only against the vault; the
      // history write is a side effect).
      try {
        const historyDir = join(vaultRootDir(), parsed.data.tenantId, "wiki", "lint-history");
        await writeReportToHistory(historyDir, report);
      } catch (historyErr) {
        // Log to console; do not surface to caller.
        // eslint-disable-next-line no-console
        console.warn("[memory/lint] history write failed:", historyErr);
      }
      res.status(200).json({ ok: true, data: report });
    } catch (err) {
      const message = err instanceof Error ? err.message : "vault lint failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  // /lint/diff?tenantId=…&since=<runId|isoTimestamp>
  //
  // File-history-based delta. The lint report is itself the audit log:
  // we cache the most recent report per tenant under
  // `<vaultRoot>/<tenantId>/wiki/lint-history/<runId>-<iso>.json` and
  // serve the diff against `since`.
  //
  // **Baseline matching:** the previous report must have the SAME
  // `executed` check set as the current run. A subset run does not
  // diff against a full run, and vice versa — the finding sets are
  // not comparable (a full run has findings the subset never even
  // looked for; comparing them as "added" would be a lie).
  //
  // If no matching baseline exists, the response includes
  //   { baseline: null, reason: "no_matching_baseline", ... }
  // instead of a fake diff.
  //
  // `since` accepts:
  //   - a 16-char runId (exact match against a stored report)
  //   - an ISO timestamp (the most recent stored report strictly
  //     older that ALSO matches the executed set)
  //   - omit for "diff against the most recent matching report"
  const LintDiffQuerySchema = z.object({
    tenantId: z.string().uuid(),
    since: z.string().min(1).max(64).optional(),
  });

  router.get("/lint/diff", async (req, res) => {
    const parsed = LintDiffQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const { tenantId, since } = parsed.data;
    try {
      const historyDir = join(vaultRootDir(), tenantId, "wiki", "lint-history");
      // The current run is always a full run — /lint/diff only
      // compares full→full by default. Subset diffs require
      // ?checks=<subset> on /lint/diff itself (handled by the
      // LintDiffWithChecksSchema below).
      const current = await lintVault(vaultRootDir(), tenantId);
      const previous = await readPreviousReport(historyDir, since, current.executed);
      res.status(200).json({
        ok: true,
        data: {
          tenantId,
          currentRunId: current.runId,
          currentRanAt: current.ranAt,
          currentExecuted: current.executed,
          previousRunId: previous?.runId ?? null,
          previousRanAt: previous?.ranAt ?? null,
          previousExecuted: previous?.executed ?? null,
          baselineReason: previous ? null : "no_matching_baseline",
          added: previous ? diffAdded(previous, current) : [],
          removed: previous ? diffRemoved(previous, current) : [],
          summary: previous ? diffSummary(previous, current) : null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "lint diff failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  // /lint/diff with an explicit `checks` subset. Compares a
  // current subset run against the most recent prior subset run
  // with the same executed set. Same baseline-matching rules as
  // the full-only /lint/diff above.
  const LintDiffWithChecksQuerySchema = LintQuerySchema.extend({
    since: z.string().min(1).max(64).optional(),
  });

  router.get("/lint/diff/subset", async (req, res) => {
    const parsed = LintDiffWithChecksQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const { tenantId, since, checks } = parsed.data;
    try {
      const historyDir = join(vaultRootDir(), tenantId, "wiki", "lint-history");
      const current = await lintVault(vaultRootDir(), tenantId, {
        ...(checks ? { checks } : {}),
      });
      // Resolve the baseline BEFORE persisting the current run,
      // otherwise readPreviousReport would see the just-written
      // current report as the "previous" and diff against itself.
      const previous = await readPreviousReport(historyDir, since, current.executed);
      // Persist the subset run so future diffs have a baseline to
      // match against. Subset reports are first-class — the MCP
      // wrapper and admin UI drawer will subscribe to narrow check
      // sets and need history to diff against.
      try {
        await writeReportToHistory(historyDir, current);
      } catch (historyErr) {
        // eslint-disable-next-line no-console
        console.warn("[memory/lint/diff/subset] history write failed:", historyErr);
      }
      res.status(200).json({
        ok: true,
        data: {
          tenantId,
          currentRunId: current.runId,
          currentRanAt: current.ranAt,
          currentExecuted: current.executed,
          previousRunId: previous?.runId ?? null,
          previousRanAt: previous?.ranAt ?? null,
          previousExecuted: previous?.executed ?? null,
          baselineReason: previous ? null : "no_matching_baseline",
          added: previous ? diffAdded(previous, current) : [],
          removed: previous ? diffRemoved(previous, current) : [],
          summary: previous ? diffSummary(previous, current) : null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "lint subset diff failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  const HotCacheQuerySchema = z.object({
    tenantId: z.string().uuid(),
  });

  router.get("/hot-cache", async (req, res) => {
    const parsed = HotCacheQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const r = await getVaultStore().read(parsed.data.tenantId, "hot");
      res.status(200).json({
        ok: true,
        data: {
          tenantId: parsed.data.tenantId,
          key: "hot",
          existed: r.existed,
          updatedAt: r.updatedAt,
          words: r.existed ? wordCount(r.body) : 0,
          body: r.body,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "hot-cache read failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  const HotCacheRebuildSchema = z.object({
    tenantId: z.string().uuid(),
  });

  router.post("/hot-cache/rebuild", async (req, res) => {
    const parsed = HotCacheRebuildSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const db = getDb();
      const vault = getVaultStore();
      const packsDir = process.env.RULE_PACKS_DIR ?? join(process.cwd(), "rule-packs");
      let packs: RulePack[] = [];
      try {
        const pack = await loadPackFromFile(packsDir);
        packs = [pack];
      } catch {
        packs = [];
      }
      const result = await rebuildHotMd({
        db,
        vault,
        tenantId: parsed.data.tenantId,
        packs,
      });
      res.status(200).json({
        ok: true,
        data: {
          tenantId: parsed.data.tenantId,
          words: result.words,
          path: result.path,
          rebuiltAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "hot-cache rebuild failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  router.post("/write", async (req, res) => {
    const parsed = WriteRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const { tenantId, key, body, mode, actorId } = parsed.data;
    
    // Build write options with provenance tracking
    const writeOptions: VaultWriteOptions = { mode };
    if (actorId) {
      writeOptions.lastUpdatedBy = actorId;
      writeOptions.lastUpdatedAt = new Date().toISOString();
    }
    
    try {
      const w = await getVaultStore().write(tenantId, key, body, writeOptions);
      res.status(201).json({
        ok: true,
        data: {
          tenantId: w.tenantId,
          key: w.key,
          bytesWritten: w.bytesWritten,
          sha256: w.sha256,
          updatedAt: w.updatedAt,
          mode,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "vault write failed";
      res.status(400).json({ ok: false, error: message });
    }
  });

  const ProvenanceQuerySchema = z.object({
    tenantId: z.string().uuid(),
    key: z.string().min(1).max(512),
  });

  router.get("/provenance", async (req, res) => {
    const parsed = ProvenanceQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const { tenantId, key } = parsed.data;
    try {
      const provenance = await getProvenance(tenantId, key);
      // For now, we always return provenance data even if document doesn't exist
      // This will be updated when vault store integration is complete
      res.status(200).json({
        ok: true,
        data: provenance,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "provenance query failed";
      res.status(500).json({ ok: false, error: message });
    }
  });

  return router;
}
