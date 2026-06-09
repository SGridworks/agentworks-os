import { NextRequest, NextResponse } from "next/server";
import { daemonFetch } from "@/lib/daemon-fetch";

type ManifestIssue = {
  id: string;
  title: string;
  description?: string;
  priority?: "critical" | "high" | "medium" | "low";
  assigneeAgentId?: string;
  metadata?: Record<string, unknown>;
  dependencies?: string[];
};

type Manifest = {
  tenantId?: string;
  companyId?: string;
  projectId?: string;
  dryRun?: boolean;
  issues: ManifestIssue[];
};

type ListResponse<T> = {
  items: T[];
};

type Tenant = {
  id: string;
};

type Company = {
  id: string;
};

type Project = {
  id: string;
};

type CreatedIssue = {
  id: string;
  title: string;
};

const ENV_TENANT_ID = process.env.AGENTOS_TENANT_ID;
const ENV_COMPANY_ID = process.env.AGENTOS_COMPANY_ID;
const ENV_PROJECT_ID = process.env.AGENTOS_PROJECT_ID;

async function fetchAgentos<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await daemonFetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`agentos-d ${response.status}: ${body}`);
  }
  return response.json() as Promise<T>;
}

function hasCycle(graph: Record<string, string[]>): { hasCycle: boolean; cycle: string[] } {
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const parent: Record<string, string> = {};

  function dfs(node: string): string[] | null {
    if (visited.has(node)) return null;
    visited.add(node);
    recStack.add(node);

    for (const neighbor of graph[node] ?? []) {
      if (!visited.has(neighbor)) {
        parent[neighbor] = node;
        const result = dfs(neighbor);
        if (result) return result;
      } else if (recStack.has(neighbor)) {
        const cycle: string[] = [neighbor];
        let cur = node;
        while (cur !== neighbor) {
          cycle.push(cur);
          cur = parent[cur];
        }
        cycle.push(neighbor);
        cycle.reverse();
        return cycle;
      }
    }

    recStack.delete(node);
    return null;
  }

  for (const node of Object.keys(graph)) {
    const result = dfs(node);
    if (result) return { hasCycle: true, cycle: result };
  }
  return { hasCycle: false, cycle: [] };
}

function topologicalSort(issues: ManifestIssue[]): ManifestIssue[] {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const indegree = new Map<string, number>();
  const adj: Record<string, string[]> = {};

  for (const issue of issues) {
    indegree.set(issue.id, 0);
    adj[issue.id] = [];
  }

  for (const issue of issues) {
    for (const dep of issue.dependencies ?? []) {
      if (byId.has(dep)) {
        adj[dep]?.push(issue.id);
        indegree.set(issue.id, (indegree.get(issue.id) ?? 0) + 1);
      }
    }
  }

  const queue = Array.from(indegree.entries())
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);
  const sortedIds: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    sortedIds.push(current);
    for (const next of adj[current] ?? []) {
      const degree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }

  if (sortedIds.length !== issues.length) return [];
  return sortedIds.map((id) => byId.get(id)!);
}

function validateManifest(manifest: Manifest): {
  orderedIssues: ManifestIssue[];
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const issueMap: Record<string, ManifestIssue> = {};

  if (!manifest?.issues || !Array.isArray(manifest.issues)) {
    return { orderedIssues: [], errors: ["Invalid manifest: issues array required"], warnings };
  }

  for (const issue of manifest.issues) {
    if (!issue.id) {
      errors.push('Each issue must have an "id" field');
      continue;
    }
    if (!issue.title) {
      errors.push(`Issue "${issue.id}" is missing a title`);
    }
    if (issue.assigneeAgentId !== undefined && !issue.assigneeAgentId.trim()) {
      errors.push(`Issue "${issue.id}" has an empty assigneeAgentId`);
    }
    if (issue.metadata?.repoPath !== undefined) {
      if (typeof issue.metadata.repoPath !== "string") {
        errors.push(`Issue "${issue.id}" metadata.repoPath must be a string`);
      } else if (/[\\/]/.test(issue.metadata.repoPath)) {
        warnings.push(`Issue "${issue.id}" metadata.repoPath contains slash - may be unintended`);
      }
    }
    issueMap[issue.id] = issue;
  }

  const dependencyGraph: Record<string, string[]> = {};
  for (const issue of manifest.issues) {
    dependencyGraph[issue.id] = issue.dependencies ?? [];
    for (const dep of issue.dependencies ?? []) {
      if (!issueMap[dep]) {
        errors.push(`Issue "${issue.id}" references missing dependency "${dep}"`);
      }
    }
  }

  const cycleResult = hasCycle(dependencyGraph);
  if (cycleResult.hasCycle) {
    errors.push(`Dependency cycle detected: ${cycleResult.cycle.join(" -> ")}`);
  }

  const orderedIssues = topologicalSort(manifest.issues);
  if (orderedIssues.length !== manifest.issues.length) {
    errors.push("Issues could not be ordered due to unresolved dependencies");
  }

  return { orderedIssues, errors, warnings };
}

