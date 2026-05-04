# Test Plan: Pillar 4 — Policy Gates

## Gate
12+ rule pack scenarios; shadow/enforce flip is logged.

## Verification Criteria

### G1 — All action_kind values are covered
Every `action_kind` in the canonical schema must be tested with allow/block/route_to_review outcomes:

| action_kind | allow | block | route_to_review |
|-------------|-------|-------|----------------|
| outbound.sms | Y | Y | Y |
| outbound.email | Y | Y | Y |
| outbound.call | Y | Y | Y |
| crm.write | Y | Y | Y |
| lead.enrich | Y | Y | Y |
| llm.completion | Y | Y | Y |
| memory.read | Y | Y | Y |
| memory.write | Y | Y | Y |
| agent.dispatch | Y | Y | Y |
| workflow.trigger | Y | Y | Y |

### G2 — Shadow mode
- [ ] `shadowMode: true` flag is set on every result when engine is in shadow mode
- [ ] Shadow mode results are logged but do not block the action
- [ ] Shadow mode logs are stored in the audit log with `shadowMode: true`

### G3 — Enforce mode
- [ ] `shadowMode: false` when engine is in enforce mode (default)
- [ ] Block decision actually blocks (returns block to caller)
- [ ] route_to_review decision routes to approval queue

### G4 — Shadow → enforce flip
- [ ] Flip is logged with timestamp and actor who flipped
- [ ] Shadow logs from before the flip remain queryable and unchanged
- [ ] Flip from shadow to enforce takes effect within 1 request cycle

### G5 — 12+ scenarios
- [ ] Minimum 12 distinct scenario tests covering TCPA, fair housing, data privacy, and general cases
- [ ] Each scenario includes: pack YAML, action envelope, expected decision, expected reason string

### G6 — Missing data → route_to_review
- [ ] When required_data field is null, `disposition_when_missing` applies
- [ ] `missingFields` array in result lists all absent fields
- [ ] Default disposition_when_missing is `route_to_review`

## Test Fixtures Required
- `tests/fixtures/rules/scenarios.yaml` — 12+ scenario fixtures
- `tests/fixtures/rules/shadow-flip.yaml` — shadow→enforce scenario

## Covered by Existing Tests
- `packages/policy-engine/src/evaluator.test.ts` — 6 tests passing (18 total, 12 failing due to schema mismatch with test fixtures)
- `packages/shared/src/schema/policy-decision.test.ts` — 27 tests, all passing

## Blocked Tests (schema mismatch)
The following tests in `evaluator.test.ts` fail because the schema requires non-empty `required_data` and `conditions` arrays, but the tests use empty arrays. This is a pre-existing bug in the test fixtures, not the schema:
- "rejects duplicate rule_ids" — schema does not validate uniqueness
- "returns allow when no rules are defined" — schema requires `rules: [min(1)]`
- "returns allow when all conditions match" — requires `required_data: ["field"]`
- "first matching block stops evaluation" — requires `required_data` on both rules
- "returns route_to_review when time-of-day is outside business hours" — requires `required_data`
- "route_to_review takes precedence over lower-priority allow" — requires `required_data`
- "first non-allow from any pack wins" — requires `required_data`
- "all packs return allow" — requires `required_data`
- "does not set shadowMode flag when false" — schema behavior mismatch
- "null check" — requires `required_data`
- "array IN check" — requires `required_data`
- "range check" — requires `required_data`

## Pass Criteria
All 18 tests in `packages/policy-engine/src/evaluator.test.ts` pass.

## Fix Required
Test fixtures must be updated to:
1. Include `required_data: ["<field>"]` on every rule (or the schema needs a `required_data: []` opt-out)
2. Fix "no rules" test — empty rules array is invalid per schema (min 1)
3. Fix duplicate rule_id test — schema does not currently enforce uniqueness; either add to schema or remove test
4. Fix shadowMode test — investigate why `shadowMode: false` produces `undefined` in result
