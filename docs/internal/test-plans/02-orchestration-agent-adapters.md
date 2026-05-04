# Test Plan: Pillar 2 — Orchestration (agent adapters)

## Gate
Agent adapters stable across restarts; checkout race condition tested.

## Verification Criteria

### G1 — Agent adapter stability across restarts
- [ ] Each of the 7 paperclip adapters (Claude Local, Codex, Cursor, Gemini, OpenCode, Pi, OpenClaw Gateway) initializes cleanly after `agentos-d` restart
- [ ] Adapter state is not lost on restart (or failure to reconnect is logged with actionable error)
- [ ] Adapter health endpoint returns accurate status within 5s of startup

### G2 — Checkout race condition
- [ ] Concurrent `issue.checkout()` calls from multiple agents never assign the same issue to two agents
- [ ] Race condition test: 10 agents attempting to checkout the same issue simultaneously — exactly one succeeds, others receive conflict error

### G3 — Hermes adapter (new)
- [ ] Hermes adapter is included in the adapter SDK
- [ ] Hermes adapter passes the same stability test as other adapters

### G4 — Adapter SDK surface
- [ ] `packages/agent-adapters/src/index.ts` exports all 8 adapters
- [ ] Each adapter has a type-safe `execute(action: ActionEnvelope): Promise<ActionResult>` interface
- [ ] Invalid action envelope is rejected at the type level, not at runtime

## Test Fixtures Required
- `tests/fixtures/adapters/race-condition.ts` — simulates concurrent checkout
- `tests/fixtures/adapters/mock-adapters.ts` — mock implementations for isolated testing

## Pass Criteria
All assertions pass with `pnpm test`.

## Adversarial Tests
- Simulate sudden adapter disconnection mid-operation
- Simulate malformed action envelope; verify graceful rejection
- Rapid restart cycle (restart within 1s of startup) — verify no state corruption

## Notes
- `packages/agent-adapters` does not yet exist as a standalone package. Adapter SDK is embedded in `agentos-d`.
- Checkout race condition tests require a running database (paperclip SQLite or PostgreSQL).
