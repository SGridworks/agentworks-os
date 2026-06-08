# Contributing

Thanks for considering a contribution to AgentWorks OS.

## Development Setup

```bash
pnpm install
pnpm -r typecheck
pnpm -r build
pnpm test
```

Use Node 22 and pnpm 9 unless the repo configuration is updated.

## Release Checks

Before opening a release PR, run:

```bash
pnpm validate:release
```

This includes version consistency, product-surface reference checks, public-release safety checks, typecheck, and build.

## Versioning

The root `VERSION` file is authoritative. Every workspace `package.json` with a `version` field must match it.

AgentWorks OS follows SemVer:

- Patch: compatible fixes only.
- Minor: new features or breaking changes before `1.0.0`.
- Major: stable-contract breaking changes after `1.0.0`.
- Prerelease suffixes such as `alpha.0` are used for public release candidates.

## Public Data Hygiene

Do not include private customer data, local machine paths, personal vault content, API keys, access tokens, generated support bundles, local agent prompts, or incident handoff notes in public PRs.

Public migrations must respect `.public-releaseignore`.

## Pull Requests

Keep PRs reviewable:

- Explain the user-facing behavior change.
- List the verification commands you ran.
- Include screenshots for UI changes.
- Call out migrations, data model changes, and compatibility risks.
- Do not mix unrelated cleanup with feature work.
