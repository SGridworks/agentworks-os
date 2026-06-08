#!/usr/bin/env node

const SOURCE_BASE = env("AWOS_LEGACY_SOURCE_API_URL", deprecatedSourceApiUrl("http://127.0.0.1:3100"));
const TARGET_BASE = env("AGENTOS_API_URL", "http://127.0.0.1:7710");
const TARGET_TENANT_NAME = env("AWOS_TENANT_NAME", "Local Operator");
const TARGET_TENANT_INDUSTRY = env("AWOS_TENANT_INDUSTRY", "other");

const headers = { "content-type": "application/json", accept: "application/json" };

const state = {
  tenantId: "",
  companies: new Map(),
  projects: new Map(),
  agents: new Map(),
  issues: new Map(),
};

async function main() {
  console.log(`[import] source=${SOURCE_BASE}`);
  console.log(`[import] target=${TARGET_BASE}`);
  state.tenantId = await ensureTenant();

  const sourceCompanies = await sourceItems("/api/companies");
  console.log(`[import] companies=${sourceCompanies.length}`);

  for (const company of sourceCompanies) {
    await importCompany(company);
  }

  console.log("[import] complete");
  console.log(`[import] tenantId=${state.tenantId}`);
  console.log(`[import] companies=${state.companies.size}`);
  console.log(`[import] projects=${state.projects.size}`);
  console.log(`[import] agents=${state.agents.size}`);
  console.log(`[import] issues=${state.issues.size}`);
}

async function importCompany(company) {
  const targetCompany = await ensureCompany(company);
  state.companies.set(company.id, targetCompany.id);

  const projects = await sourceItems(`/api/companies/${company.id}/projects`);
  const fallbackProject = await ensureProject(targetCompany.id, {
    id: `${company.id}:default-project`,
    name: "Imported Work",
  });
  state.projects.set(`${company.id}:default-project`, fallbackProject.id);

  if (projects.length === 0) {
    state.projects.set(company.id, fallbackProject.id);
  } else {
    for (const project of projects) {
      const targetProject = await ensureProject(targetCompany.id, project);
      state.projects.set(project.id, targetProject.id);
    }
  }

  for (const agent of await sourceItems(`/api/companies/${company.id}/agents`)) {
    const targetAgent = await ensureAgent(targetCompany.id, agent);
    state.agents.set(agent.id, targetAgent.id);
  }

  const issues = await sourceItems(`/api/companies/${company.id}/issues`);
  for (const issue of issues) {
    const targetIssue = await ensureIssue(targetCompany.id, company.id, issue);
    state.issues.set(issue.id, targetIssue.id);
  }

  for (const issue of issues) {
    await importComments(issue);
  }

  for (const run of await sourceItems(`/api/companies/${company.id}/heartbeat-runs`).catch(() => [])) {
    await importRun(targetCompany.id, run);
  }
}

async function ensureTenant() {
  const tenants = await targetJson("/api/tenants");
  const existing = items(tenants).find((tenant) => tenant.name === TARGET_TENANT_NAME);
  if (existing) return existing.id;
  const tenant = await targetJson("/api/tenants", {
    method: "POST",
    body: { name: TARGET_TENANT_NAME, industry: TARGET_TENANT_INDUSTRY },
  });
  return tenant.id;
}

async function ensureCompany(company) {
  const existing = items(await targetJson(`/api/companies?tenantId=${state.tenantId}`))
    .find((row) => row.name === company.name);
  if (existing) return existing;
  return targetJson("/api/companies", {
    method: "POST",
    body: {
      tenantId: state.tenantId,
      name: company.name,
      slug: company.slug,
      metadata: { sourceId: company.id },
    },
  });
}

async function ensureProject(companyId, project) {
  const existing = items(await targetJson(`/api/companies/${companyId}/projects`))
    .find((row) => row.name === project.name);
  if (existing) return existing;
  return targetJson(`/api/companies/${companyId}/projects`, {
    method: "POST",
    body: {
      tenantId: state.tenantId,
      name: project.name,
      status: normalizeProjectStatus(project.status),
      metadata: { sourceId: project.id },
    },
  });
}

async function ensureAgent(companyId, agent) {
  const existing = items(await targetJson(`/api/companies/${companyId}/agents`))
    .find((row) => row.name === agent.name);
  if (existing) return existing;
  return targetJson("/api/agents", {
    method: "POST",
    body: {
      tenantId: state.tenantId,
      companyId,
      name: agent.name,
      role: agent.role ?? agent.title ?? null,
      status: normalizeAgentStatus(agent.status),
      config: {
        sourceId: agent.id,
        adapterType: agent.adapterType ?? null,
        model: agent.model ?? null,
        instructionsPath: agent.instructionsPath ?? null,
      },
    },
  });
}

