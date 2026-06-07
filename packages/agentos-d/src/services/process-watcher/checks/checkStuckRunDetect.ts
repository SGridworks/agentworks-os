import type { CheckResult, Finding } from "../types.js";

/** Detects in_progress issues that appear stuck based on lack of recent
 * heartbeat, comment activity, or dispatch progress.
 */
export interface StuckRunDetectInput {
  issues: Array<{
    id: string;
    identifier: string;
    status: string;
    updatedAt: string;
    latestCommentAt: string | null;
    assigneeAgentId: string | null;
  }>;
  thresholdHrs: number;
}

export function checkStuckRunDetect(input: StuckRunDetectInput): CheckResult {
  const { issues, thresholdHrs } = input;
  const findings: Finding[] = [];
  const errors: CheckResult["errors"] = [];
  const now = Date.now();

  for (const issue of issues) {
    // Only evaluate in_progress issues
    if (issue.status !== "in_progress") continue;

    const updatedAt = new Date(issue.updatedAt).getTime();
    const staleHrs = (now - updatedAt) / 1000 / 60 / 60;
    // Consider issue stale if it has been in_progress longer than threshold
    if (staleHrs < thresholdHrs) continue;

    // Also check comment activity - must be older than threshold
    const commentTime = issue.latestCommentAt
      ? new Date(issue.latestCommentAt).getTime()
      : updatedAt;
    const commentStaleHrs = (now - commentTime) / 1000 / 60 / 60;
    if (commentStaleHrs < thresholdHrs) continue;

    findings.push({
      checkId: "stuck_run_detected",
      severity: "critical",
      targetIssueId: issue.id,
      agentId: issue.assigneeAgentId,
      explanation: `Issue ${issue.identifier} has been in_progress for ${Math.round(staleHrs)}h with no comment activity in ${Math.round(commentStaleHrs)}h (threshold=${thresholdHrs}h).`,
      suggestedAction: "Create a triage issue or route to operator for stuck-run investigation. Consider retry, reroute, or block based on policy.",
      dedupKey: `stuck_run_detected:${issue.id}`,
    });
  }

  return { findings, errors };
}
