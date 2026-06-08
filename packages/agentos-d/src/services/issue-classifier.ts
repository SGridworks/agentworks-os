/**
 * Issue cleanup classifier — pure function, no DB or I/O.
 *
 * Rules (first match wins for keep):
 *   1. id in alwaysKeepIssueIds       → keep, always-keep
 *   2. metadata.keepActive === true    → keep, metadata-keep-active
 *   3. lastHeartbeatAt parses and < 48h ago → keep, heartbeat-recent
 *   4. id in dispatchQueueIssueIds     → keep, in-dispatch-queue
 *   5. otherwise                       → candidate
 *      reason: no-heartbeat  (heartbeat null or unparseable)
 *              no-dispatch   (heartbeat parseable but old)
 *              other         (unexpected case)
 */

const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

export type KeepReason =
  | "always-keep"
  | "metadata-keep-active"
  | "heartbeat-recent"
  | "in-dispatch-queue";

export type CandidateReason = "no-heartbeat" | "no-dispatch" | "other";

export interface ClassifierInput {
  alwaysKeepIssueIds: string[];
  issues: Array<{
    id: string;
    metadata: Record<string, unknown> | null;
    lastHeartbeatAt: string | null;
  }>;
  dispatchQueueIssueIds: Set<string>;
  now?: Date;
}

export interface ClassifierOutput {
  keep: Array<{ id: string; reason: KeepReason }>;
  candidates: Array<{ id: string; reason: CandidateReason }>;
}

export function classify(input: ClassifierInput): ClassifierOutput {
  const now = input.now ?? new Date();
  const keepSet = new Set(input.alwaysKeepIssueIds);

  const keep: Array<{ id: string; reason: KeepReason }> = [];
  const candidates: Array<{ id: string; reason: CandidateReason }> = [];

  for (const issue of input.issues) {
    // Rule 1: always-keep list
    if (keepSet.has(issue.id)) {
      keep.push({ id: issue.id, reason: "always-keep" });
      continue;
    }

    // Rule 2: metadata.keepActive === true
    if (issue.metadata !== null && issue.metadata["keepActive"] === true) {
      keep.push({ id: issue.id, reason: "metadata-keep-active" });
      continue;
    }

    // Rule 3: recent heartbeat
    const heartbeatMs = tryParseDate(issue.lastHeartbeatAt);
    if (heartbeatMs !== null && now.getTime() - heartbeatMs < FORTY_EIGHT_HOURS_MS) {
      keep.push({ id: issue.id, reason: "heartbeat-recent" });
      continue;
    }

    // Rule 4: in dispatch queue
    if (input.dispatchQueueIssueIds.has(issue.id)) {
      keep.push({ id: issue.id, reason: "in-dispatch-queue" });
      continue;
    }

    // Candidate — determine reason
    candidates.push({ id: issue.id, reason: candidateReason(issue.lastHeartbeatAt) });
  }

  return { keep, candidates };
}

function tryParseDate(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function candidateReason(lastHeartbeatAt: string | null): CandidateReason {
  if (lastHeartbeatAt === null) return "no-heartbeat";
  const ms = tryParseDate(lastHeartbeatAt);
  if (ms === null) return "no-heartbeat";
  return "no-dispatch";
}
