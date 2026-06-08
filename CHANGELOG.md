# Changelog

All notable changes to AgentWorks OS are documented here.

AgentWorks OS uses SemVer. Until `1.0.0`, minor versions may include breaking changes; those changes must be called out in release notes.

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