async function resolveTenantId(manifest: Manifest): Promise<string> {
  if (manifest.tenantId) return manifest.tenantId;
  if (ENV_TENANT_ID) return ENV_TENANT_ID;
  const tenants = await fetchAgentos<Tenant[]>("/api/tenants");
  const tenant = tenants[0];
  if (!tenant) throw new Error("No tenant exists yet");
  return tenant.id;
}

async function resolveCompanyId(manifest: Manifest, tenantId: string): Promise<string> {
  if (manifest.companyId) return manifest.companyId;
  if (ENV_COMPANY_ID) return ENV_COMPANY_ID;
  const companies = await fetchAgentos<ListResponse<Company>>(
    `/api/companies?tenantId=${encodeURIComponent(tenantId)}`,
  );
  const company = companies.items[0];
  if (!company) throw new Error(`No company exists yet for tenant ${tenantId}`);
  return company.id;
}

async function resolveProjectId(manifest: Manifest, companyId: string): Promise<string> {
  if (manifest.projectId) return manifest.projectId;
  if (ENV_PROJECT_ID) return ENV_PROJECT_ID;
  const projects = await fetchAgentos<ListResponse<Project>>(`/api/companies/${companyId}/projects`);
  const project = projects.items[0];
  if (!project) throw new Error(`No project exists yet for company ${companyId}`);
  return project.id;
}

function previewPayload(
  orderedIssues: ManifestIssue[],
  warnings: string[],
): Record<string, unknown> {
  const mapping: Record<string, string> = {};
  orderedIssues.forEach((issue, index) => {
    mapping[issue.id] = `issue_${index + 1}`;
  });
  return {
    mapping,
    order: orderedIssues.map((issue) => issue.id),
    issues: orderedIssues.map((issue) => ({
      id: mapping[issue.id],
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      assigneeAgentId: issue.assigneeAgentId,
      "metadata.repoPath": issue.metadata?.repoPath,
    })),
    warnings,
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const manifest = (await req.json()) as Manifest;
    const { orderedIssues, errors, warnings } = validateManifest(manifest);

    if (errors.length > 0) {
      return NextResponse.json(
        {
          errors,
          warnings,
          mapping: {},
          order: orderedIssues.map((issue) => issue.id),
        },
        { status: 400 },
      );
    }

    if (manifest.dryRun) {
      return NextResponse.json(previewPayload(orderedIssues, warnings));
    }

    const tenantId = await resolveTenantId(manifest);
    const companyId = await resolveCompanyId(manifest, tenantId);
    const projectId = await resolveProjectId(manifest, companyId);
    const mapping: Record<string, string> = {};
    const created: CreatedIssue[] = [];

    for (const issue of orderedIssues) {
      const blockedOn = (issue.dependencies ?? [])
        .map((dep) => mapping[dep])
        .filter((id): id is string => Boolean(id));
      const createdIssue = await fetchAgentos<CreatedIssue>(
        `/api/companies/${companyId}/issues`,
        {
          method: "POST",
          body: JSON.stringify({
            tenantId,
            projectId,
            title: issue.title,
            description: issue.description,
            priority: issue.priority,
            assigneeAgentId: issue.assigneeAgentId,
            blockedOn,
            metadata: {
              ...(issue.metadata ?? {}),
              importSourceId: issue.id,
            },
          }),
        },
      );
      mapping[issue.id] = createdIssue.id;
      created.push(createdIssue);
    }

    return NextResponse.json({
      mapping,
      order: orderedIssues.map((issue) => issue.id),
      issues: created,
      warnings,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[bulk-issue-import] failed:", message);
    return NextResponse.json({ error: "import_failed", message }, { status: 500 });
  }
}
