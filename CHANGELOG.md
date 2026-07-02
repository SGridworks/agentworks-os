# Changelog

All notable changes to AgentWorks OS are documented here.

AgentWorks OS uses SemVer. Until `1.0.0`, minor versions may include breaking changes; those changes must be called out in release notes.

## [Unreleased]

## [0.3.0-alpha.2] - 2026-07-01

### Changed

- Container images are now signed with cosign using keyless / OIDC signing (the GitHub Actions workflow identity via Fulcio, recorded in the Rekor transparency log). There is no signing key or secret to manage; the signature is anchored to the image digest cosign resolves from the release tag. Verify an image with `cosign verify --certificate-identity-regexp '^https://github.com/SGridworks/agentworks-os/' --certificate-oidc-issuer https://token.actions.githubusercontent.com ghcr.io/sgridworks/agentworks-os/<image>:<version>`.
- Container images now publish to the `ghcr.io/sgridworks/agentworks-os/*` namespace (previously `agentworks-os-v0.3/*`), matching the repository name after the 2026-07-01 consolidation. `docker-compose.yml`, `docker-compose.dev.yml`, the installer scripts, and the CLI reference the new namespace. As a migration aid, this release is also mirror-published under the legacy `agentworks-os-v0.3/*` namespace so 0.3.0-alpha.1 installs can still pull it; the mirror will be retired in a future release.
- `agentworks update` now refreshes `docker-compose.yml` (and the persisted `AGENTWORKS_VERSION`) from the target release before pulling, so registry-namespace, port, and service changes are applied on upgrade — not just the version tag. Previously an upgrade only overrode `AGENTWORKS_VERSION`, so a namespace move would have made `compose pull` fetch a non-existent manifest on existing installs.

### Upgrading from 0.3.0-alpha.1

New installs and all future upgrades use the `agentworks-os/*` namespace automatically. Existing 0.3.0-alpha.1 installs can `agentworks update` in place (this release is mirror-published to the old namespace). To fully migrate to the new namespace and the improved updater, re-run the installer:

```bash
curl -fsSL https://github.com/SGridworks/agentworks-os/releases/download/v0.3.0-alpha.2/install.sh | bash
```

### Documentation

- README: broadened positioning from "regulated small businesses" to "AI agents in regulated industries" (energy/grid NERC/FERC, real estate, health-adjacent, insurance, financial FINRA/GLBA/SOX), and replaced the hardcoded release-candidate line with a pointer to the Releases page.

## [0.3.0-alpha.1] - 2026-06-12

### Added

- Autonomous compliance loop: approval and dispatch auto-resume so a parked run advances to a sealed evidence pack without further manual steps after the operator approves. A reconciler re-wakes any waiting run whose linked approval or dispatch resolved while the daemon was down, making the loop restart-safe.
- Scanner-driven compliance loop: the generic workflow event bus (`workflow-events.ts`) lets any producer fire a named event that starts matching active event-triggered workflows. Scanner findings at or above the configured severity threshold now fire a `scanner.finding` event, driving the end-to-end `policy → approval → dispatch → evidence` chain automatically when the `scanner-compliance-loop` template is installed and active.
- Four additional event producers: `dispatch.failed` (inline from dispatch consumer), `provider.degraded` (inline from provider health), `approval.sla_breach` and `issue.stuck` (level-triggered sweeps in `event-producer-sweeps.ts` with `INSERT OR IGNORE` dedup).
- Simulated dispatch adapter (`AWOS_ADAPTER=simulated`): deterministic, role-aware output with `simulated: true` on every result; no external credentials required. Designed for demos and end-to-end tests.
- Demo seed: `POST /api/admin/demo/seed`, `agentos seed-demo` CLI, and the **Load demo** button in the admin UI (empty-tenant state) all create a synthetic demo tenant with two agents, a sample scanner finding, and the `compliance-loop` workflow parked at `waiting_approval`. Idempotent.
- Active event subscriptions panel in the Automations view shows every active event-triggered workflow and its subscribed event kind.
- Return for revision: a reviewer's `return_to_author` decision parks the run in a non-terminal `waiting_revision` state (instead of failing); `POST /api/admin/automations/runs/:id/resubmit` and a **Resubmit** control on the Active Work page re-enter the approval gate with an optionally-revised input.
- New env vars: `AGENTOS_SCANNER_AUTOLOOP_SEVERITIES` (default `high,critical`), `AGENTOS_APPROVAL_SLA_HOURS` (default `24`), `AGENTOS_STUCK_ISSUE_THRESHOLD_HOURS` (default `4`), `AGENTOS_EVENT_SWEEP_MS` (default `900000`), `AGENTOS_LOOP_RECONCILE_MS` (default `60000`).
- [Compliance Loop guide](docs/compliance-loop.md) — operator and contributor documentation.

### Fixed

- Deploy Docs workflow: granted `contents: write` so `mkdocs gh-deploy` can push the `gh-pages` branch (previously failed with 403 on every docs change).

## [0.3.0-alpha.0] - 2026-06-07

### Added

- Shared AWOS vault metadata index in `@agentworks/memory`.
- `GET /api/memory/metadata` for page, link, tag, unresolved-link, duplicate-slug, and issue metadata.
- Native workflow engine features: workflow versions, definition hashes, step checkpoints, dry-run simulation, approval waits, handoff contracts, resume, cancel, replay, evidence packs, dispatch recovery states, and self-heal proposals.
- Public release safety check for local paths, private project names, private tenant names, and private tenant identifiers.
- Version consistency check backed by the root `VERSION` file.
- Public release ignore manifest for excluding local agent prompts, internal strategy notes, handoff notes, incident notes, runtime output, and local state from public migration.

### Changed

- Workspace package versions now share a single monorepo version.
- Local profile defaults now derive from the current runtime environment instead of one operator's machine.
- Adapter repo roots now default to the current working directory or explicit environment variables.
- External repo dispatch is opt-in through `AWOS_ALLOWED_REPO_ROOTS`.
- Example vault keys now use neutral `projects/acme` values.

### Removed

- Private/local external-repo lane special cases from the public workflow adapter path.
- Hard-coded operator home paths from included package surfaces.

### Public-Release Notes

- Baseline frozen against `upstream/main` at `e9ceed665ed1e6f93b2267460eb8e15e78937584`.
- The local branch has unrelated history versus `upstream/main`; this release should be migrated as curated patchsets, not pushed as-is.
- Do not publish until `pnpm validate:release` passes and the public migration excludes every path listed in `.public-releaseignore`.
