/**
 * Tests for SimulatedAdapter.
 */

import { describe, it, expect } from "vitest";
import { SimulatedAdapter } from "./simulated-adapter.js";
import type { AdapterInput } from "../services/dispatch-consumer.js";

function makeInput(overrides: Partial<AdapterInput> & { targetAgentId: string; taskId: string }): AdapterInput {
  return {
    taskId: overrides.taskId,
    tenantId: overrides.tenantId ?? "tenant-abc",
    taskKind: overrides.taskKind ?? "generic",
    targetAgentId: overrides.targetAgentId,
    agent: overrides.agent ?? {
      id: overrides.targetAgentId,
      tenantId: overrides.tenantId ?? "tenant-abc",
      role: overrides.agent?.role ?? null,
      model: null,
      adapterType: "simulated",
      instructionsPath: null,
    },
    payload: overrides.payload ?? {},
    riskScore: overrides.riskScore,
    reasons: overrides.reasons,
    autopilotDecision: overrides.autopilotDecision,
  };
}

describe("SimulatedAdapter", () => {
  const adapter = new SimulatedAdapter();

  it("returns status=completed on the normal path", async () => {
    const input = makeInput({ targetAgentId: "agent-001", taskId: "task-001" });
    const outcome = await adapter.run(input);
    expect(outcome.status).toBe("completed");
  });

  it("prefixes summary with [simulated]", async () => {
    const input = makeInput({ targetAgentId: "agent-001", taskId: "task-001" });
    const outcome = await adapter.run(input);
    if (outcome.status !== "completed") throw new Error("expected completed");
    expect(outcome.summary).toMatch(/^\[simulated\] /);
  });

  it("is deterministic — same input yields identical output", async () => {
    const input = makeInput({ targetAgentId: "agent-determinism", taskId: "task-determinism" });
    const a = await adapter.run(input);
    const b = await adapter.run(input);
    expect(a).toEqual(b);
  });

  it("different (agentId, taskId) pairs produce different summaries for the same role", async () => {
    const reviewAgent = {
      id: "agent-r",
      tenantId: "tenant-abc",
      role: "review" as const,
      model: null,
      adapterType: "simulated",
      instructionsPath: null,
    };
    const x = await adapter.run(makeInput({ targetAgentId: "agent-r", taskId: "task-alpha", agent: reviewAgent }));
    const y = await adapter.run(makeInput({ targetAgentId: "agent-r", taskId: "task-beta", agent: reviewAgent }));
    if (x.status !== "completed" || y.status !== "completed") throw new Error("expected completed");
    // Different taskIds must produce different seeds and thus different summaries.
    expect(x.summary).not.toBe(y.summary);
  });

  describe("role-aware output shapes", () => {
    it('review role: summary contains verdict=PASS or verdict=FAIL', async () => {
      const input = makeInput({
        targetAgentId: "agent-reviewer",
        taskId: "task-review-001",
        agent: {
          id: "agent-reviewer",
          tenantId: "tenant-abc",
          role: "review",
          model: null,
          adapterType: "simulated",
          instructionsPath: null,
        },
      });
      const outcome = await adapter.run(input);
      if (outcome.status !== "completed") throw new Error("expected completed");
      expect(outcome.summary).toMatch(/verdict=(PASS|FAIL)/);
    });

    it('engineer role: summary contains change-set info', async () => {
      const input = makeInput({
        targetAgentId: "agent-engineer",
        taskId: "task-eng-001",
        agent: {
          id: "agent-engineer",
          tenantId: "tenant-abc",
          role: "engineer",
          model: null,
          adapterType: "simulated",
          instructionsPath: null,
        },
      });
      const outcome = await adapter.run(input);
      if (outcome.status !== "completed") throw new Error("expected completed");
      expect(outcome.summary).toMatch(/change-set files=\d+/);
    });

    it('default role: summary contains step info', async () => {
      const input = makeInput({
        targetAgentId: "agent-generic",
        taskId: "task-generic-001",
        agent: {
          id: "agent-generic",
          tenantId: "tenant-abc",
          role: null,
          model: null,
          adapterType: "simulated",
          instructionsPath: null,
        },
      });
      const outcome = await adapter.run(input);
      if (outcome.status !== "completed") throw new Error("expected completed");
      expect(outcome.summary).toMatch(/task completed at step \d+ of 9/);
    });

    it("review, engineer, and default produce distinct summary shapes", async () => {
      const base = { targetAgentId: "agent-shape", taskId: "task-shape" };

      const reviewOutcome = await adapter.run(makeInput({
        ...base,
        agent: { id: base.targetAgentId, tenantId: "t", role: "review", model: null, adapterType: "simulated", instructionsPath: null },
      }));
      const engineerOutcome = await adapter.run(makeInput({
        ...base,
        agent: { id: base.targetAgentId, tenantId: "t", role: "engineer", model: null, adapterType: "simulated", instructionsPath: null },
      }));
      const defaultOutcome = await adapter.run(makeInput({
        ...base,
        agent: { id: base.targetAgentId, tenantId: "t", role: null, model: null, adapterType: "simulated", instructionsPath: null },
      }));

      if (
        reviewOutcome.status !== "completed" ||
        engineerOutcome.status !== "completed" ||
        defaultOutcome.status !== "completed"
      ) {
        throw new Error("expected all completed");
      }

      // Each role produces a structurally distinct summary.
      expect(reviewOutcome.summary).toMatch(/verdict=/);
      expect(engineerOutcome.summary).toMatch(/change-set/);
      expect(defaultOutcome.summary).toMatch(/task completed/);

      // No two are identical.
      expect(reviewOutcome.summary).not.toBe(engineerOutcome.summary);
      expect(reviewOutcome.summary).not.toBe(defaultOutcome.summary);
      expect(engineerOutcome.summary).not.toBe(defaultOutcome.summary);
    });
  });

  it("costCents and token counters are zero (no real LLM call)", async () => {
    const outcome = await adapter.run(makeInput({ targetAgentId: "agent-cost", taskId: "task-cost" }));
    if (outcome.status !== "completed") throw new Error("expected completed");
    expect(outcome.costCents).toBe(0);
    expect(outcome.tokensInput).toBe(0);
    expect(outcome.tokensOutput).toBe(0);
  });
});
