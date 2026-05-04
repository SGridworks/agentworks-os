# Test Plan: Pillar 8 — Rule Pack Authoring

**Pillar**: Rule Pack Authoring (YAML editor + CLI dry-run)
**Owner**: ComplianceConsultant
**QA**: QAEngineer
**Status**: Not started

## Verification Gate
YAML editor + dry-run flow works; CLI dry-run works; all 3 existing rule packs pass dry-run.

## Test Fixtures

### 1. CLI dry-run validates a rule pack
**Approach**: Run `agentworks pack dry-run --pack=rule-packs/tcpa-real-estate/tcpa-real-estate-v0.1.yaml`

**Assertions**:
- [ ] Exit code 0
- [ ] Output lists each rule and its conditions
- [ ] No validation errors

### 2. CLI dry-run rejects invalid pack
**Approach**: Run dry-run on a pack with a missing required field.

**Assertions**:
- [ ] Exit code non-zero
- [ ] Error message identifies the missing field
- [ ] No crash (stack trace hidden from end user)

### 3. CLI dry-run --fixture runs a test fixture
**Approach**: `agentworks pack dry-run --pack=X --fixture=consent-missing`

**Assertions**:
- [ ] Fixture input is applied to the pack
- [ ] Expected decision is compared against actual
- [ ] Pass/fail is clearly reported

### 4. All 3 existing rule packs pass dry-run
**Packs to verify**:
- [ ] `rule-packs/tcpa-real-estate/tcpa-real-estate-v0.1.yaml`
- [ ] `rule-packs/smb-starter/smb-starter-v0.1.yaml`
- [ ] `rule-packs/hipaa-placeholder/hipaa-healthcare-v0.1.yaml`

### 5. YAML editor validates in real-time
**Approach**: (Manual) Open the YAML editor in admin UI; enter an invalid pack.

**Assertions**:
- [ ] Validation error shown inline within 500ms
- [ ] Valid pack shows green checkmark
- [ ] Editor does not crash on malformed YAML

### 6. Shadow/enforce toggle is persisted
**Approach**: Toggle a rule pack from shadow to enforce via CLI or UI.

**Assertions**:
- [ ] Change is persisted to DB
- [ ] Subsequent policy checks use the new mode
- [ ] Audit log records the mode change with actor and timestamp

## Dependencies
- `agentworks pack` CLI subcommand implemented
- YAML editor component in admin UI

## Known Blocker
CLI dry-run command does not yet exist. YAML editor is not yet built.

## Pass Criteria
All 6 scenarios pass. All 3 existing packs pass dry-run validation.
