import { NextRequest, NextResponse } from 'next/server';

type ManifestIssue = {
  id: string;
  title: string;
  description?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  assigneeAgentId?: string;
  metadata?: Record<string, unknown>;
  dependencies?: string[];
};

type Manifest = {
  issues: ManifestIssue[];
};

function hasCycle(graph: Record<string, string[]>): { hasCycle: boolean; cycle: string[] } {
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const parent: Record<string, string> = {};

  function dfs(node: string): any {
    if (visited.has(node)) return null;
    visited.add(node);
    recStack.add(node);

    for (const neighbor of graph[node] || []) {
      if (!visited.has(neighbor)) {
        const result = dfs(neighbor);
        if (result) return result;
        parent[neighbor] = node;
      } else if (recStack.has(neighbor)) {
        // Found a cycle
        const cycle: string[] = [];
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

// Kahn's algorithm for topological sort
function topologicalSort(issues: ManifestIssue[]): ManifestIssue[] {
  const indegree = new Map<string, number>();
  const adj: Record<string, string[]> = {};

  issues.forEach(issue => {
    indegree.set(issue.id, 0);
    adj[issue.id] = [];
  });

  issues.forEach(issue => {
    (issue.dependencies || []).forEach(dep => {
      // Only consider dependencies that exist in the manifest
      if (issues.some(i => i.id === dep)) {
        adj[dep].push(issue.id);
        indegree.set(issue.id, (indegree.get(issue.id) || 0) + 1);
      }
    });
  });

  const queue: string[] = [];
  indegree.forEach((deg, id) => {
    if (deg === 0) queue.push(id);
  });

  const sortedIds: string[] = [];
  while (queue.length) {
    const curr = queue.shift()!;
    sortedIds.push(curr);
    const neighbors = adj[curr] ?? [];
    for (const n of neighbors) {
      const newDeg = (indegree.get(n) ?? 0) - 1;
      if (newDeg === 0) queue.push(n);
      indegree.set(n, newDeg);
    }
  }

  // If not all items were processed, there is a cycle (should have been caught earlier)
  if (sortedIds.length !== issues.length) {
    return [];
  }

  return issues.filter(issue => sortedIds.includes(issue.id));
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const manifest: Manifest = body;

    if (!manifest?.issues || !Array.isArray(manifest.issues)) {
      return NextResponse.json({ error: 'Invalid manifest: issues array required' }, { status: 400 });
    }

    const issues = manifest.issues;

    // Validate each issue
    const errors: string[] = [];
    const warnings: string[] = [];

    // Build mapping of id -> issue for quick lookup
    const issueMap: Record<string, ManifestIssue> = {};
    issues.forEach(issue => {
      if (!issue.id) {
        errors.push('Each issue must have an "id" field');
      }
      if (!issue.title) {
        errors.push(`Issue "${issue.id}" is missing a title`);
      }
      // Validate assignee if provided
      if (issue.assigneeAgentId) {
        // Very light check: must be non-empty string
        if (!issue.assigneeAgentId.trim()) {
          errors.push(`Issue "${issue.id}" has an empty assigneeAgentId`);
        }
      }
      // Validate metadata.repoPath if present
      if (issue.metadata && issue.metadata.repoPath) {
        if (typeof issue.metadata.repoPath !== 'string') {
          errors.push(`Issue "${issue.id}" metadata.repoPath must be a string`);
        } else if (/[\\/]/.test(issue.metadata.repoPath)) {
          warnings.push(`Issue "${issue.id}" metadata.repoPath contains slash - may be unintended`);
        }
      }
      // Store for later
      issueMap[issue.id] = issue;
    });

    // Dependency validation
    const dependencyGraph: Record<string, string[]> = {};
    issues.forEach(issue => {
      dependencyGraph[issue.id] = (issue.dependencies || []);
    });

    // Detect cycles
    const cycleResult = hasCycle(dependencyGraph);
    if (cycleResult.hasCycle) {
      errors.push(`Dependency cycle detected: ${cycleResult.cycle.join(' -> ')}`);
    }

    // Validate that all referenced dependencies exist as issue ids
    issues.forEach(issue => {
      (issue.dependencies || []).forEach(dep => {
        if (!issueMap[dep]) {
          errors.push(`Issue "${issue.id}" references missing dependency "${dep}"`);
        }
      });
    });

    // Topological sort for creation order
    const orderedIssues = topologicalSort(issues);
    if (orderedIssues.length !== issues.length) {
      errors.push('Issues could not be ordered due to unresolved dependencies');
    }

    // Build mapping from old id to simulated new issue id (just use a hash for demo)
    const mapping: Record<string, string> = {};
    orderedIssues.forEach((issue, index) => {
      // Simulate generated id - could be whatever backend returns
      mapping[issue.id] = `issue_${index + 1}`;
    });

    // If there are hard errors, return early
    if (errors.length) {
      return NextResponse.json(
        {
          errors,
          warnings,
          mapping,
          order: orderedIssues.map(i => i.id),
        },
        { status: 400 }
      );
    }

    // Success - return preview
    return NextResponse.json(
      {
        mapping,
        order: orderedIssues.map(i => i.id),
        issues: orderedIssues.map(i => ({
          id: mapping[i.id],
          title: i.title,
          description: i.description,
          priority: i.priority,
          assigneeAgentId: i.assigneeAgentId,
          'metadata.repoPath': i.metadata?.repoPath,
        })),
        warnings,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error('Bulk import error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}