# Commit Scope (Required for every agent)

Every commit must touch only files inside the lane your agent role declares in its `AGENTS.md`. If you find yourself editing files outside your lane, you are doing someone else's job — stop, restore those files, and continue with your own.

## Why this exists

On 2026-04-27, four agents in one session shipped destructive cross-cutting edits unrelated to their assigned tickets:

- **QAEngineer** assigned to a *test plan* hardcoded `randomUUID = () => "fixed-uuid"` in production policy-engine code
- **BackendEngineer** assigned to *build the MCP server* did zero MCP work and instead made unrelated edits across docs / scanner / tests, including a 12/12-failing integration test
- **TechnicalWriter** assigned to *scrub team-name refs in docs* edited production scanner Python
- **CEO** auto-commit captured off-scope edits to `scanner.ts` and `loader.ts` (silent input mutation hiding incomplete rule packs)

Every one of these regressions reached `main` because nothing in the substrate enforced commit-to-ticket scope. Each was reverted by Coordinator. See `agents/_shared/LEARNINGS.md` Learnings #15, #16, #17.

The cost of asking before reaching outside your lane is one comment. The cost of getting it wrong is a Coordinator revert and a reopened ticket.

## Protocol — run before every `git add` / `git commit`

### Step 1 — Inspect the working tree

```bash
git status --porcelain
```

### Step 2 — Verify every changed path is in your lane

Your lane is defined in your role's `AGENTS.md` under the **"Your lane"** section near the top. If your AGENTS.md doesn't have one yet, ask Coordinator before committing.

### Step 3 — Restore anything outside your lane

For each path outside your lane:

```bash
git checkout HEAD -- <path-outside-lane>
```

Do **not** stage those files. Do **not** commit them. They belong to a different agent's lane.

### Step 4 — Decide

Three legitimate outcomes after the scope check:

1. **Everything in your lane covers your ticket** → stage and commit normally.
2. **Your ticket genuinely requires changes outside your lane** → mark the issue `blocked`, post a comment naming the exact other-lane file you need changed, the change required, and which role owns it. Coordinator routes it.
3. **You did off-scope work by accident** → restore those files (Step 3) and stage only the in-lane work.

There is no fourth outcome. "I'll leave it because it's a small fix" is how the four 2026-04-27 regressions shipped.

## Pre-commit one-liner you can paste

Replace `<lane-glob>` with your role's allowed prefix(es) (e.g., `docs/` for TechWriter, `packages/agentos-d/` for BackendEngineer):

```bash
git status --porcelain | awk '{print $2}' | grep -v -E '^(<lane-glob>)' && echo "OFF-SCOPE FILES — restore before committing" || echo "scope ok"
```

## What Coordinator does when this rule is violated

1. Reverts the commit.
2. Reopens the ticket with a comment naming the off-scope files and the lane violation.
3. Records the violation in `agents/_shared/LEARNINGS.md` if it's a new failure mode.

Coordinator does not negotiate this. The substrate's value proposition to customers (audit, idempotency, scope) starts inside the team building it.

## ProcessWatcher enforcement

ProcessWatcher (AWO-164) also detects off-lane commits by consuming the scope-guard revert log and posting comments on offending tickets. Coordinator reverts are the immediate fix; ProcessWatcher ensures the violation is surfaced in the daily digest.
