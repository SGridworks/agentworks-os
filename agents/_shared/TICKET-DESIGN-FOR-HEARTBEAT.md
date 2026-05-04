# Ticket Design for Heartbeat-Shot Agents

How to write tickets that gpt-oss:120b agents on a 30-minute heartbeat
will actually finish, instead of producing a plan and exiting. Captured
2026-04-28 after AWO-172 (investigation) and AWO-173 (implementation)
both failed in the same way: agent acknowledged, posted a status comment,
ran out of context budget on planning, exited with zero deliverable.

## The failure mode

A heartbeat run is one shot. The agent reads the prompt, calls tools,
writes prose, hits context compaction (~100KB of tool output), emits a
final response, and the process exits. There is no second chance within
the same run. Multi-shot recovery happens, but each new shot starts
cold from the prompt + ticket comments.

`gpt-oss:120b` in particular spends most of its first-shot budget on
reasoning about the task before taking action. By the time it commits
to a concrete first step, context is half-eaten. Real engineering work
(grep, read, edit, test) doesn't fit.

The fix is on the ticket side. Tickets shaped to fit one heartbeat shot
get done. Tickets shaped as "investigate / design / harden / refactor"
generate plans, not work.

## Three archetypes

Every ticket should declare its archetype as the first line of the body:

```
Archetype: atomic | tracker | coordinator-only
```

### atomic — one shot, one deliverable

The default for engineering agents. One file change OR one test added
OR one config update. Closes in a single heartbeat run. ≤30 minutes
of agent time.

Required fields:

- **First action** — a literal command or edit, not a verb.
  - GOOD: ``Edit `packages/agentos-d/src/routes/cost-meter.ts:42` to
    return 503 when `breaker.open === true`.``
  - BAD: `Add circuit-breaker logic to the cost-meter route.`
- **Acceptance gate** — a literal command that returns 0 if done.
  - GOOD: `pnpm --filter agentos-d test -- cost-meter && grep -q
    "503" packages/agentos-d/src/routes/cost-meter.ts`
  - BAD: `Tests pass and the breaker works.`
- **Out of scope** — explicit list. Three lines max.
  - GOOD: ``Don't touch `packages/policy-engine/`. Don't add new
    deps. Don't change the CLI surface.``

If the ticket body doesn't fit in 15 lines after the three required
fields, it's not atomic. Decompose it.

### tracker — explicit checklist, multi-shot

For work that genuinely takes 5-10 atomic steps and where decomposing
would be artificial. Each heartbeat advances one or two checklist items.
Agent posts progress comments to make state resumable.

Required fields:

- **Checklist** — N items as `- [ ]` markdown checkboxes, each phrased
  like an atomic ticket's First Action.
- **Per-item acceptance** — each item has a one-line gate (file path,
  test name, grep) that the agent can confirm.
- **Stop conditions** — explicit "if you discover X, stop and post a
  comment; don't try Y."

The agent's per-shot workflow on a tracker:
1. Read the ticket and comments.
2. Find the first unchecked item.
3. Do that item only. Don't peek ahead.
4. Post a comment with: which item, what changed, what gate passed.
5. Update the checklist (PATCH the description if needed).
6. Exit.

When all items are checked, the next shot closes the ticket.

### coordinator-only — needs synthesis

Open-ended investigation, architecture decisions, cross-cutting reviews,
anything where "what's the right answer" is the whole question. Tag with
`coordinator-only: true` in the description and don't assign to an
engineering agent. The wake-on-assign daemon skips these by ignoring
tickets where the assignee is null or where the marker is set.

Examples that today belong here, not on an engineer's queue:
- "Investigate why X happens" (decompose into atomic greps and reads
  before re-routing to engineers, OR have Coordinator do the work
  directly)
- "Decide between approach A and B"
- "Review whether the substrate is ready to ship"

## What every ticket must NOT do

Today's failures all violated at least one of these. They look harmless
at filing time and break in heartbeat reality:

- **No "Investigate", "Design", "Harden", "Refactor", "Polish" verbs in
  titles.** These signal coordinator-only work mis-assigned to an agent.
- **No "everything in directory X" scope.** That's an architecture
  ticket, not an engineering ticket. Decompose.
- **No nested deliverables.** "Add the CLI binary AND write the tests
  AND update docs AND wire the installer" → 4 atomic tickets, not one.
- **No prose-only acceptance.** "It should work end-to-end" gives the
  agent no gate; it'll fake-complete (Learning #19) or plan-and-exit.
- **No assumed context.** If the ticket says "follow the pattern from
  the X module," the agent won't find X. Cite the exact file and lines.

## How Coordinator authors a ticket

Pick the archetype first. If atomic, write the three required fields
and stop. If tracker, write the checklist and each item's gate. If
coordinator-only, mark the assignee null and tag accordingly.

Read the body back as if you're an agent on a 30-minute heartbeat with
a verbose-reasoning model. If the first thing you'd do is "make a
plan," the ticket is too big. Decompose and re-file.

## Why this is a substrate concern, not a workflow nicety

The wake-on-assign daemon (added 2026-04-28) closes the latency gap
between filing and pickup. But latency was never the real problem —
the real problem is that agents don't finish what they pick up. Better
ticket shapes are the durable fix. Wake-on-assign + atomic tickets is
how the queue actually clears.

Pair this doc with Learning #19 (auto-commit captures WIP, agents
misread as done) and Learning #20 (custom AGENTS.md replaces default
template). Together they describe the three classes of "agent looks
busy but ships nothing":

- §19: agent fakes a close on partial work.
- §20: agent never gets the task body, asks "what task?".
- This doc: agent gets the task body but the task is shaped wrong, so
  it produces a plan instead of a deliverable.
