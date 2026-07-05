/**
 * Issue state-machine — the legal status-transition graph for execution issues.
 *
 * Enforced at PATCH /api/issues/:id (routes/execution.ts): an illegal
 * transition is rejected with 409 instead of being silently applied. A
 * self-transition (status unchanged) is always allowed so a metadata-only PATCH
 * never trips the guard.
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

/**
 * from -> allowed next states. Self-transition is handled separately (always
 * allowed) and is not listed here. Terminal states can be reopened; `closed` is
 * the archive sink and only reopens to `todo`.
 */
export const LEGAL_TRANSITIONS: Record<IssueStatus, readonly IssueStatus[]> = {
  todo: ["in_progress", "blocked", "closed"],
  in_progress: ["blocked", "review", "done", "todo", "closed"],
  blocked: ["todo", "in_progress", "closed"],
  review: ["in_progress", "done", "closed"],
  done: ["closed", "in_progress"],
  closed: ["todo"],
};

const TERMINAL: ReadonlySet<IssueStatus> = new Set<IssueStatus>(["done", "closed"]);

/** True when `to` is reachable from `from` (or is the same status). */
export function isLegalTransition(from: IssueStatus, to: IssueStatus): boolean {
  if (from === to) return true;
  return LEGAL_TRANSITIONS[from]?.includes(to) ?? false;
}

/** The non-self states reachable from `from` (for the 409 `allowed` list). */
export function allowedNextStates(from: IssueStatus): readonly IssueStatus[] {
  return LEGAL_TRANSITIONS[from] ?? [];
}

/** True for the completion states that carry a `completed_at` timestamp. */
export function isTerminalStatus(status: IssueStatus): boolean {
  return TERMINAL.has(status);
}
