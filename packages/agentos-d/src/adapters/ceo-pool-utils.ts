/**
 * CEO pool utilities for load balancing across multiple CEO agents.
 */

import type Database from "better-sqlite3";

// Fixed UUIDs for CEO agents
export const CEO_AGENT_IDS = [
  "704c0f26-757a-4e4d-922f-3695895bc95c", // CEO-1 (original)
  "8f4c9a31-8b7a-4e5f-8c3d-1a2b3c4d5e6f", // CEO-2
  "9d5e8b42-9c8b-5f6e-9d4e-2b3c4d5e6f7a", // CEO-3
];

export const ORIGINAL_CEO_AGENT_ID = "704c0f26-757a-4e4d-922f-3695895bc95c";

/**
 * Get the least loaded CEO agent for a given tenant.
 * Returns the CEO agent ID with the fewest active reviews.
 */
export function getLeastLoadedCeo(sqlite: Database.Database, tenantId: string): string {
  // Query to count active reviews per CEO agent
  const reviewCounts = sqlite.prepare(`
    SELECT
      ea.id as ceo_id,
      ea.name as ceo_name,
      COUNT(ei.id) as active_reviews
    FROM execution_agents ea
    LEFT JOIN execution_issues ei ON (
      ea.id = ei.assignee_agent_id AND
      ei.status = 'review' AND
      ei.tenant_id = ?
    )
    WHERE ea.role = 'ceo' AND ea.tenant_id = ? AND ea.status = 'active'
    GROUP BY ea.id, ea.name
    ORDER BY active_reviews ASC, ea.created_at ASC
    LIMIT 1
  `).get(tenantId, tenantId) as { ceo_id: string; ceo_name: string; active_reviews: number } | undefined;

  if (!reviewCounts) {
    // Fallback to original CEO if no CEOs found (shouldn't happen)
    return ORIGINAL_CEO_AGENT_ID;
  }

  return reviewCounts.ceo_id;
}

/**
 * Check if an agent ID belongs to a CEO agent.
 */
export function isCeoAgent(agentId: string): boolean {
  return CEO_AGENT_IDS.includes(agentId);
}

/**
 * Get all active CEO agents for a tenant.
 */
export function getActiveCeoAgents(sqlite: Database.Database, tenantId: string): Array<{ id: string; name: string; active_reviews: number }> {
  return sqlite.prepare(`
    SELECT
      ea.id,
      ea.name,
      COUNT(ei.id) as active_reviews
    FROM execution_agents ea
    LEFT JOIN execution_issues ei ON (
      ea.id = ei.assignee_agent_id AND
      ei.status = 'review' AND
      ei.tenant_id = ?
    )
    WHERE ea.role = 'ceo' AND ea.tenant_id = ? AND ea.status = 'active'
    GROUP BY ea.id, ea.name
    ORDER BY ea.created_at ASC
  `).all(tenantId, tenantId) as Array<{ id: string; name: string; active_reviews: number }>;
}
