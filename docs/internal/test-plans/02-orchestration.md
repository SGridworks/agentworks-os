# Test Plan — Pillar 2: Orchestration

**Pillar**: Orchestration (paperclip core)
**Owner**: BackendEngineer
**QA**: QAEngineer
**Status**: Not started

## Verification Gate
Agent adapters stable across restarts; checkout race condition tested.

## Schema Reference
- `packages/shared/src/schema/action.ts` — `ActorSchema`, `ActionEnvelopeSchema`
- AWCP SPEC.md Section 1

## Test Fixtures

### 1. Adapter stability across restarts
**Approach**: Simulate a substrate restart mid-operation; verify the agent adapter reconnects and resumes without corrupting in-flight work products.

**Setup**:
- Spawn a mock agent adapter (Hermes adapter for testing).
- Submit an action envelope while the adapter is mid-operation.
- Kill the substrate daemon; restart it.
- Submit a second action envelope.

**Assertions**:
- [ ] First action: either completed or retryable (idempotent by `requestId`).
- [ ] Second action: succeeds with fresh context.
- [ ] No orphaned work products in the DB.
- [ ] Adapter reconnects within 10s.

### 2. Checkout race condition
**Approach**: Submit two action envelopes with the same `context.vaultRefs` simultaneously; verify no race in concurrent checkout.

**Setup**:
- Mock vault returning the same refs for two concurrent requests.
- Both requests try to write to overlapping vault paths.

**Assertions**:
- [ ] One succeeds, one gets `ConflictError` (not silent overwrite).
- [ ] The winning write has correct content.
- [ ] Audit log has exactly one `allow` decision for that action_kind.

**Adversarial variant**: What if the "losing" request's audit entry is written before the winner commits? Verify hash chain integrity.

### 3. Action envelope round-trip
**Approach**: Construct an `ActionEnvelope`; serialize to JSON; parse back; verify all fields round-trip correctly.

**Assertions**:
- [ ] `ActorSchema` fields: `id`, `type`, `label`, `role`, `adapterKey` round-trip.
- [ ] `ActionContextSchema` fields: `vaultRefs`, `conversationRefs`, `projectRefs` round-trip.
- [ ] `actionKind` regex validation is enforced on parse.
- [ ] Invalid `actionKind` (e.g., `INVALID`, `has space`) throws `ZodError`.

### 4. All actor types accepted
**Approach**: Submit action envelopes with `actor.type = "human"`, `"agent"`, and `"system"`.

**Assertions**:
- [ ] All three types pass schema validation.
- [ ] System actors are correctly attributed in audit log entries.

### 5. Agent adapter recovery from network partition
**Approach**: Simulate a 30s network interruption between adapter and substrate.

**Assertions**:
- [ ] Adapter retries with exponential backoff.
- [ ] After network restore, adapter resumes polling.
- [ ] No duplicate work products created.

## Dependencies
- BackendEngineer implements `agentos-d` daemon and agent adapters.
- Tests use mock adapters; no real agent hardware required.

## Pass Criteria
All 5 scenarios pass. No race conditions detected. Audit log is consistent under concurrent load.
