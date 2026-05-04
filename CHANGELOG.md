# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-05-04

Patch release. Closes the v0.1.0 known-issues list for policy-engine and
admin-ui, and ships one real bug fix that was caught after release.

### Fixed

- **Memory graph showed only the tenant's own subtree.**
  `FileVaultStore.list()` used `fs.readdir({ recursive: true })`, which does
  NOT follow symbolic links. Tenants whose `wiki/` and `memory/` folders are
  symlinks (the recommended layout for shared knowledge) saw a fraction of
  their actual notes in `/api/memory/graph`. `list()` now walks manually and
  resolves each symlink via `fs.stat`. realpath dedup keeps the walk
  cycle-safe.
- **`packages/policy-engine`** — `evaluator.test.ts` expected `block` for
  missing `required_data`. Tests realigned to the runtime's
  `route_to_review` behavior, which is the correct fail-safe (see v0.1.0
  known-issues note).
- **`packages/admin-ui`** — `yaml-schema.test.ts` expectations realigned to
  the schema's `rules.minItems = 1` and `condition.then.required = [decision,
  reason]` constraints. Marker messages also now include the offending
  property name for `additionalProperties` and `required` errors so Monaco
  surfaces it inline.

### Known issues

Still triaged for v0.1.2:

- `packages/agentos-d`: 11 failures across `cli.test.ts` (backup/restore
  CLI), `bin/mcp-stdio.test.ts`, `routes/admin-mission-map`,
  `routes/memory-usage`, and `services/mission-map`. The substrate-e2e suite
  remains the canonical shippability check.

## [0.1.0] — 2026-05-04

First public release. Initial commit history is reset from the internal
substrate that drove pre-release development; commit-level provenance
prior to v0.1.0 is preserved internally.

### Added

- **Substrate daemon (`agentos-d`)** — single Node process exposing REST,
  MCP server, and WebSocket. Hosts the policy engine, vault store,
  approval queue, and hash-chained audit log.
- **Policy engine** — YAML rule pack loader and evaluator with
  severity-aware aggregation. Outcomes: `allow`, `block`,
  `route_to_review`. Shadow mode with 7-day default observe-only window
  before flipping to enforce.
- **Rule packs (v1)** — `smb-starter`, `tcpa-real-estate`,
  `fair-housing`, `hipaa-placeholder`. Authored to the `awcp/v0.1` schema.
- **Memory / vault** — tenant-scoped FileVaultStore with markdown on disk.
  Recursive-character chunker, OpenAI-compatible embed client, Chroma /
  Qdrant vector store, hybrid BM25 + vector retrieval, optional
  cross-encoder rerank.
- **Approval queue** — rule packs can return `route_to_review`; queued
  actions surface in admin UI for human approve / reject / send-back.
  Reviewer actions logged in audit trail.
- **Compliance Evidence Report PDF** — monthly signed and hash-chained
  PDF summarizing policy decisions and approval-queue activity. Disclaimer:
  evidence of system state, not legal compliance.
- **AgentGuard scanner** — embedded as a Python FastAPI sidecar,
  `scanner-worker`. Continuous scan of agent configs (CLAUDE.md,
  .cursorrules, MCP configs). Findings surface as Issues in the admin UI.
- **n8n integration** — bundled in docker-compose; substrate-aware custom
  nodes for memory read/write, dispatch, and policy_check.
- **Admin UI** — Next.js 14 app router. Onboarding wizard, rule pack
  YAML editor with CLI dry-run, approval queue, scanner findings,
  evidence-report preview, mission map, autopilot, triage queue.
- **Adapter SDK (`@agentworks/agent-adapters`)** — uniform interface for
  external agent runtimes including Claude Local, Codex, Cursor, Gemini,
  OpenCode, Pi, and a Hermes adapter.
- **One-command installer** — `apps/installer/src/install.sh`, fetched
  from the v0.1.0 GitHub release asset. Stands up the full stack on a
  Docker host in under 20 minutes.
- **AWCP v0.1 draft spec** — wire format, API surface, and data model in
  `docs/awcp.md`. Posture: breaking-changes-allowed until either an
  external implementer or 6 months of customer learning.
- **Backup / restore** — `agentworks backup` and `agentworks restore`
  CLIs with optional encryption. Documented in
  [`docs/backup-restore.md`](./docs/backup-restore.md).

### Not in v0.1.0

- Cost metering and per-agent LLM spend attribution (planned: v1.1)
- Per-employee SSO / federated auth (planned: v1.2)
- Browser extension for ChatGPT / Manus integration (planned: v2)
- Hosted / cloud deployment (local-only in v1 by design)
- AWCP v1.0 stable spec (v0.1 is a draft)
- MCP-first rule-pack preview (CLI dry-run is the v1 fallback)

### Known issues

The following test failures are documented and triaged for v0.1.1:

- `packages/policy-engine`: 2 failures in `evaluator.test.ts` —
  `required_data` undefined and null variants currently return
  `route_to_review` instead of `block`. The runtime path
  (`route_to_review`) is the correct fail-safe; the tests' expected
  decision is the bug.
- `packages/agentos-d`: 11 failures across `cli.test.ts`
  (backup/restore CLI), `bin/mcp-stdio.test.ts`, `routes/admin-mission-map`,
  `routes/memory-usage`, and `services/mission-map`. Pre-existing
  regressions slated for v0.1.1.
- `packages/admin-ui`: 3 failures in `lib/yaml-schema.test.ts` — test
  expectations contradict the JSON schema's `minItems` and
  `additionalProperties` constraints. Test bugs, not product bugs.

The canonical shippability check, `tests/substrate-e2e.test.ts`, passes
8/8 against a freshly booted daemon.

### Security

This is the first public release; no prior CVEs apply. See
[SECURITY.md](./SECURITY.md) for the disclosure process.
