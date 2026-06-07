/**
 * run-lineage — Resolve the episode + insights produced by a single run.
 *
 * Reads execution_runs.episode_session_id, joins to episodes.session_id,
 * then to insights.episode_id. Returns the run row, the episode(s) for
 * that session, and the insights belonging to those episodes.
 */

import type { Database } from "better-sqlite3";

export interface RunLineageEpisode {
  id: string;
  tenantId: string;
  agentId: string | null;
  sessionId: string | null;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  outcome: string | null;
  summary: string;
  importance: number;
  createdAt: string;
}

export interface RunLineageInsight {
  id: string;
  tenantId: string;
  episodeId: string;
  frameType: string;
  subject: string | null;
  content: string;
  importance: number;
  source: string;
  validated: number;
  createdAt: string;
}

export interface RunLineageRun {
  id: string;
  tenantId: string;
  companyId: string;
  projectId: string | null;
  issueId: string | null;
  agentId: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  summary: string | null;
  episodeSessionId: string | null;
  createdAt: string;
}

export interface RunLineageResult {
  run: RunLineageRun | null;
  episodes: RunLineageEpisode[];
  insights: RunLineageInsight[];
}

/**
 * Resolve the lineage for a single run: the run itself, any episodes
 * sharing its episode_session_id, and the insights attached to those episodes.
 */
export function resolveRunLineage(
  sqlite: Database,
  runId: string
): RunLineageResult {
  const run = sqlite
    .prepare(
      `SELECT
        id,
        tenant_id AS tenantId,
        company_id AS companyId,
        project_id AS projectId,
        issue_id AS issueId,
        agent_id AS agentId,
        status,
        started_at AS startedAt,
        ended_at AS endedAt,
        summary,
        episode_session_id AS episodeSessionId,
        created_at AS createdAt
      FROM execution_runs
      WHERE id = ?`
    )
    .get(runId) as RunLineageRun | undefined;

  if (!run) {
    return { run: null, episodes: [], insights: [] };
  }

  const episodes = sqlite
    .prepare(
      `SELECT
        id,
        tenant_id AS tenantId,
        agent_id AS agentId,
        session_id AS sessionId,
        started_at AS startedAt,
        ended_at AS endedAt,
        duration_sec AS durationSec,
        outcome,
        summary,
        importance,
        created_at AS createdAt
      FROM episodes
      WHERE tenant_id = ? AND session_id = ?
      ORDER BY created_at ASC`
    )
    .all(run.tenantId, run.episodeSessionId) as RunLineageEpisode[];

  if (episodes.length === 0) {
    return { run, episodes: [], insights: [] };
  }

  const episodeIds = episodes.map((e) => e.id);
  const placeholders = episodeIds.map(() => "?").join(",");

  const insights = sqlite
    .prepare(
      `SELECT
        id,
        tenant_id AS tenantId,
        episode_id AS episodeId,
        frame_type AS frameType,
        subject,
        content,
        importance,
        source,
        validated,
        created_at AS createdAt
      FROM insights
      WHERE episode_id IN (${placeholders})
      ORDER BY created_at ASC`
    )
    .all(...episodeIds) as RunLineageInsight[];

  return { run, episodes, insights };
}
