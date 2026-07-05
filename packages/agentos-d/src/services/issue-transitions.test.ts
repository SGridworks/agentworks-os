import { describe, it, expect } from "vitest";
import {
  isLegalTransition,
  allowedNextStates,
  isTerminalStatus,
  LEGAL_TRANSITIONS,
  type IssueStatus,
} from "./issue-transitions.js";

describe("issue-transitions state machine", () => {
  it("allows a self-transition for every status", () => {
    (Object.keys(LEGAL_TRANSITIONS) as IssueStatus[]).forEach((s) => {
      expect(isLegalTransition(s, s)).toBe(true);
    });
  });

  it("allows the documented forward path todo->in_progress->review->done->closed", () => {
    expect(isLegalTransition("todo", "in_progress")).toBe(true);
    expect(isLegalTransition("in_progress", "review")).toBe(true);
    expect(isLegalTransition("review", "done")).toBe(true);
    expect(isLegalTransition("done", "closed")).toBe(true);
  });

  it("rejects the illegal jump todo->done", () => {
    expect(isLegalTransition("todo", "done")).toBe(false);
  });

  it("rejects todo->review (must pass through in_progress)", () => {
    expect(isLegalTransition("todo", "review")).toBe(false);
  });

  it("permits the dispatch-bridge path todo->in_progress->done", () => {
    expect(isLegalTransition("todo", "in_progress")).toBe(true);
    expect(isLegalTransition("in_progress", "done")).toBe(true);
  });

  it("allows reopening: done->in_progress and closed->todo", () => {
    expect(isLegalTransition("done", "in_progress")).toBe(true);
    expect(isLegalTransition("closed", "todo")).toBe(true);
  });

  it("closed only reopens to todo, never straight back to done", () => {
    expect(isLegalTransition("closed", "done")).toBe(false);
    expect(allowedNextStates("closed")).toEqual(["todo"]);
  });

  it("marks done and closed terminal, others non-terminal", () => {
    expect(isTerminalStatus("done")).toBe(true);
    expect(isTerminalStatus("closed")).toBe(true);
    for (const s of ["todo", "in_progress", "blocked", "review"] as IssueStatus[]) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });
});