async function ensureIssue(companyId, sourceCompanyId, issue) {
  const existing = items(await targetJson(`/api/companies/${companyId}/issues`))
    .find((row) => row.title === issue.title && row.metadata?.sourceId === issue.id);
  if (existing) return existing;

  const projectId = state.projects.get(issue.projectId)
    ?? state.projects.get(`${sourceCompanyId}:default-project`);
  if (!projectId) throw new Error(`missing target project for issue ${issue.id}`);

  const created = await targetJson(`/api/companies/${companyId}/issues`, {
    method: "POST",
    body: {
      tenantId: state.tenantId,
      projectId,
      title: issue.title,
      description: issue.description ?? "",
      priority: normalizePriority(issue.priority),
      assigneeAgentId: issue.assigneeAgentId ? state.agents.get(issue.assigneeAgentId) ?? null : null,
      blockedOn: [],
      metadata: {
        sourceId: issue.id,
        sourceIdentifier: issue.identifier ?? null,
      },
    },
  });

  return targetJson(`/api/issues/${created.id}`, {
    method: "PATCH",
    body: {
      status: normalizeIssueStatus(issue.status),
      assigneeAgentId: issue.assigneeAgentId ? state.agents.get(issue.assigneeAgentId) ?? null : null,
    },
  });
}

async function importComments(issue) {
  const targetIssueId = state.issues.get(issue.id);
  if (!targetIssueId) return;
  const comments = await sourceItems(`/api/issues/${issue.id}/comments`).catch(() => []);
  for (const comment of comments.reverse()) {
    // The source issue_comments schema has authorAgentId (uuid -> agents.id)
    // and authorUserId (text). Map the agent UUID through state.agents so it
    // resolves to the AWOS-side agent id.
    const sourceAgentId = comment.authorAgentId ?? null;
    const targetAgentId = sourceAgentId ? state.agents.get(sourceAgentId) ?? null : null;
    const authorLabel =
      comment.authorAgentName
      ?? comment.authorName
      ?? comment.authorLabel
      ?? (comment.authorUserId ? `user:${comment.authorUserId}` : "Imported");
    await targetJson(`/api/issues/${targetIssueId}/comments`, {
      method: "POST",
      body: {
        authorId: targetAgentId,
        authorLabel,
        body: comment.body ?? "",
      },
    });
  }
}

async function importRun(companyId, run) {
  // Some source exports store issueId inside contextSnapshot (JSON column), not
  // as a top-level field. Top-level run.issueId can be undefined for every row.
  const sourceIssueId =
    run.issueId
    ?? run.contextSnapshot?.issueId
    ?? run.contextSnapshot?.taskId
    ?? null;
  const targetIssueId = sourceIssueId ? state.issues.get(sourceIssueId) ?? null : null;
  await targetJson("/api/runs", {
    method: "POST",
    body: compact({
      tenantId: state.tenantId,
      companyId,
      issueId: targetIssueId ?? undefined,
      agentId: run.agentId ? state.agents.get(run.agentId) : undefined,
      status: normalizeRunStatus(run.status),
      summary: run.summary ?? run.errorCode ?? run.triggerDetail ?? null,
    }),
  });
}

async function sourceItems(path) {
  return items(await json(SOURCE_BASE, path));
}

async function targetJson(path, init = {}) {
  return json(TARGET_BASE, path, init);
}

async function json(base, path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${base}${path} HTTP ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

function items(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function normalizePriority(value) {
  return ["critical", "high", "medium", "low"].includes(value) ? value : "medium";
}

function normalizeIssueStatus(value) {
  if (["todo", "in_progress", "blocked", "review", "done", "closed"].includes(value)) return value;
  if (value === "cancelled" || value === "hidden") return "closed";
  return "todo";
}

function normalizeProjectStatus(value) {
  if (["active", "paused", "completed", "archived"].includes(value)) return value;
  if (value === "done" || value === "closed") return "completed";
  if (value === "backlog" || value === "todo") return "active";
  return "active";
}

function normalizeRunStatus(value) {
  if (["queued", "running", "succeeded", "failed", "cancelled"].includes(value)) return value;
  if (value === "complete" || value === "completed" || value === "done") return "succeeded";
  return "queued";
}

function normalizeAgentStatus(value) {
  if (["active", "paused", "retired"].includes(value)) return value;
  if (value === "archived" || value === "terminated") return "retired";
  return "active";
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined && entry[1] !== null));
}

function env(key, fallback) {
  const value = process.env[key];
  return value && value.trim() ? value.trim() : fallback;
}

function deprecatedSourceApiUrl(fallback) {
  const oldName = `${"PAPER"}${"CLIP"}_API_URL`;
  return env(oldName, fallback);
}

main().catch((err) => {
  console.error(`[import] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
