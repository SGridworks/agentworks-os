# AgentWorks OS — v0.3.0-alpha.0 Release Notes

**Status:** Pre-release (alpha). Privacy-boundary review gate open as PR. **Not tagged, not published, no release artifacts.**
**Date:** 2026-06-07 (changelog) / PR opened 2026-06-08
**Baseline:** frozen public baseline `e9ceed665ed1e6f93b2267460eb8e15e78937584` (v0.1.9)
**Release branch HEAD:** `e372f537936152b0fcb4da8f83d8af7004ef5a31`
**Diff vs baseline:** 456 files changed, +39,093 / -18,171

AgentWorks OS uses SemVer. Pre-1.0.0, minor versions may include breaking changes; they are called out below.

---

## Overview

v0.3.0-alpha.0 is the first cut of the privacy-hardened public release line for AgentWorks OS — a local-first compliance gateway and orchestration substrate that any AI agent can point at. This release does two things at once:

1. **Ships real product surface** — a native workflow orchestration engine and a shared vault metadata index.
2. **Establishes a hardened public/private boundary** — automated scanners and a release ignore manifest that keep operator data, private paths, and internal naming out of the public tree.

This is an **alpha**. The intended consumer is an evaluator running it locally, not a production deployment. The release is published as a review gate (PR), not as a tagged release.

---

## Highlights

### Native workflow orchestration engine
A first-class workflow engine lands in `packages/agentos-d` (the largest area of change, 140 files). New capabilities:

- **Versioned workflows** with definition hashes for integrity and reproducibility.
- **Step checkpoints** — durable per-step state so long workflows survive restarts.
- **Dry-run simulation** — execute a definition without side effects to validate shape.
- **Approval waits** — workflows can block on a human decision via the approval queue.
- **Handoff contracts** — explicit interfaces between steps/agents.
- **Resume, cancel, replay** — full lifecycle control over in-flight and completed runs.
- **Evidence packs** — bundled artifacts proving what a run did.
- **Dispatch recovery states** + **self-heal proposals** — the engine detects stalled dispatches and proposes corrective action.

### Shared AWOS vault metadata index
A vault metadata layer in `@agentworks/memory` (`packages/memory`, 19 files), surfaced over HTTP:

- `GET /api/memory/metadata` returns page, link, tag, unresolved-link, duplicate-slug, and issue metadata for a tenant's vault.
- Enables UI and tooling to reason about the knowledge graph (broken links, duplicate slugs, orphans) without re-parsing the vault each time.

### Admin UI
83 files changed in `packages/admin-ui` to wire the new engine controls and metadata views into the operator console, plus release-review warning fixes.

---

## Detailed changes

### Added
- Shared AWOS vault metadata index in `@agentworks/memory`.
- `GET /api/memory/metadata` for page, link, tag, unresolved-link, duplicate-slug, and issue metadata.
- Native workflow engine features: workflow versions, definition hashes, step checkpoints, dry-run simulation, approval waits, handoff contracts, resume, cancel, replay, evidence packs, dispatch recovery states, and self-heal proposals.
- **Public release safety check** (`scripts/check-public-release-safety.mjs`) — scans for local paths, private project names, private tenant names, and private tenant identifiers. Wired as `pnpm check:public-release`.
- **Product-surface reference check** (`scripts/check-product-surface-references.mjs`) — forbidden-reference scanner over customer-facing surfaces. Wired as `pnpm check:product-surfaces`.
- **Version consistency check** (`scripts/check-version-consistency.mjs`) — asserts all package manifests match the root `VERSION` file. Wired as `pnpm check:version`.
- **Root `VERSION` file** — single source of truth for the monorepo version.
- **Public release ignore manifest** (`.public-releaseignore`) — excludes local agent prompts, internal strategy/handoff/incident notes, runtime output, and local state from public migration.

### Changed
- Workspace package versions now share a single monorepo version (15 manifests at `0.3.0-alpha.0`).
- Local profile defaults now derive from the current runtime environment instead of one operator's machine.
- Adapter repo roots now default to the current working directory or explicit environment variables.
- External repo dispatch is opt-in through `AWOS_ALLOWED_REPO_ROOTS`.
- The public SDK adapter surface is renamed from the internal gateway name to **Local Gateway**.
- The dispatch opt-in path is renamed to `AWOS_CLAIM_LOCAL_GATEWAY_DISPATCH`.
- Example vault keys now use neutral `projects/acme` values; opaque hard-coded UUIDs replaced with synthetic example IDs.

