# Action Schema Coverage Test Plan

**Issue:** AWO-126 – Action schema coverage test suite

**Goal:** Verify that every `action_kind` value defined in the system produces the correct behavior (`shadow`, `enforce`, `route_to_review`). Ensure edge cases and hostile inputs are covered.

---

## Test Scope

1. **Enumerate `action_kind` values**
   - Locate the source of `action_kind` enumeration (e.g., `packages/policy-engine/src/actionKinds.ts`).
   - Create a table of all possible values.

2. **Expected outcomes**
   - For each `action_kind`, specify the expected outcome (`shadow`, `enforce`, `route_to_review`).
   - Document any conditional logic that alters the outcome (e.g., feature flags).

3. **Positive tests**
   - Write unit tests that feed each `action_kind` into the policy engine and assert the correct outcome.
   - Use the existing test harness (`packages/policy-engine/tests/`).

4. **Negative / adversarial tests**
   - Craft inputs that attempt to subvert the engine (e.g., malformed JSON, injection strings, unexpected enums).
   - Verify that the engine safely defaults to a safe outcome (`shadow` or reject) and logs a warning.

5. **Integration flow**
   - End‑to‑end test: simulate an intake request that triggers each `action_kind` and verify downstream side‑effects (audit log entry, queue placement, UI flags).

6. **Performance gate**
   - Ensure the entire suite runs under the CI timeout (max 5 min).

---

## Test Cases (Outline)

| Test ID | `action_kind` | Input payload | Expected outcome | Notes |
|--------|---------------|--------------|------------------|-------|
| TC‑001 | `shadow` | valid request | `shadow` | basic path |
| TC‑002 | `enforce` | valid request | `enforce` | basic path |
| TC‑003 | `route_to_review` | valid request | `route_to_review` | basic path |
| TC‑004 | *All Others* | valid request | `shadow` (default) | verify fallback |
| TC‑005 | `enforce` | malformed JSON | `shadow` (safe) | host‑ile test |
| TC‑006 | `route_to_review` | SQL injection string in metadata | `shadow` (safe) | adversarial |

---

## Test Implementation Steps

1. **Create test file** `packages/policy-engine/tests/test_action_schema.py` using `pytest`.
2. Import the action enum and the engine entry point.
3. Parameterize the test matrix using `@pytest.mark.parametrize`.
4. Run the suite locally: `pnpm test packages/policy-engine`.
5. Add the file to git and push.

---

## Verification

- **Pass criteria:** All tests pass (`0 failures`). Coverage for the `policy-engine` package >= 80 %.
- **Adversarial test pass:** Hostile inputs never produce `enforce` or `route_to_review` unexpectedly.
- **CI integration:** The test suite is referenced in `.github/workflows/ci.yml` under the `policy-engine` job.

---

## Acceptance

- Review by **BackendEngineer** for test correctness.
- Sign‑off by **CEO (Hermes)** after CI green.

---

*Generated via Hermes QAEngineer following the writing‑plans skill.*