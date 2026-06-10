/**
 * SimulatedAdapter — opt-in demo adapter for AgentWorks OS.
 *
 * Select this adapter by setting AWOS_ADAPTER=simulated before starting the
 * daemon. It performs no I/O and makes no network calls. Every outcome is
 * deterministic: the same (targetAgentId, taskId) pair always produces the
 * same output.
 *
 * Simulated marker: because AdapterOutcome has no free-form metadata field,
 * outcomes are identified by the "[simulated] " prefix on the summary string.
 * Consumers that need to filter simulated runs can check for this prefix.
 *
 * Determinism seed: first 8 hex chars of
 *   SHA-256(targetAgentId + ":" + taskId) parsed as a hex integer (0–0xFFFFFFFF).
 */

import { createHash } from "node:crypto";
import type {
  AgentAdapter,
  AdapterInput,
  AdapterOutcome,
} from "../services/dispatch-consumer.js";

// ---------------------------------------------------------------------------
// Seed derivation
// ---------------------------------------------------------------------------

function deriveSeed(targetAgentId: string, taskId: string): number {
  const hex = createHash("sha256")
    .update(targetAgentId + ":" + taskId)
    .digest("hex")
    .slice(0, 8);
  return parseInt(hex, 16);
}

// ---------------------------------------------------------------------------
// Role-specific summary builders
// ---------------------------------------------------------------------------

function buildReviewSummary(seed: number): string {
  const verdict = seed % 2 === 0 ? "PASS" : "FAIL";
  const findingA = `finding-${(seed % 7) + 1}: interface contract satisfied`;
  const findingB = `finding-${((seed >> 4) % 7) + 1}: dependency graph acyclic`;
  return `[simulated] review verdict=${verdict}; ${findingA}; ${findingB}`;
}

function buildEngineerSummary(seed: number): string {
  const fileCount = (seed % 5) + 1;
  const linesChanged = ((seed >> 8) % 120) + 10;
  return `[simulated] change-set files=${fileCount} lines_changed=${linesChanged}; tests green`;
}

function buildDefaultSummary(seed: number): string {
  const step = (seed % 9) + 1;
  return `[simulated] task completed at step ${step} of 9`;
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export class SimulatedAdapter implements AgentAdapter {
  async run(input: AdapterInput): Promise<AdapterOutcome> {
    const seed = deriveSeed(input.targetAgentId, input.taskId);
    const role = input.agent.role ?? "";

    let summary: string;
    if (role === "review") {
      summary = buildReviewSummary(seed);
    } else if (role === "engineer") {
      summary = buildEngineerSummary(seed);
    } else {
      summary = buildDefaultSummary(seed);
    }

    return {
      status: "completed",
      summary,
      tokensInput: 0,
      tokensOutput: 0,
      costCents: 0,
    };
  }
}

export const simulatedAdapter: AgentAdapter = new SimulatedAdapter();
