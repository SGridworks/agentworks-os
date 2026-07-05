/**
 * Issue state-machine — the legal status-transition graph for execution issues.
 *
 * Enforced at PATCH /api/issues/:id (routes/execution.ts): an illegal
 * transition is rejected with 409 instead of being silently applied. A
 * self-transition (status unchanged) is always allowed so a metadata-only PATCH
 * never trips the guard.
 *
 * Two tiers of legality:
 *   - Universal forward edges (LEGAL_TRANSITIONS below) are legal for any
 *     actor — human, agent, or system. These cover the everyday paths the
 *     dispatch bridge and review adapters actually walk, including shortcuts
 *     like todo -> done (mark-in-progress didn't run before completion) and
 *     blocked -> done (bridge completes a blocked issue directly).
 *   - Operator-only edges are legal ONLY when actorType === "human": closing
 *     an issue (any state -> closed) and reopening a terminal issue (done or
 *     closed -> any non-terminal state). Autonomous callers (agent/system, or
 *     no actorType at all) can never close or reopen — only a human operator
 *     can.
 *
 * Scope note: internal adapters (kimi/ollama) transition issues via direct SQL
 * and intentionally bypass this guard. Enforcement here covers the public REST
 * surface — the admin UI, external callers, and the dispatch bridge (which marks
 * todo -> in_progress -> done through this route).
 */

export type IssueStatus =
  | "todo"
  | "in_progress"
  | "blocked"
  | "review"
  | "done"
  | "closed";

export type IssueActorType = "human" | "agent" | "system";

const ALL_STATUSES: readonly IssueStatus[] = [
  "todo",
  "in_progress",
  "blocked",
  "review",
  "done",
  "closed",
];

/**
 * from -> allowed next states, legal for ANY actor. Self-transition is
 * handled separately (always allowed) and is not listed here. Closing
 * (-> closed) and reopening a terminal state (done/closed -> non-terminal)
 * are deliberately absent — those are operator-only, see isLegalTransition.
 */
export const LEGAL_TRANSITIONS: Record<IssueStatus, readonly IssueStatus[]> = {
  todo: ["in_progress", "blocked", "done"],
  in_progress: ["todo", "review", "blocked", "done"],
  blocked: ["todo", "in_progress", "done"],
  review: ["todo", "in_progress", "done"],
  done: [],
  closed: [],
};

const TERMINAL: ReadonlySet<IssueStatus> = new Set<IssueStatus>(["done", "closed"]);

/**
 * True when `to` is reachable from `from` for the given actor (or `to` is
 * the same status). Absent/non-"human" actorType only gets the universal
 * forward edges — closing and reopening a terminal state require a human.
 */
export function isLegalTransition(
  from: IssueStatus,
  to: IssueStatus,
  actorType?: IssueActorType,
): boolean {
  if (from === to) return true;
  if (LEGAL_TRANSITIONS[from]?.includes(to)) return true;
  if (actorType !== "human") return false;
  if (to === "closed") return true;
  return TERMINAL.has(from) && !TERMINAL.has(to);
}

/** The non-self states reachable from `from` (for the 409 `allowed` list). */
export function allowedNextStates(
  from: IssueStatus,
  actorType?: IssueActorType,
): readonly IssueStatus[] {
  return ALL_STATUSES.filter((s) => s !== from && isLegalTransition(from, s, actorType));
}

/** True for the completion states that carry a `completed_at` timestamp. */
export function isTerminalStatus(status: IssueStatus): boolean {
  return TERMINAL.has(status);
}
