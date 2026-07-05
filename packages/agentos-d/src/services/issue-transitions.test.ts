import { describe, it, expect } from "vitest";
import {
  isLegalTransition,
  allowedNextStates,
  isTerminalStatus,
  LEGAL_TRANSITIONS,
  type IssueStatus,
} from "./issue-transitions.js";

describe("issue-transitions state machine", () => {
  it("allows a self-transition for every status, for any actor", () => {
    (Object.keys(LEGAL_TRANSITIONS) as IssueStatus[]).forEach((s) => {
      expect(isLegalTransition(s, s)).toBe(true);
      expect(isLegalTransition(s, s, "agent")).toBe(true);
      expect(isLegalTransition(s, s, "human")).toBe(true);
    });
  });

  it("allows the documented forward path todo->in_progress->review->done", () => {
    expect(isLegalTransition("todo", "in_progress")).toBe(true);
    expect(isLegalTransition("in_progress", "review")).toBe(true);
    expect(isLegalTransition("review", "done")).toBe(true);
  });

  it("rejects todo->review (must pass through in_progress)", () => {
    expect(isLegalTransition("todo", "review")).toBe(false);
  });

  // Regression lock: these three edges were missing from the old graph and
  // caused legitimate bridge/review-adapter PATCHes to 409. They must be
  // legal for ANY actor (no operator gating on forward progress).
  describe("previously-missing edges are now legal for any actor", () => {
    it("todo -> done (bridge completes an issue that skipped mark-in-progress)", () => {
      expect(isLegalTransition("todo", "done")).toBe(true);
      expect(isLegalTransition("todo", "done", "agent")).toBe(true);
      expect(isLegalTransition("todo", "done", "system")).toBe(true);
    });

    it("review -> todo (review adapter changes-requested path)", () => {
      expect(isLegalTransition("review", "todo")).toBe(true);
      expect(isLegalTransition("review", "todo", "agent")).toBe(true);
    });

    it("blocked -> done (bridge completes a blocked issue)", () => {
      expect(isLegalTransition("blocked", "done")).toBe(true);
      expect(isLegalTransition("blocked", "done", "agent")).toBe(true);
    });
  });

  it("permits the dispatch-bridge path todo->in_progress->done", () => {
    expect(isLegalTransition("todo", "in_progress")).toBe(true);
    expect(isLegalTransition("in_progress", "done")).toBe(true);
  });

  describe("operator gating on closed + reopen", () => {
    it("rejects -> closed for agent/system/absent actor", () => {
      for (const from of ["todo", "in_progress", "blocked", "review", "done"] as IssueStatus[]) {
        expect(isLegalTransition(from, "closed")).toBe(false);
        expect(isLegalTransition(from, "closed", "agent")).toBe(false);
        expect(isLegalTransition(from, "closed", "system")).toBe(false);
      }
    });

    it("allows -> closed for a human actor", () => {
      for (const from of ["todo", "in_progress", "blocked", "review", "done"] as IssueStatus[]) {
        expect(isLegalTransition(from, "closed", "human")).toBe(true);
      }
    });

    it("rejects reopening done -> in_progress for agent/system/absent actor", () => {
      expect(isLegalTransition("done", "in_progress")).toBe(false);
      expect(isLegalTransition("done", "in_progress", "agent")).toBe(false);
      expect(isLegalTransition("done", "in_progress", "system")).toBe(false);
    });

    it("allows reopening done -> in_progress for a human actor", () => {
      expect(isLegalTransition("done", "in_progress", "human")).toBe(true);
    });

    it("allows reopening closed -> todo for a human actor only", () => {
      expect(isLegalTransition("closed", "todo")).toBe(false);
      expect(isLegalTransition("closed", "todo", "agent")).toBe(false);
      expect(isLegalTransition("closed", "todo", "human")).toBe(true);
    });

    it("never allows closed -> done, even for a human (done is terminal, not a reopen target)", () => {
      expect(isLegalTransition("closed", "done", "human")).toBe(false);
      expect(isLegalTransition("done", "closed", "human")).toBe(true); // closing done is fine
    });
  });

  describe("allowedNextStates reflects actor gating", () => {
    it("excludes closed for a non-human actor", () => {
      expect(allowedNextStates("todo")).toEqual(["in_progress", "blocked", "done"]);
      expect(allowedNextStates("todo", "agent")).toEqual(["in_progress", "blocked", "done"]);
    });

    it("includes closed for a human actor", () => {
      const list = allowedNextStates("todo", "human");
      expect(list).toContain("closed");
      expect(list).toEqual(expect.arrayContaining(["in_progress", "blocked", "done", "closed"]));
      expect(list.length).toBe(4);
    });

    it("is empty for done/closed when actor is not human", () => {
      expect(allowedNextStates("done")).toEqual([]);
      expect(allowedNextStates("closed")).toEqual([]);
    });

    it("lists closed + all non-terminal states for done/closed when actor is human", () => {
      const fromDone = allowedNextStates("done", "human");
      expect(fromDone).toEqual(
        expect.arrayContaining(["todo", "in_progress", "blocked", "review", "closed"]),
      );
      expect(fromDone.length).toBe(5);

      const fromClosed = allowedNextStates("closed", "human");
      expect(fromClosed).toEqual(
        expect.arrayContaining(["todo", "in_progress", "blocked", "review"]),
      );
      expect(fromClosed).not.toContain("done");
      expect(fromClosed.length).toBe(4);
    });
  });

  it("marks done and closed terminal, others non-terminal", () => {
    expect(isTerminalStatus("done")).toBe(true);
    expect(isTerminalStatus("closed")).toBe(true);
    for (const s of ["todo", "in_progress", "blocked", "review"] as IssueStatus[]) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });
});