### Removed
- Private/local external-repo lane special cases from the public workflow adapter path.
- Hard-coded operator home paths from included package surfaces.
- Private local gateway fallback paths/envs (replaced with AWOS provider-profile defaults).

---

## Privacy-boundary hardening

The release was prepared with an explicit privacy boundary. The head commit `e372f53` ("chore: harden public release privacy boundary") closes the last gaps:

- Removed private local fallback paths/envs; replaced with AWOS provider-profile defaults.
- Renamed the public SDK adapter surface from the internal gateway name to **Local Gateway**.
- Renamed the dispatch opt-in path to `AWOS_CLAIM_LOCAL_GATEWAY_DISPATCH`.
- Tightened public scanners against internal tool-name leakage.
- Replaced opaque hard-coded UUIDs with synthetic example IDs.
- Cleaned public docs of internal planning/review language and broken private links.
- Fixed committed whitespace across the release diff.

**Guarantee:** no local operator data, private paths, private project/customer names, raw vault content, runtime state, generated output, or archival planning notes are present in the public tree. This is enforced by `check:public-release`, `check:product-surfaces`, and `.public-releaseignore` — all gating.

---

## Breaking changes / migration notes

Pre-1.0.0 alpha; the following are behavior changes evaluators should know:

- **Env/path renames:** dispatch opt-in is now `AWOS_CLAIM_LOCAL_GATEWAY_DISPATCH`; external repo dispatch is gated behind `AWOS_ALLOWED_REPO_ROOTS`. Adapter repo roots now default to CWD or an explicit env var rather than a baked-in operator path.
- **Adapter naming:** the public SDK adapter surface is now "Local Gateway." Code referencing the previous internal name needs updating.
- **Single monorepo version:** all packages move in lockstep at the root `VERSION`.

---

## Verification

All checks below pass on `e372f53`:

| Check | Command | Result |
| --- | --- | --- |
| Version consistency | `pnpm check:version` | PASS — 15 manifests at 0.3.0-alpha.0 |
| Product-surface references | `pnpm check:product-surfaces` | PASS — 658 files scanned |
| Public-release safety | `pnpm check:public-release` | PASS — 769 scanned, 7 skipped |
| Whitespace vs baseline | `git diff --check e9ceed66...` | PASS — no errors |
| Whitespace (working tree) | `git diff --check` | PASS — no errors |
| Full release validation | `pnpm validate:release` | PASS — exit 0 (workspace builds + typechecks) |

Previously also green: `pnpm --dir packages/admin-ui test` / `lint`, `agent-adapters test`, `agentos-d test`, `memory test`.

Worktree clean; HEAD `e372f53`; baseline `e9ceed6`.

---

## Distribution

- **Public repo:** `SGridworks/agentworks-os-v0.3` (new, public).
- **`main`** seeded from the frozen baseline `e9ceed6` (v0.1.9) only.
- **`release/v0.3.0-alpha.0`** = `e372f53`, opened as PR #1 against `main` (8 commits, 456 files, mergeable) — this PR is the privacy-boundary review gate.
- This release line has an **independent history** from the existing public `agentworks-os-vps` repo (currently at v0.2.0). The two do not share a common ancestor.

---

## What is NOT done yet

Per the release plan, the following are intentionally deferred:

- **No git tag** for `v0.3.0-alpha.0`.
- **No GitHub release.**
- **No package/image publish** (no GHCR push).
- **No release artifacts** uploaded.

The PR is the gate. Tagging and publishing happen only after the privacy-boundary review passes.

---

## Known limitations

- Alpha quality: intended for local evaluation, not production.
- Default dispatch remains a stub adapter until `AWOS_ADAPTER` + provider credentials are configured.
- The new `agentworks-os-v0.3` public repo and the existing `agentworks-os-vps` (v0.2.0) coexist with incompatible histories; reconciliation/supersession is an open decision.
