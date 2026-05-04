# Test Plan: Pillar 1 — Memory (vault library)

## Gate
`vault.write()` handles disk-full; `.manifest.json` delta tracking is idempotent.

## Verification Criteria

### G1 — vault.write() disk-full resilience
- [ ] write_file fails gracefully when disk is full
- [ ] Error is surfaced to caller with actionable message (not crash)
- [ ] No partial writes left on disk after failure

### G2 — manifest.json delta tracking is idempotent
- [ ] Writing the same content twice produces identical manifest delta
- [ ] Manifest correctly records create / update / delete operations
- [ ] Manifest format is valid JSON
- [ ] Concurrent writes do not corrupt manifest (sequentialize or lock)

### G3 — vault path resolution
- [ ] Resolves relative to vault root
- [ ] Rejects paths with `..` traversal attempts

## Test Fixtures Required
- `tests/fixtures/vault/disk-full-simulator.ts` — monkey-patch `write_file` to throw ENOSPC
- `tests/fixtures/vault/manifest-schema.json` — JSON Schema for manifest entries

## Pass Criteria
All assertions pass with `pnpm test packages/memory` (or equivalent).

## Adversarial Tests
- Write 10K records in a tight loop; verify manifest stays consistent
- Fill disk, attempt write, verify no orphan lock files
- Concurrent writes from 3 simulated agents writing to the same vault path

## Notes
- Memory package does not yet exist on disk. This plan is `blocked` until the package is scaffolded.
- See: `packages/memory` missing from repo.
