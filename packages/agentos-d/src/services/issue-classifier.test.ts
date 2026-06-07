/**
 * Unit tests for the issue cleanup classifier.
 *
 * Pure-function tests — no DB, no I/O. Uses a fixed `now` for determinism.
 */

import { describe, it, expect } from "vitest";
import { classify } from "./issue-classifier.js";
import type { ClassifierInput } from "./issue-classifier.js";

const NOW = new Date("2026-05-16T12:00:00.000Z");

// Helpers
const recent = (): string => new Date(NOW.getTime() - 10 * 60 * 1000).toISOString(); // 10 min ago
const stale = (): string => new Date(NOW.getTime() - 50 * 60 * 60 * 1000).toISOString(); // 50h ago

function makeInput(overrides: Partial<ClassifierInput> = {}): ClassifierInput {
  return {
    alwaysKeepIssueIds: [],
    issues: [],
    dispatchQueueIssueIds: new Set(),
    now: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Rule 1 — always-keep list
// ---------------------------------------------------------------------------

describe("rule 1 — always-keep", () => {
  it("keeps an issue that is in alwaysKeepIssueIds", () => {
    const input = makeInput({
      alwaysKeepIssueIds: ["AWOS-STANDING"],
      issues: [{ id: "AWOS-STANDING", metadata: null, lastHeartbeatAt: null }],
    });
    const result = classify(input);
    expect(result.keep).toEqual([{ id: "AWOS-STANDING", reason: "always-keep" }]);
    expect(result.candidates).toEqual([]);
  });

  it("keeps multiple ids from the always-keep list", () => {
    const input = makeInput({
      alwaysKeepIssueIds: ["AGE-277", "AGE-304"],
      issues: [
        { id: "AGE-277", metadata: null, lastHeartbeatAt: null },
        { id: "AGE-304", metadata: null, lastHeartbeatAt: null },
      ],
    });
    const result = classify(input);
    expect(result.keep).toHaveLength(2);
    expect(result.keep.every((k) => k.reason === "always-keep")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — metadata.keepActive
// ---------------------------------------------------------------------------

describe("rule 2 — metadata.keepActive", () => {
  it("keeps when metadata.keepActive === true", () => {
    const input = makeInput({
      issues: [{ id: "i1", metadata: { keepActive: true }, lastHeartbeatAt: null }],
    });
    const result = classify(input);
    expect(result.keep).toEqual([{ id: "i1", reason: "metadata-keep-active" }]);
  });

  it("does NOT keep when metadata.keepActive is false", () => {
    const input = makeInput({
      issues: [{ id: "i1", metadata: { keepActive: false }, lastHeartbeatAt: null }],
    });
    const result = classify(input);
    expect(result.candidates).toHaveLength(1);
  });

  it("does NOT keep when metadata is null", () => {
    const input = makeInput({
      issues: [{ id: "i1", metadata: null, lastHeartbeatAt: null }],
    });
    const result = classify(input);
    expect(result.candidates).toHaveLength(1);
  });

  it("keeps when metadata.keepActive === true even with stale heartbeat", () => {
    const input = makeInput({
      issues: [{ id: "i1", metadata: { keepActive: true }, lastHeartbeatAt: stale() }],
    });
    const result = classify(input);
    expect(result.keep).toEqual([{ id: "i1", reason: "metadata-keep-active" }]);
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — heartbeat-recent
// ---------------------------------------------------------------------------

describe("rule 3 — heartbeat-recent", () => {
  it("keeps when heartbeat is within 48h", () => {
    const input = makeInput({
      issues: [{ id: "i1", metadata: null, lastHeartbeatAt: recent() }],
    });
    const result = classify(input);
    expect(result.keep).toEqual([{ id: "i1", reason: "heartbeat-recent" }]);
  });

  it("does NOT keep when heartbeat is older than 48h", () => {
    const input = makeInput({
      issues: [{ id: "i1", metadata: null, lastHeartbeatAt: stale() }],
    });
    const result = classify(input);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.reason).toBe("no-dispatch");
  });

  it("does NOT keep when heartbeat is exactly 48h (boundary exclusive)", () => {
    const exactly48h = new Date(NOW.getTime() - FORTY_EIGHT_HOURS_MS).toISOString();
    const input = makeInput({
      issues: [{ id: "i1", metadata: null, lastHeartbeatAt: exactly48h }],
    });
    const result = classify(input);
    // diff === 48h, which is NOT < 48h
    expect(result.candidates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — in-dispatch-queue
// ---------------------------------------------------------------------------

describe("rule 4 — in-dispatch-queue", () => {
  it("keeps when issue id is in dispatchQueueIssueIds", () => {
    const input = makeInput({
      issues: [{ id: "i1", metadata: null, lastHeartbeatAt: null }],
      dispatchQueueIssueIds: new Set(["i1"]),
    });
    const result = classify(input);
    expect(result.keep).toEqual([{ id: "i1", reason: "in-dispatch-queue" }]);
  });

  it("does NOT keep when issue id is not in dispatchQueueIssueIds", () => {
    const input = makeInput({
      issues: [{ id: "i1", metadata: null, lastHeartbeatAt: null }],
      dispatchQueueIssueIds: new Set(["other"]),
    });
    const result = classify(input);
    expect(result.candidates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Rule ordering — first match wins
// ---------------------------------------------------------------------------

describe("rule ordering", () => {
  it("always-keep wins over no-heartbeat", () => {
    const input = makeInput({
      alwaysKeepIssueIds: ["i1"],
      issues: [{ id: "i1", metadata: null, lastHeartbeatAt: null }],
    });
    const result = classify(input);
    expect(result.keep[0]?.reason).toBe("always-keep");
    expect(result.candidates).toHaveLength(0);
  });

  it("always-keep wins over stale heartbeat", () => {
    const input = makeInput({
      alwaysKeepIssueIds: ["i1"],
      issues: [{ id: "i1", metadata: null, lastHeartbeatAt: stale() }],
    });
    const result = classify(input);
    expect(result.keep[0]?.reason).toBe("always-keep");
  });

  it("always-keep wins over dispatch-queue presence", () => {
    const input = makeInput({
      alwaysKeepIssueIds: ["i1"],
      issues: [{ id: "i1", metadata: null, lastHeartbeatAt: null }],
      dispatchQueueIssueIds: new Set(["i1"]),
    });
    const result = classify(input);
    expect(result.keep[0]?.reason).toBe("always-keep");
  });

  it("metadata-keep-active wins over heartbeat-recent", () => {
    const input = makeInput({
      issues: [{ id: "i1", metadata: { keepActive: true }, lastHeartbeatAt: recent() }],
    });
    const result = classify(input);
    expect(result.keep[0]?.reason).toBe("metadata-keep-active");
  });
});

// ---------------------------------------------------------------------------
// Candidate reason codes
// ---------------------------------------------------------------------------

describe("candidate reason codes", () => {
  it("no-heartbeat when lastHeartbeatAt is null", () => {
    const input = makeInput({
      issues: [{ id: "i1", metadata: null, lastHeartbeatAt: null }],
    });
    const result = classify(input);
    expect(result.candidates[0]?.reason).toBe("no-heartbeat");
  });

  it("no-heartbeat when lastHeartbeatAt is unparseable", () => {
    const input = makeInput({
      issues: [{ id: "i1", metadata: null, lastHeartbeatAt: "not-a-date" }],
    });
    const result = classify(input);
    expect(result.candidates[0]?.reason).toBe("no-heartbeat");
  });

  it("no-dispatch when heartbeat is parseable but older than 48h", () => {
    const input = makeInput({
      issues: [{ id: "i1", metadata: null, lastHeartbeatAt: stale() }],
    });
    const result = classify(input);
    expect(result.candidates[0]?.reason).toBe("no-dispatch");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("empty input returns empty output without throwing", () => {
    const result = classify(makeInput());
    expect(result.keep).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it("handles mixed keep and candidate issues", () => {
    const input = makeInput({
      alwaysKeepIssueIds: ["keep1"],
      issues: [
        { id: "keep1", metadata: null, lastHeartbeatAt: null },
        { id: "cand1", metadata: null, lastHeartbeatAt: null },
        { id: "cand2", metadata: null, lastHeartbeatAt: stale() },
      ],
    });
    const result = classify(input);
    expect(result.keep).toHaveLength(1);
    expect(result.candidates).toHaveLength(2);
  });

  it("issue not in alwaysKeep and no other signals → candidate", () => {
    const input = makeInput({
      issues: [{ id: "orphan", metadata: {}, lastHeartbeatAt: null }],
    });
    const result = classify(input);
    expect(result.candidates).toEqual([{ id: "orphan", reason: "no-heartbeat" }]);
  });
});

// Re-export constant for boundary test access
const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
