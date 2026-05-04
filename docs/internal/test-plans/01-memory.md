# Test Plan — Pillar 1: Memory

**Pillar**: Memory (vault library)
**Owner**: BackendEngineer
**QA**: QAEngineer
**Status**: Not started

## Verification Gate
`vault.write()` handles disk-full; `.manifest.json` delta tracking is idempotent.

## Schema Reference
- `packages/shared/src/schema/action.ts` — `ActionContextSchema` (vaultRefs)
- Vault contract: `~/vault/CLAUDE.md`

## Test Fixtures

### 1. vault.write() disk-full
**Approach**: Mock the filesystem write to raise ENOSPC; verify vault.write() surfaces a legible error and does not corrupt the manifest.

**Setup**:
- Create a temp vault dir with a valid manifest.
- Stub `fs.writeFileSync` to throw `ENOSPC`.
- Call `vault.write({ path, content })`.

**Assertions**:
- [ ] Throws `VaultDiskFullError` (not raw ENOSPC).
- [ ] Original manifest is untouched (byte-identical).
- [ ] Error message includes the path that failed.

**Adversarial variant**: What if the manifest write succeeds but the content write fails? Verify the manifest is not updated with a partial delta.

### 2. .manifest.json delta tracking idempotency
**Approach**: Apply the same delta twice; verify the manifest is identical to a single application.

**Setup**:
- Start with manifest at version N.
- Write delta that adds `["a.md", "b.md"]`.
- Write the same delta again.

**Assertions**:
- [ ] Manifest version is N+1 (not N+2).
- [ ] No duplicate entries in `files` array.
- [ ] `lastModified` timestamp does not change on the second write.

**Adversarial variant**: What if delta is applied out-of-order after a concurrent write? Verify the newest timestamp wins.

### 3. vault.write() happy path
**Approach**: Write new content; verify manifest is updated atomically.

**Assertions**:
- [ ] Content is written to disk at the correct path.
- [ ] Manifest `files` array includes the new path.
- [ ] Manifest `lastModified` is updated.
- [ ] No leftover temp files.

### 4. vault.read() consistency
**Approach**: Read a file that exists; read a file that doesn't exist.

**Assertions**:
- [ ] Existing file returns `{ content, metadata }`.
- [ ] Missing file throws `VaultFileNotFoundError` (not generic ENOENT).
- [ ] Read does not modify manifest.

### 5. Manifest corruption recovery
**Approach**: Truncate the manifest JSON to be invalid mid-write; verify vault detects and reports a readable error rather than silently loading an empty state.

**Adversarial focus**: This is the "silent data loss" scenario operator wants caught.

## Running These Tests
```bash
cd /Users/example/Projects/agentworks-os
pnpm install
pnpm --filter @agentworks/shared test
```

## Dependencies
- BackendEngineer must implement `vault.write()`, `vault.read()`, and the manifest delta logic before these tests can pass.
- Tests stubs/mock the filesystem; no Docker required.

## Pass Criteria
All 5 scenarios pass. No false positives on disk-full detection. Manifest never corrupt under any tested failure mode.
