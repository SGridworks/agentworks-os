# AGENTS.md — contributor conventions for AgentWorks OS

This file gives automation agents and human contributors a short operating
contract for working in this repository. Keep changes scoped, verified, and
free of local operator state.

## Repository Areas

- `packages/agentos-d` — daemon, REST/MCP routes, orchestration, migrations
- `packages/admin-ui` — Next.js admin application
- `packages/memory` — AWOS vault memory capabilities
- `packages/policy-engine` and `packages/awcp` — policy and protocol logic
- `packages/scanner-worker` — Python scanner service
- `apps/installer` — installer and workspace scaffolding
- `docs` and `rule-packs` — public documentation and rule-pack content

## Working Rules

- Prefer small, reviewable commits tied to a clear product outcome.
- Do not commit local runtime state, credentials, customer data, private notes,
  generated build output, or machine-specific paths.
- Keep product-facing docs, UI, errors, prompts, and API responses in AWOS /
  AgentWorks OS vocabulary.
- Add migrations in the same commit as schema changes.
- Verify public release hygiene with `pnpm validate:release` before publishing.

## Public Release Checks

Run these checks before opening a release PR:

```
pnpm check:version
pnpm check:product-surfaces
pnpm check:public-release
git diff --check
```

Use `.public-releaseignore` for files that are useful in a private development
workspace but must not be migrated into the public baseline.


---

# Karpathy Coding Guidelines

Behavioral guardrails to reduce LLM coding mistakes. Bias toward caution over speed. For trivial tasks (typos, one-liners), use judgment.

## 1. Think Before Coding

**Do not assume. Do not hide confusion. Surface tradeoffs.**

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No flexibility or configurability that was not requested.
- No error handling for impossible scenarios.
- If 200 lines could be 50, rewrite.

Test: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own changes.**

- Do not improve adjacent code, comments, or formatting.
- Do not refactor things that are not broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans: remove imports/variables/functions YOUR changes made unused. Don't remove pre-existing dead code unless asked.

Test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
```

Strong criteria let the agent loop independently. Weak criteria ("make it work") require constant clarification.

## Verification

These guidelines are working if: fewer unnecessary diffs, fewer rewrites from overcomplication, clarifying questions come before implementation, not after mistakes.

## Source

Derived from [forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills), based on [Karpathy's observations](https://x.com/karpathy/status/2015883857489522876).
