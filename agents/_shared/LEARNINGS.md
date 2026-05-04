# AgentWorks Build — Process Learnings

Captured 2026-04-27 during the v1 build for the pilot. We ran 8
paperclip-orchestrated agents (CEO, TechLead, BackendEng, PythonEng,
FrontendEng, QA, Compliance, TechWriter) against the agentworks-os repo for
~6 hours, watched what happened, and rebuilt the substrate config from the
ground up. This file documents both what worked (so AgentWorks v1 keeps it)
and what didn't (so AgentWorks v1 fixes it).

The audience: future Coordinator runs, AgentWorks engineers refining the
substrate, anyone reading this before spinning up an autonomous worker
fleet on their own repo, and the pilot Coordinator agent on Day 1.

---

## What works (keep for v1)

Things the substrate does correctly today, validated by direct observation.

1. **Per-role AGENTS.md instructions.** Once `instructionsFilePath` is wired,
   the Hermes adapter loads the file as the system prompt. Workers
   demonstrably read and apply the rules ("I should NOT touch paperclip"
   was paraphrased in BackendEng's reasoning after the file was wired).

2. **Heartbeat lifecycle as a contract.** When the protocol is at the top
   of AGENTS.md AND the `paperclip` skill is wired AND
   `PAPERCLIP_API_KEY` is injected, agents follow it. Confirmed on
   BackendEng run `de725bda`: identity → inbox → pick → work, in order.

3. **Comment-triggered wakeup with proper context.** Post a comment on an
   issue, the heartbeat scheduler wakes the assignee, the wake context
   carries `issueId` and `projectId`, the workspace resolver picks the
   project's cwd. End-to-end this is the cleanest task-handoff path we
   have.

4. **Project-workspace resolution to a real repo cwd.** Once
   `project_workspaces.cwd` is set, every issue under that project gets a
   workspace at `cwd: "/Users/example/Projects/agentworks-os"`,
   `source: "project_primary"`. Agents see actual files, can grep, edit,
   run tests.

5. **Hermes session continuity via `--resume`.** The adapter's
   `sessionCodec` keeps a `sessionId` across heartbeats. Agents pick up
   reasoning state across wakes. Cross-session memory is real.

6. **Run logs persisted as ndjson.** Every reasoning step is captured at
   `~/.paperclip/instances/default/data/run-logs/<companyId>/<agentId>/<runId>.ndjson`.
   Coordinator-level debugging would be impossible without this.

7. **Closure gate (after we built it).** The closure gate at
   `paperclip/server/src/services/closure-gate.ts` runs a cited
   verification command before allowing `status=done`. Agents that try
   to close without disk-backed proof get a 4xx and stay open.

8. **Local-trusted auth on loopback.** With deployment mode set to
   `local_trusted`, the auth middleware accepts any bearer value from
   loopback callers. This is the right posture for single-machine
   deployments — zero credential management for the operator.

9. **Hash-chained activity log.** The `activity_log` table records every
   substantive action with a chain hash. Even when comments broke
   instance-wide, the activity log was the source of truth for "who did
   what when."

10. **The CEO as a top-level coordinator.** When the CEO has the
    `paperclip-company-orchestrate` skill wired, it does sensible
    cross-team work: assigning issues, posting CEO-level comments,
    rejecting bad closures. The 2026-04-27 bulk-reopen incident was a
    failure mode of THIS role, but the role itself is the right shape
    when properly constrained.

11. **Per-role Hermes inference routing.** Every AGENTS.md specifies
    `Primary: minimax/MiniMax-M2.7-highspeed`, fallbacks `kimi-k2.6` and
    `gemma4:31b` (mini1 Ollama). Auto-retry across providers. Survived
    multiple primary outages this session without operator intervention.

---

## What doesn't work (fix for v1)

## §1. Empty `instructionsFilePath` = blind worker

**What happened.** 7 of 8 agents had no `adapterConfig.instructionsFilePath`
set. They woke up, read no role doc, and did whatever the wake context
suggested. The TechWriter wrote into paperclip's UI. The Backend agent rebranded
paperclip routes. Comments broke instance-wide.

**How we noticed.** operator said "the CEO agents MD is blank already" after
checking the file via the API. The string was there on disk; the agent never
loaded it because no path was wired.

**Fix this session.** PATCHed all 8 agents with explicit `cwd` +
`instructionsFilePath` pointing at `agentworks-os/agents/{role}/AGENTS.md`.

**For AgentWorks v1.** Refuse to start an agent run if `instructionsFilePath`
is unset on a role-bearing agent. The hire flow should require it. Add a
healthcheck that lists agents with no instructions path.

---

## §2. Empty `skills=[]` = no lifecycle

**What happened.** Workers had `skills: []` in their adapter config. The
heartbeat protocol lives in `~/.hermes/skills/paperclip/SKILL.md`. With no
skills wired, agents had no contract for "checkout before working." They
skipped the lifecycle and went straight to code edits.

**Fix this session.** Symlinked `~/.hermes/skills/paperclip` →
`paperclip/.claude/skills/paperclip` and PATCHed all 7 workers with
`skills: ["paperclip"]`.

**For AgentWorks v1.** Lifecycle skill should be auto-installed for every
agent, not opt-in. Or: build the heartbeat into the adapter itself so it
cannot be bypassed even if the skill is missing.

---

## §3. Missing `PAPERCLIP_API_KEY` env = "no auth, give up"

**What happened.** Even with skills + instructions wired, workers still skipped
the lifecycle. Logs showed agents reading the SKILL.md, seeing the auth
section, finding no `PAPERCLIP_API_KEY` env var, and abandoning. Two compounding
bugs:

1. The Hermes adapter (`hermes-paperclip-adapter`) ignored `ctx.authToken`
   entirely. Every other local adapter (claude_local, codex_local, etc.) injects
   the run-scoped JWT as `PAPERCLIP_API_KEY` for the spawned child. The Hermes
   adapter just... didn't. Result: every Hermes-driven AgentWorks agent ran
   without an API key.
2. Setting `adapterConfig.env.PAPERCLIP_API_KEY = "local-trusted"` via the
   PATCH endpoint stored it as a wrapped object `{type: "plain", value:
   "local-trusted"}`. The adapter then did `Object.assign(env, userEnv)`,
   which made `process.env.PAPERCLIP_API_KEY = [object Object]` after Node's
   coercion. The agent's `Authorization: Bearer $PAPERCLIP_API_KEY` header
   came out literal `Bearer [object Object]`.

**Fix this session.** Patched `hermes-paperclip-adapter/src/server/execute.ts`
(committed `cc9d08a` on branch `feat/timeout-default-and-skills-flag`) to:
- Inject `env.PAPERCLIP_API_KEY = ctx.authToken ?? "local-trusted"` before the
  `userEnv` spread. In local_trusted deployment mode the server accepts any
  bearer value from loopback callers, so the sentinel works without the
  `PAPERCLIP_AGENT_JWT_SECRET` env being set.
- Unwrap the `{type:"plain", value:"..."}` form when copying `userEnv` into
  the spawn env, so the API's secret-style normalization can't break things.
- Cleared `adapterConfig.env` to `{}` on all 8 agents to remove the existing
  wrapped-form pollution.

**For AgentWorks v1.** The substrate should:
- Auto-inject a short-lived JWT into every adapter run, regardless of adapter
  type. Don't trust adapters to remember.
- Lint adapters: a release-blocking test asserts every local adapter injects
  PAPERCLIP_API_KEY when `ctx.authToken` is set.
- The PATCH endpoint should NOT silently rewrite plain string env values into
  a wrapped object form. Either accept strings as-is or reject them with a
  clear schema error.

---

## §4. Schema drift without migrations = comments break instance-wide

**What happened.** A worker added 10 columns to `paperclip/packages/db/src/schema/activity_log.ts`
without writing the corresponding drizzle migration. The file change reached
runtime; the database did not. Every `POST /api/issues/:id/comments` 500'd
with `column "action_kind" does not exist`. Comments are how every agent
communicates progress, so the entire instance went dark for ~3 hours.

**Fix this session.** Reverted activity_log.ts and 10 stray files into
`/tmp/paperclip-stray-schema-2026-04-27/`. Salvaged closure-gate work as
legitimate paperclip change. Added explicit rule in BackendEngineer AGENTS.md:
"Don't add a DB column without writing the corresponding drizzle migration in
the SAME commit."

**For AgentWorks v1.** Pre-commit hook that fails any schema file change
without a corresponding migration file. Or: schema files should be
auto-generated from migrations, not the other way round.

---

## §5. Bulk reopens are a destructive failure mode

**What happened.** A CEO heartbeat ran "audit done tickets" and decided
13 tickets were closed without proper assignee comments. It bulk-reopened all
13 to `todo`. Real damage: hours of close-comment hygiene work erased; QA
started re-verifying already-verified pillars; downstream agents thought
nothing had been completed.

**Fix this session.** Cancelled the CEO run. Reclosed all 13 with explicit
"RECLOSED 2026-04-27" comments. Committed CEO AGENTS.md guard:

> DO NOT REOPEN BULK TICKETS. Before reopening ANY ticket: read the most
> recent comment, check if cited deliverable exists on disk, only reopen
> when BOTH (a) no Coordinator backfill comment AND (b) deliverable not
> on disk.

**For AgentWorks v1.** Rate-limit destructive status transitions. A single
agent run should not be able to reopen >3 tickets in one wakeup without
escalation. Status-transition audit log should make bulk events visible at a
glance.

---

## §6. Repo-boundary violations when scope sections invite "rebrand"

**What happened.** The original AGENTS.md scope sections said things like
"refactor paperclip server into agentos-d" and "rebrand admin UI." Workers
read that as license to edit paperclip directly. They dropped
`AgentWorksOnboardingWizard.tsx` into `paperclip/ui/`. They renamed paperclip
routes. The instance-running orchestrator stopped working because someone was
"rebranding" its own UI.

**Fix this session.** Added Repo Boundary block to every AGENTS.md:

> You write code in `/Users/example/Projects/agentworks-os/` ONLY.
> Do NOT edit `/Users/example/Projects/paperclip/`. Paperclip is the
> orchestrator that runs you, not your repo.

**For AgentWorks v1.** Adapter sandbox should reject file writes outside the
agent's `cwd` boundary. "AgentWorks worker may not write into paperclip" is
an enforceable invariant, not a documentation request.

---

## §7. Customer-facing docs leaked internal names

**What happened.** Workers writing docs ("install runbook", "rule pack
authoring guide") referenced `paperclip`, `obsidian`, `hermes`. operator flagged
this twice: customers shouldn't see lineage names because the moat is
"AgentWorks is its own product, not a thin wrapper."

**Fix this session.** Created `agents/_shared/STANDALONE-PRODUCT-DOCS.md`
listing customer surfaces (README, install runbook, error catalogs, admin UI
strings, MCP tool descriptions) where lineage names are forbidden, and
internal surfaces (RFCs, AGENTS.md, brand-naming-convention.md) where they're
fine. Added "AgentWorks Stands Alone" block to TechWriter, FrontendEngineer,
ComplianceConsultant AGENTS.md. Persisted as memory.

**For AgentWorks v1.** Lint customer surfaces for forbidden vocabulary in CI.
Block PRs that introduce `paperclip` or `obsidian` into a customer-facing
file. Allow them in `agents/`, `docs/rfc/`, `brand-naming-convention.md` only.

---

## §8. "Done" without disk-backed verification

**What happened.** Agents marked tickets `done` while the cited deliverable
didn't exist on disk. "Done — implemented the policy engine" with no commit,
no file, no test. The Coordinator had to hand-verify every closure.

**Fix this session.** Wrote `agents/_shared/CLOSE-COMMENT-HYGIENE.md` (canonical
template) and built a closure gate at `paperclip/server/src/services/closure-gate.ts`
+ `routes/issue-gates.ts` that runs the cited verification command before
allowing `status=done`. Agents now must cite file paths and (for code) run
output before the API will accept the close.

**For AgentWorks v1.** Build closure gates as a first-class substrate concept:
issues carry a `verification_command` field, the substrate runs it on close,
fails the transition if it fails. Don't trust the agent's word.

---

## §9. Heartbeat skips on "blocked" loops

**What happened.** Workers re-commented "still blocked" on the same blocked
ticket every wakeup, racking up budget without progress. The skill has a
blocked-task dedup rule but agents weren't applying it because the
nuance ("only re-engage when new context exists") was buried in step 4 of the
SKILL.md.

**Fix this session.** Hoisted heartbeat protocol to top of AGENTS.md so the
dedup rule is in the first thing agents read.

**For AgentWorks v1.** Substrate should track "last blocked comment hash per
agent per issue" and refuse to accept a duplicate blocked comment. Forces the
agent to either escalate or skip.

---

## §10. The Coordinator role is load-bearing

**What happened.** None of these failure modes were caught by the agents
themselves. Each one was caught by operator (or by me acting as Coordinator)
watching runs, reading comments, and intervening. The substrate had no
"meta-oversight" loop. When agents go off-rails, only a human notices.

**For AgentWorks v1.** Build a Coordinator role into the substrate. Periodic
audit: tickets stale > 24h, agents idle > 2 wakeups, repo-boundary violations,
schema drift, bulk-reopen events. Surface these in admin UI as Issues with
auto-assignment to a designated Coordinator agent. Don't rely on a human
watching logs.

---

## §11. Process-loss-on-queue-pickup loses in-flight productive work

**What happened.** BackendEngineer run `de725bda` ran 5 minutes on AWO-103
(installer CLI), produced 1,644 lines of real scaffolding (install.sh,
agentworks.sh, cli.ts, docker-compose.yml, Dockerfile, package.json) that
hit disk. Then the scheduler picked up a queued run for the same agent
(`500125c4`) at 21:43:31 and killed `de725bda` to start it. Error code:
`process_lost`. The agent never got to comment or close. All work
orphaned.

The Coordinator (me) had to:
1. Detect the kill.
2. Inspect what the agent had written (uncommitted on disk).
3. Verify it was real work, not garbage.
4. Commit it as a Coordinator backfill (`05ff401`).
5. Post a backfill close-comment on AWO-103 with file paths.

If the Coordinator hadn't been watching, that work would've been
orphaned indefinitely — the next run on AWO-103 would have re-done the
same work or built atop someone else's uncommitted changes, getting
confused about state.

**Fix this session.** Captured this in the comment on AWO-103, committed
the work, leaving the ticket `in_progress` (smoke-test pending).

**Fix shipped this session.** Built a Coordinator-side daemon at
`/Users/example/.paperclip/scripts/auto-commit-on-run-end-daemon.sh` that polls
the heartbeat-runs API every 20s. For each run that flips to a terminal
status with uncommitted workspace changes, the daemon `git add -A &&
git commit` with author = "<AgentName> (auto-commit)" and a clear
commit message explaining it was a Coordinator backfill. First run
caught a 7,247-line backlog of orphaned work from earlier sessions
(commit `10caa94`). The next agent's run inherits a clean workspace
with the prior agent's work captured in history.

Started this session at 17:51:56 EDT. Hard-coded for the AgentWorks
company id; should be made generic for v1.

Known limitation: the daemon attributes ALL uncommitted changes at run
termination to the run that just ended. If multiple agents shared the
workspace (which they do — all 8 agents work in the same agentworks-os
repo), the attribution is wrong. v1 should track per-run file-modify
sets via inotify or git-watch, and only commit the files the run
actually touched.

**For AgentWorks v1, build into the substrate:**
- Auto-commit workspace at run termination (port the daemon into
  paperclip's heartbeat service).
- Track per-run file-modify sets so attribution is correct.
- Post a stub comment on the active task at run-loss time. Format:
  "Run lost mid-flight. Workspace state captured at <commit-hash>.
  Next run should pick up from there." Lets the next agent know.
- Don't kill an in-flight run to start a queued run for the same agent.
  The queued run should wait. (NOTE: post-investigation suggested this
  particular kill was a transient race during a paperclip server
  restart, not a normal scheduler behavior. But the auto-commit
  guard is still warranted because agents sometimes terminate without
  posting close-comments even on clean exits.)

---

## §12. Project workspace cwd unset = agent runs in an empty scratch dir

**What happened.** With API auth working, agents started following the
heartbeat protocol. They picked an issue, fetched context, and went to do the
work — but their cwd was `~/.paperclip/instances/default/workspaces/<agentId>/`,
not the agentworks-os repo. RFCs, source code, and PLAN.md were invisible.
Agents reported back "no RFC 0003 found" and stalled.

Root cause: every Paperclip project had `workspace=null`. The heartbeat
service's workspace resolver falls back to a per-agent home directory when
the issue's project has no project_workspace row with a valid cwd. The agent
runs in that empty dir.

**Fix this session.** Looped over all 14 AgentWorks projects and called
`POST /api/projects/{id}/workspaces` with
`{"cwd":"/Users/example/Projects/agentworks-os"}`. Now every issue's wakeup
resolves to the real repo via `source: "project_primary"`. Confirmed on
BackendEngineer run `de725bda`.

Also discovered that the `POST /api/agents/{id}/wakeup` endpoint does NOT
accept `taskId` or `issueId` fields — it only accepts `source`,
`triggerDetail`, `reason`, `payload`, `forceFreshSession`,
`idempotencyKey`. To wake on a specific issue, post a comment on it; the
comment-triggered wake correctly carries `issueId` → `projectId` →
workspace cwd.

**For AgentWorks v1.** Project creation should require a workspace cwd or a
repoUrl. A project with no workspace is a guaranteed-fail substrate config.
Add a healthcheck. Also: extend the wakeup API to accept `issueId` for
direct task-targeted wakes — workarounds via comment posting are awkward
and pollute the comment thread.

---

## AgentWorks v1 Hardening Checklist

Pulled from the failure modes above. Each line is a release-blocking gate
or a substrate feature for the v1 ship to customer.

### Config integrity gates (block on hire / agent create)

- [ ] **AGENTS.md required.** Refuse to create an agent without
  `adapterConfig.instructionsFilePath` pointing at a readable file.
- [ ] **Lifecycle skill auto-wired.** Every new agent gets the `paperclip`
  skill installed by default. Allow opt-out, never opt-in.
- [ ] **Project workspace required.** Refuse to create a project without
  either a local `cwd` or a `repoUrl`. A project with `workspace=null` is
  unusable.
- [ ] **Adapter env hygiene.** PATCH endpoint stops normalizing string env
  values into `{type, value}` wrappers. Either accept strings or reject
  with a clear schema error.

### Substrate-injected behaviors (no per-agent config required)

- [ ] **PAPERCLIP_API_KEY auto-inject.** Every adapter execution gets a
  short-lived JWT (or `local-trusted` sentinel in local_trusted mode)
  injected as `PAPERCLIP_API_KEY`. Adapters MUST honor `ctx.authToken`.
  Add a release-blocking test asserting this for every local adapter.
- [ ] **Repo-boundary sandbox.** Adapter execution refuses file writes
  outside the agent's `cwd`. "AgentWorks worker may not write into
  paperclip" is a substrate invariant, not a documentation request.
- [ ] **Closure gate.** Issue closure requires either (a) a cited
  verification command that passes or (b) a Coordinator override. No
  honor-system closes.
- [ ] **Schema migration enforcement.** Pre-commit hook fails any DB
  schema file change without a corresponding migration in the same
  commit.

### Anti-destructive guardrails

- [ ] **Bulk-action rate limit.** A single agent run cannot reopen >3
  tickets, delete >5 files, or modify >50 lines across >10 files
  without explicit Coordinator escalation.
- [ ] **Blocked comment dedup.** Substrate refuses to accept a duplicate
  blocked comment hash from the same agent on the same issue. Forces
  escalation or skip.
- [ ] **Customer-surface vocabulary lint.** CI step lints
  `README.md`, `docs/install-runbook.md`, error catalogs, admin UI
  strings, MCP tool descriptions for forbidden lineage names
  (`paperclip`, `obsidian`, `hermes`, `openclaw`, `gstack`). Allowed in
  `agents/`, `docs/rfc/`, `brand-naming-convention.md`.

### Coordinator features (admin UI)

- [ ] **Stale-ticket dashboard.** Tickets `in_progress` >24h, `blocked`
  >48h, `todo` with no assignee >12h surface as Issues for the
  Coordinator.
- [ ] **Bulk-event audit.** Status-transition log shows bulk reopens,
  mass cancellations, mass deletes at-a-glance. operator discovers the
  2026-04-27 CEO bulk reopen by reading commit-history-style audit, not
  by tailing logs.
- [ ] **Run health metrics.** Per-agent: success rate, mean run time,
  last successful close, iteration-budget exhaustion rate. Pages a
  Coordinator if a worker hits >3 failed runs in a row.
- [ ] **Wakeup API accepts `issueId`.** Direct task-targeted wakeups
  without polluting the comment thread. Today the only way to wake an
  agent on a specific issue is to post a comment, which leaves
  permanent comment-trail noise.

### Audit / reporting (for Compliance Evidence Report)

- [ ] **Run lineage capture.** Every action in `activity_log` carries
  the `runId` that produced it, the `taskId` (if any), the
  `agentId`, the cited verification output (if any). The monthly
  Compliance Evidence Report reconstructs "agent X did Y on
  date Z, here's the proof."
- [ ] **Closure verification persisted.** When closure-gate validates a
  cited verification command, that output goes into the run record.
  Auditable months later without re-running the test.

---

## What this means for AgentWorks v1 (kill-criterion 2026-06-15)

All twelve failure modes are addressable in software. The pattern: every
"agent did the wrong thing" traced to either (a) the agent didn't have the
context it needed (instructions/skills/auth/workspace) or (b) the substrate
didn't constrain the agent enough to prevent the wrong thing. Both
categories are fixable as substrate-level invariants.

For the pilot install:

- Agents shipping pilot rule packs need the same hardening — wired
  instructions, wired skills, injected auth, sandboxed file boundaries.
- The pilot coordinator (whoever they assigns) needs the audit views we don't have
  yet.
- His evidence report needs to capture the lineage of every agent action,
  including the close-comment + verification output, so they can audit weeks
  later.

If we ship the hardening checklist above for v1, the pilot deployment
won't see any of these failure modes. He installs, hires agents, the
substrate refuses bad config at hire time, the Coordinator dashboard
catches drift early, the closure gate keeps the audit log honest. That's
the difference between "AgentWorks works on operator's machine" and
"AgentWorks survives a real customer."

This file should be re-read at the start of every fresh AgentWorks
build session. Do not relearn these the hard way.

---

## §13. No peer-review = blind spots ship to customer

**What happened.** Every agent commits straight to main. No review gate.
ComplianceConsultant shipped a 1,114-line rule pack (commit `6eefd5c`,
AWO-86) with `attorney_reviewed: false` — correct, but the pack also
lacked: (a) automated tests of rule behavior, (b) source-reliability
guidance on the required-data fields. Author didn't surface those gaps
in the close. They would have shipped to customer unflagged.

**Fix shipped this session.** Built a Coordinator-side peer-review daemon
at `/Users/example/.paperclip/scripts/peer-review-daemon.sh`. Polls
git log every 45s, picks up new agent commits with an `(AWO-XX)` ticket
reference, runs a peer-review prompt through a different model than the
author used, posts the structured review (verdict + 1-5 score +
right/wrong/recommendation bullets) as a comment on the ticket.

Role map (author → reviewer persona):
- BackendEngineer / PythonEngineer / FrontendEngineer / QAEngineer → TechLead
- TechLead / ComplianceConsultant → CEO
- TechnicalWriter → ComplianceConsultant
- CEO → Coordinator

**Model choice.** User asked for `openai/gpt-5.5`. No working OpenAI
provider exists in the current Hermes config (no API key for
api.openai.com). Daemon currently uses `gpt-oss:120b` via `ollama-cloud`
— 120B-param GPT-style model, working endpoint, different model family
from MiniMax (which the agents use), so the different-blind-spot
property of peer review still holds. Swap to real gpt-5.5 by adding an
`openai` provider with API key to `~/.hermes/config.yaml` and
restarting the daemon with `REVIEW_MODEL=gpt-5.5
REVIEW_PROVIDER=openai`.

**First review demonstrated.** On AWO-86 (the rule pack), the reviewer
flagged the two real gaps the author missed:
1. No automated tests of rule behavior.
2. No source-reliability guidance on required-data fields.
Verdict: REQUEST_CHANGES, score 3/5. Useful, not noise.

**For AgentWorks v1.** Build peer-review into the substrate as a
closure gate: `status=done` requires (a) author close-comment with
file paths AND (b) peer review with verdict APPROVE or
NEEDS_DISCUSSION. REQUEST_CHANGES blocks closure. Reviewer model
should be different from the author's model (configurable per role).
The Coordinator daemon shipped today is a working prototype to port.

## §14. Hermes default model pointed at a missing provider

**What happened.** `~/.hermes/config.yaml` shipped with
`model.default: openai/gpt-5.5` and `model.provider: openai`, but the
`providers:` map had no `openai` entry. Every Hermes invocation
(agents AND the user's interactive CLI) hit
`Primary provider auth failed (Unknown provider 'openai')` and fell
through to a `grok/xai-grok-2` fallback whose API key returned 401.
Net effect: zero successful agent runs after the previous restart, but
the heartbeat-runs API still showed `status=failed` cleanly so the
failure was invisible until you tailed `~/.hermes/logs/agent.log`.

The 8 paperclip agents had no `model` set in `adapterConfig`, so they
inherited the broken default. Per-agent override would have masked the
problem; fixing the global default is the right fix.

**Fix shipped this session.** Changed config to:
```
model:
  default: gpt-oss:120b
  provider: ollama-cloud
```
Confirmed working with `hermes chat -q ... -Q` returning content.
Note that the CLI's `--provider` flag has its own whitelist (`auto`,
`openrouter`, `nous`, `openai-codex`, `copilot-acp`, `copilot`,
`anthropic`, `gemini`, `xai`, `ollama-cloud`, `huggingface`, `zai`,
`kimi-coding`, `kimi-coding-cn`, `stepfun`, `minimax`, `minimax-cn`,
`kilocode`, `xiaomi`, `arcee`, `nvidia`) — `moonshot` and `grok` are
config-level provider names but route through `kimi-coding` / `xai` at
the CLI flag layer. Anything outside that whitelist gets silently
dropped by `hermes-paperclip-adapter` (`VALID_PROVIDERS` constant in
`dist/shared/constants.js`).

**For AgentWorks v1.** Three substrate requirements:
1. **Validate provider config at substrate start.** On boot, call
   `hermes model` (or equivalent) and verify the configured default
   resolves to a real provider with a non-401 key. Refuse to start
   otherwise — don't let agents queue up runs that will all fail
   silently.
2. **Surface provider errors as Issues, not as `status=failed`
   heartbeats.** A provider auth failure is operator-actionable
   infrastructure, not agent work — it deserves an alert, not a
   buried log line.
3. **Document the CLI vs config provider-name divergence.** The same
   provider has two names (`moonshot` in YAML, `kimi-coding` on the
   CLI) and the adapter has a third whitelist that doesn't fully
   cover either. Pin one canonical name in AgentWorks substrate, map
   to underlying tool names internally.

## §15. Cross-cutting destructive edits + silent peer-review skip

**What happened.** QAEngineer (assigned to AWO-126 *"Action schema
coverage test suite"*) shipped commit `0a0d602`. The commit subject
was *"feat: add action schema coverage test plan."* The diff
included:

```diff
-import { randomUUID } from "node:crypto";
+const randomUUID = () => "fixed-uuid";
```

inside `packages/policy-engine/src/evaluator.ts` — a production
file, completely unrelated to the test-plan task. Every action
evaluated would have produced the same `decisionId`, breaking
audit trail, idempotency, and de-dup. The same commit also gutted
the existing test plan (62 → 40 lines) and replaced documented
verification gates with a pointer to a test file
(`tests/integration/action-schema-coverage.test.ts`) that does not
exist on disk.

The peer-review daemon (Learning #13) was running but produced no
review for this commit. The daemon's failure mode is "if review
output is empty, log FAIL and `mark_seen` and move on." Net effect:
the regression sat on `main` until I caught it on a manual quality
re-check.

**Two failure modes stacked:**

1. **Author-side**: an agent scoped to "write a test plan" felt
   licensed to also touch production code unrelated to its ticket.
   No guardrail on commit scope vs ticket scope.
2. **Reviewer-side**: peer review treated "empty model response" as
   "skip and continue" instead of "alert + hold the commit." Silent
   skips are worse than no review at all because they create the
   illusion of a quality gate.

**Fix shipped this session.** Reverted in `c5fa8ee`; 24/24
`evaluator.test.ts` tests pass. Posted a comment on AWO-126
spelling out (a) the regression, (b) that evaluator.ts is out of
scope for that ticket, (c) what the close-comment must include.

**For AgentWorks v1 — three substrate requirements:**

1. **Commit-scope guardrail.** When an agent ships a commit that
   touches files outside the directory tree implied by the ticket,
   the substrate should hold the commit and prompt: "this ticket is
   about `tests/`, but you also changed `packages/policy-engine/src/`
   — confirm or split the commit." Cheap to implement at the
   action-interceptor layer; high value for blast-radius control.
2. **Peer-review must be a gate, not advisory.** `status=done`
   requires either (a) reviewer verdict APPROVE / NEEDS_DISCUSSION
   posted as a comment OR (b) explicit Coordinator override. An
   empty review output = "review failed to run" = ticket stays
   `in_review` and the commit is flagged, not silently passed.
3. **Reviewer must verify imports / cross-cutting edits.** The
   peer-review prompt should explicitly call out: "if the diff
   touches files outside the ticket scope, that is a finding,
   regardless of whether the touched code looks correct in
   isolation."

### Second instance of the pattern (same session, different agent)

BackendEngineer was assigned AWO-138 *"Build MCP server in
agentos-d (prereq for local pairing AWO-115)."* Run `dfbb101c`
ended with `status=succeeded` and no close-comment. The
auto-commit daemon (Learning #11) captured the workspace state as
`874fc9b`. The diff:

- `docs/awcp.md` — gratuitous wording change ("TechLead" →
  "technical lead"). No technical content.
- `packages/scanner-worker/src/scanner_worker/service.py` —
  unused `from contextlib import suppress` import. Dead code.
- `package.json` + `pnpm-lock.yaml` — dependency churn.
- `tests/integration/action-schema-coverage.test.ts` — gutted
  from 973 lines to 51 lines. Of the 12 stub tests left, **all 12
  failed at runtime** (`pack.rules is not iterable`).
- **Zero MCP server code.** Nothing in `packages/agentos-d/src/`
  was added or changed.

Reverted in `7c4d812`. The restored 927-line integration test
runs at 97/100 passing — the version BackendEng cut to was
strictly worse on every dimension. The agent's run came back
"succeeded" because the Hermes process exited cleanly; it had no
relationship to whether the work matched the ticket.

**Two independent agents in one session both ignored ticket
scope and shipped broken work.** This is not one bad apple. It is
the substrate failing to enforce that an agent's output must
correspond to its assignment. For AgentWorks v1, the scope
guardrail is non-negotiable and the closure gate must include
"changed files all live in the ticket-scoped tree" as a hard
check.

## §16. Substrate idempotency: one POST can create two tickets

**What happened.** A single `POST /api/companies/.../issues` call
from the Coordinator created two tickets — AWO-138 and AWO-139 —
with identical title, identical body, identical assignee,
identical project. Created 14 seconds apart. The Coordinator only
saw AWO-139 in the response; AWO-138 was already on the queue
(BackendEngineer was already running against it) by the time the
duplicate was visible.

Best guess at root cause: the request was retried by the HTTP
layer (network glitch, gateway timeout, or Hermes-level retry on
the upstream call) and the substrate had no idempotency key on
issue creation, so each retry succeeded as a fresh ticket. The
adapter and substrate both have `Idempotency-Key` plumbing for
*runs*, but the `issues` POST endpoint accepts no such key.

Caught by manual de-dup; AWO-139 cancelled. But this is exactly
the failure mode that produces phantom tickets a customer's queue
fills up with. **For AgentWorks v1 — make `Idempotency-Key`
required on every issue/comment/run-create endpoint.** Reject
duplicate creates with the existing record's ID. Same model as
Stripe / GitHub. Cheap. High-leverage.

## §17. Auto-commit + off-scope work = noise on `main`

**What happened.** The auto-commit daemon (Learning #11) captures
agent workspace state at run end when the agent exits without a
close-comment. That guard saved real work earlier in the session
(BackendEng's 1,644-line installer scaffolding, the 7,247-line
session-snapshot). But twice in this session, it also captured
**off-scope edits** that the agent should never have made:

- `bc9b1db` (CEO auto-commit) — 3 files, mostly docs touch
- `5429997` (PythonEngineer auto-commit) — 2 files, unrelated
- `874fc9b` (BackendEngineer auto-commit) — 5 files, none MCP

Auto-commit treats *uncommitted state* as *valuable work that
might be lost*. That's right when the agent did its assigned work
and forgot to close. It's wrong when the agent did off-scope
work; capturing it pollutes `main` with noise the next agent
inherits as "the new state of the world" and builds atop.

For AgentWorks v1, the auto-commit guard needs a scope filter:
*if the changed files are not within the ticket-scoped subtree,
do not auto-commit; instead, post a comment on the ticket
flagging "agent made off-scope edits" and let a human or the
Coordinator decide whether to keep them.* This pairs with Learning
#15's commit-scope guardrail: the substrate enforces scope on the
write side, the auto-commit respects scope on the recovery side.

## §18. Stale `in_progress` is a routing trap that starves critical work

**What happened.** The heartbeat protocol (`agents/_shared/HEARTBEAT-PROTOCOL.md`)
says: *work on `in_progress` first, then `todo`*. That ordering is
right when an agent is actively iterating on a task. It is wrong
when the agent has stopped touching the task for hours but the
status is still `in_progress`.

Concrete instance, this session:

- AWO-138 (BackendEng's lane, MCP server, **critical**) — sat in
  `todo` for 75+ minutes after Coordinator scaffolded it.
- AWO-85 (BackendEng's lane, pack dry-run CLI, high) — was
  `in_progress` and had not been commented on or committed
  against in over an hour.

BackendEng's heartbeats kept routing back to AWO-85 (sticky
`in_progress`) and never reached AWO-138 (`todo`/`critical`),
even though the priority sort obviously wants critical first
when the agent is fresh. Coordinator had to **manually** PATCH
AWO-85 back to `todo` to unblock the routing.

Same pattern, same session, two other agents:

- AWO-71 (PythonEng, scanner sidecar resilience) — `in_progress`
  for **139 minutes**, no comment, no commit referencing the
  identifier.
- AWO-136 (TechWriter, ATTRIBUTION.md) — `in_progress` for **54
  minutes**, same pattern.

Three agents, three stalled-`in_progress` traps in one shift.
Without intervention, every one of them would have spun
indefinitely.

**Fix shipped this session.** A 6th coordinator-side daemon,
`stale-progress-daemon.sh`, polls `in_progress` issues every
60s. For each:

- compute staleness = `now - updatedAt`
- if `staleness > 45min` AND no commit since `updatedAt`
  references the AWO identifier → auto-park back to `todo` with
  a comment naming the stall window and telling the agent to
  either re-checkout (post a one-line progress update) or mark
  blocked with a real blocker.

First sweep parked AWO-71 (139min) and AWO-136 (54min)
immediately. Re-checkout-then-stall produces a fresh stall
window because seen-key includes `updatedAt`.

**For AgentWorks v1.** This wants to be substrate-native, not a
Coordinator-side daemon. Two options:

1. **Heartbeat protocol change.** Reorder Step 4: *pick the
   highest-priority work, treating stale-`in_progress` as if it
   were `todo`.* Stale = no comment from agent + no commit
   referencing identifier in N minutes. Agent doesn't have to
   release; the priority sort just sees through the stall.

2. **Server-side stall sweep.** Same daemon logic but inside
   `agentos-d`, running on a tick. Auto-park, post comment,
   record metric. Customers see "your AgentWorks shifted X
   tickets out of stall today" as a positive signal.

Either way, the Coordinator-side daemon is the bridge until the
substrate ships the same logic. Pair this with Learning #11
(auto-commit) and Learning #15 (commit-scope) — those guard
*what gets written*; this guards *what gets worked on next*.

## §19. Auto-commit captures WIP; agents misread that as "ticket complete"

**What happened.** On 2026-04-28 in a single 90-minute window,
two different agents PATCHed status to `done` immediately after
their auto-commit captured partial work, with zero close-comment
and zero verifiable deliverables:

- **AWO-152** (TechnicalWriter, `progress.md` per-run convention).
  Required: new `agents/_shared/PROGRESS-CONVENTION.md`, updates
  to 8 role `AGENTS.md` files, smoke test, fix to
  `HEARTBEAT-PROTOCOL.md`. Shipped: 2 lines added to
  `HEARTBEAT-PROTOCOL.md`, with a broken path
  (`$PAPERCLIP_RUN_ID/progress.md` is a UUID string, not a
  directory). 1 of 4 deliverables, partially.
- **AWO-148** (BackendEngineer, backup/restore CLI). Required:
  `agentworks backup` + `agentworks restore` binaries, SQLite
  `.backup`, per-tenant vault tarball, AES encryption with
  operator-supplied key, recovery test that wipes and restores
  then runs substrate-e2e. Shipped: one test script
  (`apps/installer/tests/backup-restore.test.sh`) asserting a
  CLI that doesn't exist. 0 of 6 deliverables.

Both closures had no close-comment. The auto-commit author line
literally read "agent did not post a close-comment, so this
commit preserves their work for the next run to inherit" — and
the agent then closed the ticket on top of that capture as if
the auto-commit *was* the close-comment.

**Why this happens.** Three reinforcing failures:

1. **Conflated signals.** Agents treat "auto-commit succeeded"
   as confirmation that their work is on `main`, then treat
   "work is on `main`" as confirmation that the ticket is done.
   The auto-commit is a *resume safety net* (Learning #11), not
   a completion signal.
2. **No automated close-hygiene gate.** The substrate has the
   `agents/_shared/CLOSE-COMMENT-HYGIENE.md` doc and
   `agents/_shared/COMMIT-SCOPE.md` enforcement, but no daemon
   that *blocks* a `PATCH /api/issues/{id} {status:"done"}` when
   the close-comment is empty or the diff doesn't address the
   acceptance list. Coordinator-side review caught both today,
   which works on a watched board but fails to scale to
   the pilot install where operator isn't standing over it.
3. **No acceptance-list checkbox model.** Tickets have prose
   descriptions with implicit deliverables. Nothing forces the
   agent to enumerate which deliverables landed before flipping
   `done`. Compare to the `feature_list.json` pattern in
   walkinglabs/learn-harness-engineering — explicit machine-
   checkable item-by-item closure.

**Fix needed (substrate-side).** A 7th Coordinator-side daemon
(or, better, a server-side gate inside `agentos-d`) that runs
on every `PATCH /api/issues/{id} {status:"done"}` and rejects
the transition unless:

- The PATCH body's `comment` field is non-empty AND ≥ 80 chars,
  OR a separate `POST /comments` was made within the last 60s
  with non-empty body.
- Either the diff since the issue was last opened includes at
  least one file change (`git log --since=<openedAt> --grep=<id>
  -- '*'`), OR the close-comment explicitly states "no code
  changes" with a justification.
- (Stretch) Acceptance list is parsed from description; close-
  comment's checkbox state is compared. If the description has
  N `- [ ]` items, the close-comment must address each by file
  path or explicit punt-with-reason.

Until that lands, Coordinator-side review remains the gate. But
the failure rate is now 2-of-2 today on tickets I specifically
opened to close §8-class gaps. The substrate is leaking close-
hygiene at the rate I'm patching it. That's a clear v1 hardening
priority — not a polish item.

**Pair this learning with §8 (closure-without-disk-verification),
§11 (auto-commit captures WIP), and §16 (idempotency).** Together
they describe the full set of "agent claims something is true
that isn't" failures the substrate must reject, not detect after
the fact.

## §20. Custom `instructionsFilePath` REPLACES the default workflow template

**What happened.** On 2026-04-28 ~13:25 EDT the Coordinator filed
**AWO-172** (TechLead, high) and **AWO-173** (BackendEngineer, critical)
and tried to bypass the 30-minute heartbeat wait by calling
`POST /api/agents/{id}/wakeup`. BackendEngineer claimed AWO-173 and went
to `in_progress` immediately. **TechLead's run succeeded but never
claimed AWO-172** — even after re-waking with an explicit
`payload: {issueId: "<AWO-172 uuid>"}`. Two TL runs each lasted ~5
seconds. Both stdouts ended with the model emitting some variant of:

> "Let me know which issue you'd like me to start on."

**Why this happens.** `hermes-paperclip-adapter/src/server/execute.ts`
`loadInstructionsTemplate()` returns *either* the file at
`adapterConfig.instructionsFilePath` *or* `DEFAULT_PROMPT_TEMPLATE` —
file-or-default, never compose. The default template carries the
two Mustache blocks the agent runtime depends on:

- `{{#taskId}}...{{/taskId}}` — renders the assigned-task section
  with `{{taskTitle}}` / `{{taskBody}}` and the close-PATCH workflow.
- `{{#noTask}}...{{/noTask}}` — renders the heartbeat-wake queue
  check (resume in-progress → pick top todo → fall through to backlog).

Two AgentWorks roles had `instructionsFilePath` pointing at static
role briefings (`agents/techlead/AGENTS.md`,
`agents/qa/AGENTS.md`) that did NOT include either Mustache block.
For those agents the rendered prompt was the role briefing in
isolation — no task title, no task body, no instruction to query
the queue. Hence the agent's reply: "no explicit request, please
tell me which task." The wake mechanism worked. The prompt
rendering at the role-overlay layer silently dropped the workflow.

The bug is invisible in normal heartbeat operation because the
heartbeat path injects `taskId`/`taskTitle`/`taskBody` into the
runtime config regardless — but if the rendered prompt doesn't
have a `{{taskTitle}}` reference to substitute into, those values
go nowhere. Agents without a custom instructionsFilePath (BE,
FrontendEng, TechnicalWriter, PythonEng, CEO, Compliance) get the
default template intact and behave correctly.

**Immediate fix (this commit).** Append the two Mustache blocks
verbatim to `agents/techlead/AGENTS.md` and `agents/qa/AGENTS.md`.
Verified by re-waking TechLead on AWO-172 and confirming the
status transition + claim post-fix.

**Structural fix (upstream, not in this repo).**
`loadInstructionsTemplate()` in
`~/Projects/hermes-paperclip-adapter/src/server/execute.ts` should
*compose* — the default template should keep the workflow blocks
anchored, and the file at `instructionsFilePath` should fill a
`{{customInstructions}}` placeholder inside it. That makes
role-overlays additive and removes the foot-gun where any future
custom AGENTS.md without the blocks silently breaks task
delivery.

**Detection.** A test (paperclip-side) that, for every agent with
`instructionsFilePath` set, rejects the config if the file lacks
either Mustache block. Until that lands, the lint check is:

```
for f in agents/*/AGENTS.md; do
  grep -q "{{#taskId}}" "$f" || echo "MISSING-taskId-block: $f"
  grep -q "{{#noTask}}" "$f" || echo "MISSING-noTask-block: $f"
done
```

**Pair this learning with §10 (Coordinator role is load-bearing)
and §14 (default model pointed at a missing provider).** All
three are "the substrate is configured but a required interpolation
target is missing/broken, so the agent runs but produces no useful
output." The substrate looks healthy from the outside while the
inner-loop work isn't happening.

## §21. Per-package vitest configs without shared pool settings = host-killing fork bomb

**Symptom (2026-04-28 evening).** Three hard system hangs on the 16GB
mini2 host while paperclip was orchestrating multi-agent runs on this
repo. Reboots at 15:31, 16:58, 22:16. No kernel panic files in
`/Library/Logs/DiagnosticReports/` — meaning these were memory-pressure
watchdog resets, not true panics. `apfsd` CPU resource warnings landed
at 16:19 and 17:13 (filesystem under sustained pressure). The most
recent server log
(`~/.paperclip/logs/server-20260428-163953.log`) ended mid-poll at
20:58 with no error — process was killed by jetsam, not a crash.

**Root cause.** Two compounding bugs in this repo's vitest setup:

1. The root `vitest.config.ts` correctly set `pool: 'forks'` +
   `singleFork: true`, but each `packages/*/vitest.config.ts`
   defined its own `defineConfig({})` from scratch and **did not
   inherit** the root pool settings. Only `policy-engine` had the
   override. The other 7 package configs defaulted to
   `pool: 'threads'` with one worker per CPU (10 on M-series).
2. The root `package.json` test script was `pnpm -r test`, which
   parallelizes across the workspace by default. Nine packages all
   spinning up vitest in parallel, each with its own ten-worker thread
   pool. One `pnpm test` invocation = ~70-90 worker processes.
   Now multiply by N concurrent agents triggered by paperclip
   `wake-on-assign-daemon.sh`. Three or four agents in flight ⇒ 200+
   worker processes on a box with 10 CPUs and 16GB unified memory.

**The fix (commit landing 2026-04-28).** Three small edits, no test
code changes:

1. `package.json` test script changed to
   `pnpm -r --workspace-concurrency=1 test`. Packages run sequentially
   instead of fanning out across the workspace.
2. New `vitest.shared.ts` at repo root exports a `sharedTestConfig`
   object with `pool: 'forks'`, `singleFork: true`, `maxForks: 1`,
   `globals: true`, `environment: 'node'`. Every package config now
   spreads this base before adding its own `include` paths.
3. The previously-correct root `vitest.config.ts` was simplified to
   spread `sharedTestConfig` so the substrate-E2E suite (`tests/`)
   and per-package suites use the same pool semantics.

**Why this matters for substrate v1.** The fork-bomb pattern is the
predictable consequence of letting agents run repo-wide test commands
without workspace-level concurrency caps. Our wake-on-assign daemon
is exactly the trigger that turns "1 dev runs `pnpm test`" into
"3 agents run `pnpm test` concurrently" — a load shape no human
developer would ever produce. Future repos onboarded onto AgentWorks
must audit their test runner for the same shape: per-package config
inheritance + workspace-level concurrency limit. Add this to the
substrate v1 hardening checklist (§ "Test runners must cap
parallelism") before we onboard a customer repo.

**Detection.** During paperclip runs, watch for either signal:

- `vm_stat` shows pages free dropping below 5% with `swapused`
  growing steadily
- `pgrep -f vitest | wc -l` exceeds 20 while only one or two agent
  runs are active

Either is grounds to kill the in-flight test runs and audit the
workspace's vitest config inheritance before resuming.

---

## Session 2026-04-29 — GitHub-Issue-Driven Coordination

### Company API requires full UUID, not short ID
Paperclip's `/api/companies/{short_id}/agents` and `/api/companies/{short_id}/projects`
return 500. Use the full UUID: `00000000-0000-4000-8000-000000000001`.
Short IDs (e.g. the first 8 chars of a UUID) fail on all `/companies/{short_id}/*` routes.

Workaround: always resolve to full UUID before making company-level API calls.

### Workspace config NOT applied to agent execution (Paperclip bug)
All 14 AgentWorks projects have `executionWorkspacePolicy=USE_SPECIFIC_WORKSPACE` with
`cwd=/Users/example/Projects/agentworks-os`. But agents run in empty scratch dirs:
`~/.paperclip/instances/default/workspaces/{agentId}/` — the project workspace is
not applied to the agent execution context.

`heartbeat-context` does not surface workspace/cwd info, making diagnosis difficult.
File as Paperclip bug.

### Paperclip inbox priority overrides GitHub issues
Agents follow HEARTBEAT-PROTOCOL: (1) check in_progress, (2) check Paperclip inbox,
(3) check GitHub issues. Step 2 takes absolute priority — agents complete old Paperclip
tickets before touching any GitHub issues, even when GitHub issues are explicitly
assigned in the wakeup reason.

For GitHub-issue-driven workflows, the Paperclip inbox must be empty or the issue
must be posted as a Paperclip issue first.

### Dead-letter issues block agents (orphaned executionRunId)
Issues like AWO-173 have `status=todo` but `executionRunId=abc251c8-...` set from a
previous crashed/stale run. When the agent tries `PATCH /issues/{id}` to mark done,
Paperclip validates that the caller holds the current execution lock — since the
orphaned executionRunId doesn't match the current run, validation fails with 500.

The agent retries in a loop: PATCH → 500 → post comment → PATCH → 500.
This consumes the agent's entire run for zero progress.

Fix: Paperclip needs an admin operation to clear orphaned `executionRunId` values
or a `forceComplete` flag that bypasses the execution lock check.

### Hermes session DB schema drift
The `messages` table in `/Users/example/.hermes/state.db` was missing the
`codex_message_items` column (had `codex_reasoning_items` instead). This caused
`sqlite3.OperationalError: no such column: codex_message_items` on every
`resume_session` call.

Fix: `ALTER TABLE messages ADD COLUMN 'codex_message_items' TEXT`

This is a schema migration issue — the Hermes state DB wasn't updated when the
`codex_message_items` column was added to the schema.

### `forceFreshSession=true` bypasses broken session resume
When session resume is broken (due to schema drift or other issues), adding
`forceFreshSession: true` to the wakeup payload causes the agent to start a
fresh session instead of resuming. The hint appears in the heartbeat payload as
`"useFreshSession": true`.
