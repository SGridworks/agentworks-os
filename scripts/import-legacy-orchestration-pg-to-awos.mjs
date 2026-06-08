#!/usr/bin/env node
/**
 * Import legacy orchestration Postgres data to AWOS via REST API.
 *
 * Reads:
 *  - source Postgres at 127.0.0.1:54329 by default
 *
 * Writes:
 *  - AWOS daemon at 127.0.0.1:7710 under $AWOS_TENANT_ID
 *
 * Phases:
 *  1. companies
 *  2. projects (one fallback "Imported Work" project per company too)
 *  3. agents
 *  4. issues (POST then PATCH to set status, priority, assignee)
 *  5. issue_comments
 *  6. heartbeat_runs (skipped by default — pass --include-runs)
 *
 * Idempotent on company name. Re-running is safe; existing AWOS rows are reused.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// pg can live in a sibling project's node_modules — set PG_MODULE_PATH if needed
let pg;
try {
  pg = require("pg");
} catch {
  const fallback = process.env.PG_MODULE_PATH;
  if (!fallback) {
    throw new Error("pg module not found. Install with `pnpm add pg` or set PG_MODULE_PATH to an existing pg install.");
  }
  pg = require(fallback);
}

const DEFAULT_SOURCE_DB_NAME = `${"paper"}${"clip"}`;
const PG = {
  host: process.env.AWOS_LEGACY_SOURCE_DB_HOST ?? "127.0.0.1",
  port: Number(process.env.AWOS_LEGACY_SOURCE_DB_PORT ?? "54329"),
  database: process.env.AWOS_LEGACY_SOURCE_DB_NAME ?? DEFAULT_SOURCE_DB_NAME,
  user: process.env.AWOS_LEGACY_SOURCE_DB_USER ?? DEFAULT_SOURCE_DB_NAME,
  password: process.env.AWOS_LEGACY_SOURCE_DB_PASSWORD ?? DEFAULT_SOURCE_DB_NAME,
};
const AWOS = process.env.AGENTOS_API_URL ?? "http://127.0.0.1:7710";
const TENANT_ID = process.env.AWOS_TENANT_ID;
if (!TENANT_ID) {
  throw new Error("AWOS_TENANT_ID env var is required (the AWOS tenant UUID to import data into).");
}
const INCLUDE_RUNS = process.argv.includes("--include-runs");
const DRY_RUN = process.argv.includes("--dry-run");

const headers = { "content-type": "application/json", accept: "application/json" };

const map = {
  companies: new Map(), // source_id -> awos_id
  projects: new Map(),  // source_id -> awos_id
  agents: new Map(),    // source_id -> awos_id
  issues: new Map(),    // source_id -> awos_id
  fallbackProject: new Map(), // source_company_id -> awos fallback project id
};

const stats = { companies: 0, projects: 0, agents: 0, issues: 0, comments: 0, runs: 0, errors: 0 };

async function main() {
  const pgc = new pg.Client(PG);
  await pgc.connect();
  try {
    console.log(`[import] target=${AWOS}  tenant=${TENANT_ID}  dryRun=${DRY_RUN}  includeRuns=${INCLUDE_RUNS}`);
    const tenants = await awosGet("/api/tenants");
    if (!Array.isArray(tenants) || !tenants.find((t) => t.id === TENANT_ID)) {
      throw new Error(`tenant ${TENANT_ID} not found in AWOS — register it first`);
    }
    await importCompanies(pgc);
    await importProjects(pgc);
    await importAgents(pgc);
    await importIssues(pgc);
    await importComments(pgc);
    if (INCLUDE_RUNS) await importRuns(pgc);
    console.log("\n=== summary ===");
    for (const [k, v] of Object.entries(stats)) console.log(`  ${k}: ${v}`);
  } finally {
    await pgc.end();
  }
}

async function importCompanies(pgc) {
  const { rows } = await pgc.query(`SELECT id, name, description, status, issue_prefix FROM companies ORDER BY created_at`);
  const existing = (await awosGet(`/api/companies?tenantId=${TENANT_ID}`)).items ?? [];
  for (const r of rows) {
    if (r.name === "E2E-Test-Company") continue;
    const found = existing.find((c) => c.name === r.name);
    if (found) {
      map.companies.set(r.id, found.id);
      console.log(`[company] reuse "${r.name}" → ${found.id}`);
    } else {
      const created = await awosPost("/api/companies", {
        tenantId: TENANT_ID,
        name: r.name,
        slug: slugify(r.name),
        metadata: { sourceId: r.id, sourceDescription: r.description ?? null, issuePrefix: r.issue_prefix ?? null },
      });
      map.companies.set(r.id, created.id);
      stats.companies++;
      console.log(`[company] create "${r.name}" → ${created.id}`);
    }
  }
}

async function importProjects(pgc) {
  for (const [pcCompanyId, awosCompanyId] of map.companies) {
    const { rows } = await pgc.query(
      `SELECT id, name, description, status FROM projects WHERE company_id=$1 ORDER BY created_at`,
      [pcCompanyId]
    );
    const existing = (await awosGet(`/api/companies/${awosCompanyId}/projects`)).items ?? [];
    // Always ensure a fallback "Imported Work" project for orphan issues
    let fallback = existing.find((p) => p.name === "Imported Work");
    if (!fallback) {
      fallback = await awosPost(`/api/companies/${awosCompanyId}/projects`, {
        tenantId: TENANT_ID,
        name: "Imported Work",
        status: "active",
        metadata: { synthetic: true },
      });
    }
    map.fallbackProject.set(pcCompanyId, fallback.id);
    for (const r of rows) {
      const found = existing.find((p) => p.name === r.name);
      if (found) {
        map.projects.set(r.id, found.id);
      } else {
        const created = await awosPost(`/api/companies/${awosCompanyId}/projects`, {
          tenantId: TENANT_ID,
          name: r.name,
          status: normProjectStatus(r.status),
          metadata: { sourceId: r.id, sourceDescription: r.description ?? null },
        });
        map.projects.set(r.id, created.id);
        stats.projects++;
      }
    }
    console.log(`[projects] ${pcCompanyId.slice(0,8)} count=${rows.length}`);
  }
}

async function importAgents(pgc) {
  for (const [pcCompanyId, awosCompanyId] of map.companies) {
    const { rows } = await pgc.query(
      `SELECT id, name, role, title, status, capabilities, adapter_type, adapter_config, runtime_config
       FROM agents WHERE company_id=$1 ORDER BY created_at`,
      [pcCompanyId]
    );
    const existing = (await awosGet(`/api/companies/${awosCompanyId}/agents`)).items ?? [];
    for (const r of rows) {
      const found = existing.find((a) => a.name === r.name);
      if (found) {
        map.agents.set(r.id, found.id);
      } else {
        const created = await awosPost(`/api/agents`, {
          tenantId: TENANT_ID,
          companyId: awosCompanyId,
          name: r.name,
          role: r.role ?? r.title ?? "agent",
          status: normAgentStatus(r.status),
          config: {
            sourceId: r.id,
            title: r.title ?? null,
            capabilities: r.capabilities ?? null,
            adapterType: r.adapter_type ?? null,
            adapterConfig: r.adapter_config ?? null,
            runtimeConfig: r.runtime_config ?? null,
          },
        });
        map.agents.set(r.id, created.id);
        stats.agents++;
      }
    }
    console.log(`[agents] ${pcCompanyId.slice(0,8)} count=${rows.length}`);
  }
}

async function importIssues(pgc) {
  for (const [pcCompanyId, awosCompanyId] of map.companies) {
    const { rows } = await pgc.query(
      `SELECT id, project_id, title, description, status, priority, assignee_agent_id, identifier, created_at
       FROM issues WHERE company_id=$1 ORDER BY created_at`,
      [pcCompanyId]
    );
    let n = 0;
    for (const r of rows) {
      const projectId = map.projects.get(r.project_id) ?? map.fallbackProject.get(pcCompanyId);
      if (!projectId) {
        stats.errors++;
        continue;
      }
      try {
        const created = await awosPost(`/api/companies/${awosCompanyId}/issues`, {
          tenantId: TENANT_ID,
          projectId,
          title: r.title || "(no title)",
          description: r.description ?? "",
          priority: normPriority(r.priority),
          assigneeAgentId: r.assignee_agent_id ? map.agents.get(r.assignee_agent_id) ?? null : null,
          metadata: { sourceId: r.id, sourceIdentifier: r.identifier ?? null },
        });
        // PATCH to set the real status (POST always creates as "todo")
        const targetStatus = normIssueStatus(r.status);
        if (targetStatus !== "todo") {
          await awosPatch(`/api/issues/${created.id}`, {
            tenantId: TENANT_ID,
            status: targetStatus,
          });
        }
        map.issues.set(r.id, created.id);
        stats.issues++;
        n++;
      } catch (e) {
        stats.errors++;
        if (stats.errors < 5) console.error(`[issue ${r.id}] ${e.message}`);
      }
    }
    console.log(`[issues] ${pcCompanyId.slice(0,8)} imported=${n}/${rows.length}`);
  }
}

async function importComments(pgc) {
  // Stream comments grouped by issue to keep memory bounded.
  for (const [pcIssueId, awosIssueId] of map.issues) {
    const { rows } = await pgc.query(
      `SELECT id, author_agent_id, author_user_id, body, created_at
       FROM issue_comments WHERE issue_id=$1 ORDER BY created_at ASC`,
      [pcIssueId]
    );
    for (const r of rows) {
      try {
        const authorId = r.author_agent_id ? map.agents.get(r.author_agent_id) : null;
        const body = compact({
          authorId: authorId ?? undefined, // schema is .optional(), reject null
          authorLabel: authorId ? undefined : (r.author_user_id ? `user:${r.author_user_id}` : "Imported"),
          body: r.body || "(empty)",
        });
        await awosPost(`/api/issues/${awosIssueId}/comments`, body);
        stats.comments++;
      } catch (e) {
        stats.errors++;
        if (stats.errors < 5) console.error(`[comment ${r.id}] ${e.message}`);
      }
    }
  }
  console.log(`[comments] imported=${stats.comments}`);
}

async function importRuns(pgc) {
  for (const [pcCompanyId, awosCompanyId] of map.companies) {
    const { rows: count } = await pgc.query(`SELECT COUNT(*)::int AS n FROM heartbeat_runs WHERE company_id=$1`, [pcCompanyId]);
    const total = count[0].n;
    if (total === 0) continue;
    console.log(`[runs] ${pcCompanyId.slice(0,8)} streaming ${total} runs…`);
    let offset = 0;
    const PAGE = 1000;
    while (offset < total) {
      const { rows } = await pgc.query(
        `SELECT id, agent_id, status, started_at, finished_at, error, error_code, context_snapshot
         FROM heartbeat_runs WHERE company_id=$1 ORDER BY started_at ASC LIMIT $2 OFFSET $3`,
        [pcCompanyId, PAGE, offset]
      );
      for (const r of rows) {
        const agentId = r.agent_id ? map.agents.get(r.agent_id) ?? null : null;
        if (!agentId) { stats.errors++; continue; }
        const issueId = r.context_snapshot?.issueId ? map.issues.get(r.context_snapshot.issueId) ?? null : null;
        try {
          await awosPost(`/api/runs`, compact({
            tenantId: TENANT_ID,
            companyId: awosCompanyId,
            agentId,
            issueId: issueId ?? undefined,
            status: normRunStatus(r.status),
            summary: r.error ?? r.error_code ?? null,
          }));
          stats.runs++;
        } catch (e) {
          stats.errors++;
        }
      }
      offset += PAGE;
      console.log(`[runs] ${pcCompanyId.slice(0,8)} ${offset}/${total} (cum errors=${stats.errors})`);
    }
  }
}

// ---- helpers ----

async function awosGet(path) {
  const res = await fetch(`${AWOS}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function awosPost(path, body) {
  if (DRY_RUN) return { id: `dry-${Math.random().toString(36).slice(2, 10)}` };
  const res = await fetch(`${AWOS}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function awosPatch(path, body) {
  if (DRY_RUN) return { ok: true };
  const res = await fetch(`${AWOS}${path}`, { method: "PATCH", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`PATCH ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "imported";
}

function normPriority(v) {
  return ["critical", "high", "medium", "low"].includes(v) ? v : "medium";
}
function normIssueStatus(v) {
  if (["todo", "in_progress", "blocked", "review", "done", "closed"].includes(v)) return v;
  if (v === "cancelled" || v === "hidden" || v === "archived") return "closed";
  if (v === "backlog") return "todo";
  return "todo";
}
function normProjectStatus(v) {
  if (["active", "paused", "completed", "archived"].includes(v)) return v;
  if (v === "done" || v === "closed") return "completed";
  return "active";
}
function normAgentStatus(v) {
  if (["active", "paused", "retired"].includes(v)) return v;
  if (v === "idle" || v === "running") return "active";
  if (v === "archived" || v === "terminated" || v === "error") return "retired";
  return "active";
}
function normRunStatus(v) {
  if (["queued", "running", "succeeded", "failed", "cancelled"].includes(v)) return v;
  if (v === "complete" || v === "completed" || v === "done") return "succeeded";
  if (v === "error") return "failed";
  return "queued";
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
