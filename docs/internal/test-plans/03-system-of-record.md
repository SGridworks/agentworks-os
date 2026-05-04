# Test Plan: Pillar 3 — System of Record

## Gate
Hash-chained audit log verifiable; CSV export complete.

## Verification Criteria

### G1 — Hash-chained audit log integrity
- [ ] Every policy decision record has `decisionHash` (SHA-256 of record fields + prevDecisionHash)
- [ ] `prevDecisionHash` links to the previous record's `decisionHash` (or "GENESIS" for first record)
- [ ] `verifyChainIntegrity()` returns `valid: true` for an unbroken chain
- [ ] `verifyChainIntegrity()` returns `valid: false, brokenAt: N` when any record is tampered
- [ ] Tampering with `decision` field after hashing is detected
- [ ] Tampering with `prevDecisionHash` link is detected

### G2 — CSV export is complete
- [ ] Export includes all records in the audit log
- [ ] Export includes all required fields: tenantId, actorId, actorType, actionKind, decision, decisionReason, decisionHash, prevDecisionHash, proposedAt, decidedAt, createdAt
- [ ] Export is valid CSV (no injection, no broken quoting)
- [ ] Export is reproducible (same data produces same file hash)

### G3 — Audit log retention
- [ ] Records older than 30 days are queryable (no premature deletion)
- [ ] Retention policy is configurable (default: 365 days)

## Test Fixtures Required
- `packages/shared/src/crypto.test.ts` already covers hash chain integrity
- Need: CSV export test fixture with a known dataset

## Pass Criteria
All assertions pass with `pnpm test`.

## Covered by Existing Tests
- `packages/shared/src/crypto.test.ts` — `computeDecisionHash`, `verifyDecisionHash`, `verifyChainIntegrity` — 8 tests, all passing.

## Adversarial Tests
- Tamper with a middle record in a 10-record chain; verify brokenAt points to the correct index
- Export CSV, modify one cell, re-import; verify mismatch detected
- Insert a record with a missing required field; verify export skips or errors clearly

## Notes
- CSV export endpoint does not yet exist. This plan is `blocked` until the export route is implemented in `agentos-d`.
- Hash-chaining logic itself is tested and passing.
