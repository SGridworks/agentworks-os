# Test Plan: Pillar 9 — AWCP v0.1 Spec

**Pillar**: AWCP v0.1 spec published; reference impl exports the schema
**Owner**: TechLead
**QA**: QAEngineer
**Status**: Not started

## Verification Gate
AWCP spec published as `docs/awcp.md` v0.1; reference impl in `packages/awcp` exports the schema.

## Test Fixtures

### 1. docs/awcp.md exists and is valid v0.1
**Approach**: Read `docs/awcp.md`; verify it declares `awcp/v0.1`.

**Assertions**:
- [ ] File exists at `docs/awcp.md`
- [ ] Contains `awcp/v0.1` or `awcp v0.1`
- [ ] All sections from the spec outline are present

### 2. Reference impl schema matches spec
**Approach**: Load `packages/awcp/src/schema/index.ts` (or equivalent); verify all types match docs/awcp.md.

**Assertions**:
- [ ] `ActionEnvelope` schema fields match Section 2 of AWCP spec
- [ ] `PolicyDecision` schema fields match Section 3 of AWCP spec
- [ ] `RulePack` schema fields match Section 4 of AWCP spec
- [ ] No field in the impl is absent from the spec
- [ ] No field in the spec is absent from the impl

### 3. Schema version string is consistent
**Approach**: Extract `schema_version` from `RulePackSchema` and from `docs/awcp.md`.

**Assertions**:
- [ ] Both say `awcp/v0.1` (or `awcp/v0.1-draft`)
- [ ] No hardcoded version strings differ between files

## Dependencies
- `docs/awcp.md` written by TechLead
- `packages/awcp` package scaffolded

## Pass Criteria
Spec and impl are consistent. Every schema type in the impl has a corresponding section in the spec.
