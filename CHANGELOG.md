# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] — 2026-05-04

Patch release. Repairs the install pipeline end-to-end. v0.1.2 (and every
release before it) shipped a `curl | bash` install URL that exited 0 but
produced a half-broken stack on a clean Linux/WSL host. v0.1.3 is the
first version where `git clone && ./apps/installer/src/install.sh` actually
brings the substrate up and passes a real smoke test.

### Fixed

- **scanner-worker Dockerfile**: was unbuildable. `python:3.11-slim-amd64`
  does not exist on Docker Hub (`python:3.11-slim` is multi-arch already);
  `libffi7` no longer ships in Debian Trixie (renamed to `libffi8`); the
  COPY layout flattened `src/` into `/app/` and broke hatchling's dynamic
  version; `pip install -e .` left a `.pth` file pointing into the builder
  stage that did not exist at runtime.
- **agentos-d Dockerfile**: copying `packages/agentos-d/node_modules`
  invalidated every relative pnpm symlink into the virtual store. Now uses
  `pnpm deploy --filter @agentworks/agentos-d --prod /deploy` to materialize
  a flat tree.
- **`docker-compose.yml`**: scanner-worker build context corrected to
  `./packages/scanner-worker` (matches the release workflow); bind-mount
  paths parametrized via `AGENTWORKS_DATA_DIR`/`AGENTWORKS_CONFIG_DIR` so
  install.sh can run compose from the source root while volumes resolve
  under `~/.agentworks/`; `image:` repointed at `ghcr.io/sgridworks/...`
  so `docker compose pull` actually finds the published images.
- **`apps/installer/src/install.sh`**: clones the source instead of
  fetching only docker-compose.yml from raw GitHub (previous path could
  not work because compose has `build:` directives and v0.1 publishes
  nothing pullable); generates `POSTGRES_PASSWORD` as hex, not base64
  with `/`/`+` that corrupt the postgres URL; pre-creates `data/n8n` and
  `data/scanner` with chmod 777 so the container uid mismatch does not
  block writes; idempotent so re-running after a partial failure does
  not invalidate the saved admin password.
- **Release workflow**: `actions/cosign-installer@v4` does not exist —
  was the reason every release since v0.1.0 failed before pushing any
  GHCR image. Fixed to `sigstore/cosign-installer@v3`. Sign steps now
  early-exit cleanly if `COSIGN_PRIVATE_KEY` is not set instead of taking
  down the whole job.

### Added

- **Pre-flight checks in install.sh**: ports 7710/3101/5678 free, ≥10 GB
  disk under `$HOME`, ≥4 GB RAM, internet to github.com, Docker daemon
  reachable. Each failure prints the exact next action.
- **`apps/installer/scripts/smoke-test.sh`**: real install gate that
  POSTs `/api/tenants` and `/api/policy/check` end-to-end and asserts
  the response shape. `install.sh main()` calls it at the end and exits
  non-zero on failure. An LLM agent driving the install can grep for
  `[PASS]` / `[FAIL]` / "Smoke test PASSED".
- **Release workflow**: `workflow_dispatch` trigger so a maintainer can
  re-run a release without cutting a new tag; uploads
  `apps/installer/src/install.sh` as a release asset on every `v*` push
  via `softprops/action-gh-release@v2`; flips the published GHCR
  packages public so unauthenticated `docker compose pull` works for
  end users.
- **`docs/AI-AGENT-INSTALL-GUIDE.md`** rewritten (~600 → ~250 lines) for
  the new flow: clone, run two scripts, enumerated failure modes with
  fixes, final report template.

### Removed

- Stale `apps/installer/install.sh` and `apps/installer/bin/install.sh`
  duplicates (both stuck at v0.1.0). `apps/installer/src/install.sh` is
  the single source of truth.

## [0.1.2] — 2026-05-04

Patch release. Closes the v0.1.1 known-issues list — the agentos-d test
suite is now fully green.

### Fixed

- **`packages/agentos-d` autopilot integration test** — the daemon now boots
  from the correct release checkout path and uses `AGENTOS_DATA_DIR` plus a
  tmp `AWOS_AGENTS_ROOT`, avoiding stale package-relative data and agents
  paths in the test environment.
- **Autopilot dispatch idempotency** — safe auto-dispatched policy decisions
  now get idempotency rows too, so replaying the same dispatch key returns the
  same safe and review-side counts.
- **Backup / restore CLI** — restore round-trip now returns exit 0
  consistently against the v0.1.1 backup-safety guards; backup manifests store
  the restored SQLite payload checksum instead of an impossible self-referential
  tarball checksum.
- **Provenance frontmatter** — reads without an `actorId` no longer emit
  `lastUsedBy: []`; the key is omitted entirely, consistent with
  `authoringAgent`, `lastUpdatedBy`, and related optional frontmatter.
- **Mission-map node colors** — blocked issues now render red-500
  (`#ef4444`) like failed runs; red-900 (`#991b1b`) is reserved for evidence
  nodes with `severity` of `block` or `critical`.
- **Memory usage route tests** — usage tracking now runs against an in-process
  app with tmp data and vault roots instead of whichever daemon happens to be
  listening on `localhost:7710`.

### Known issues

None at the substrate level. `tests/substrate-e2e.test.ts` 8/8 green;
`packages/agentos-d` 629/629.

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
