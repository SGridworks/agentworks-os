# Codex Brief — fix the v0.1.2 known test failures in `agentos-d`

You are Codex working on AgentWorks OS. Your job is to drive the
`packages/agentos-d` test suite from `5 failed | 22 passed | 8 skipped` (with 1
suite failing to boot) to **all green**, and ship the result as v0.1.2.

This brief is self-contained. Read it end to end before touching code.

---

## 0. Where to work

```bash
cd ~/Projects/agentworks-os-public
git status                     # confirm: on main, clean
git checkout -b release/v0.1.2
```

Do NOT push to `main`. Do NOT push the v0.1.2 tag yourself — the operator
publishes releases. You stop after the branch is committed locally and
`pnpm verify` is green.

Repo layout you'll need:
- `packages/agentos-d/src/cli.test.ts` — backup/restore CLI
- `packages/agentos-d/src/services/mission-map.ts` — color logic source
- `packages/agentos-d/src/services/mission-map.test.ts`
- `packages/agentos-d/src/routes/admin-mission-map.integration.test.ts`
- `packages/agentos-d/src/routes/memory-usage.test.ts` and `routes/memory.ts`
- `packages/agentos-d/src/routes/admin.autopilot.test.ts`

---

## 1. Reproduce the baseline

```bash
pnpm install
pnpm -r build
pnpm --filter @agentworks/agentos-d test 2>&1 | tail -80
```

Expected output: `5 failed | 22 passed | 8 skipped`, plus
`Failed Suites: 1` (`src/routes/admin.autopilot.test.ts` — daemon health
timeout). Confirm this matches before changing anything. If you see a
different count, stop and surface to the operator — the brief is stale.

---

## 2. The six failures, root-caused

### 2.1 admin.autopilot.test.ts — daemon never becomes healthy (1 suite)

**File:** `packages/agentos-d/src/routes/admin.autopilot.test.ts:63`

**Cause:** the test spawns the daemon with `AGENTWORKS_DATA_DIR=...`. That
env var was renamed to `AGENTOS_DATA_DIR` in v0.1.0 (see
[reference-cwd-and-rootdir-traps] in the v0.1.0 release log and `CLAUDE.md`
in `packages/agentos-d/`). The daemon ignores the test's tmp dir, falls
back to the package-relative `./data` path, hits a permission/path error
on a non-writable target, and never reaches `/api/health`. The test then
times out at line 77.

**Fix:** rename the env var on the spawn `env` block, line 63:

```diff
-    AGENTWORKS_DATA_DIR: join(tmpRoot, "data"),
+    AGENTOS_DATA_DIR: join(tmpRoot, "data"),
+    AWOS_AGENTS_ROOT: join(tmpRoot, "agents"),
```

(`AWOS_AGENTS_ROOT` matches the same fix used in `tests/substrate-e2e.test.ts`
during the v0.1.0 release dir — without it, `agentsRoot` defaults to
`path.resolve(cwd, '..', '..', 'agents')` which can resolve to
`/private/agents` from `/private/tmp/...` and EACCES.)

**Verify:**

```bash
pnpm --filter @agentworks/agentos-d vitest run src/routes/admin.autopilot.test.ts
```

Expected: suite boots, all tests in the suite pass.

### 2.2 + 2.3  cli.test.ts — restore exit code 1 (×2)

**Files:**
- `packages/agentos-d/src/cli.test.ts:139` (plain restore)
- `packages/agentos-d/src/cli.test.ts:170` (encrypted restore)

**Tests:**
- `restore of plain archive succeeds`
- `restore of .enc archive with correct key succeeds`

**Symptom:** `expect(exitCode).toBe(0)` got `1`. Restore CLI exits non-zero.

**Investigate first** (do NOT silence the test). Capture the actual stderr:

```bash
cd ~/Projects/agentworks-os-public/packages/agentos-d
pnpm vitest run src/cli.test.ts 2>&1 | grep -A 20 "restore of plain archive succeeds"
```

You're looking at `src/bin/restore.ts` and `src/bin/db-utils.ts`. The v0.1.1
hardening added `clearStaleSqliteSidecars()` (called before write) and
`assertBackupCapturedSourceData()` (called after backup). One of those
guards likely now refuses to proceed when the test wipes the data dir
before restore (line 136 / 167). The guard expectation is correct in prod;
the test setup needs to be updated to match.

**Likely fixes (decide based on actual stderr):**

- If `clearStaleSqliteSidecars` errors when the dir doesn't exist: the test
  should `mkdir -p dataDir` after `rmSync`, so there's a clean dir to
  restore into.
- If the failure is "backup is empty" / sentinel row count is 0: the test
  needs to **populate the data dir before backup** (currently it backs up an
  empty/just-bootstrapped DB which the new safety check rejects).
- If neither, surface the actual error and propose a targeted fix.

**Fix the cause, not the assertion.** It's tempting to change `toBe(0)` to
`not.toBe(0)` — don't. The product intent is "round-trip restore returns 0",
and v0.1.1 hardening shouldn't break that.

After fixing, also confirm `restore of .enc archive without key exits 1`
(currently passing) and `restore of .enc archive with wrong key exits 1`
(currently passing) STILL pass. Don't regress them.

**Verify:**

```bash
pnpm vitest run src/cli.test.ts
```

All seven tests in the `backup / restore CLI` suite pass.

### 2.4 memory-usage.test.ts — lastUsedBy `[]` vs `undefined` (×1)

**File:** `packages/agentos-d/src/routes/memory-usage.test.ts:128`

**Test:** `should not track usage when reading without actorId`

**Symptom:** `expected [] to be undefined`. The provenance frontmatter
includes `lastUsedBy: []` when no actorId was supplied; test expects the
key to be absent.

**Decision:** which is right? Check `packages/agentos-d/src/services/provenance.ts`
(this was touched in v0.1.0 with an `exactOptionalPropertyTypes` fix that
used a conditional spread). The conditional-spread pattern is exactly to
avoid emitting empty/default values into the frontmatter. If the writer
currently emits `lastUsedBy: []` for the no-actor path, that's
inconsistent with the rest of the file and the test is the right
expectation.

**Fix:** at the provenance write site, omit `lastUsedBy` from the
frontmatter when there are no actors. Use the same conditional-spread
pattern the file already uses for `authoringAgent`, `lastUpdatedBy`, etc.

If you discover the writer is intentionally emitting `[]` (e.g., admin-ui
relies on the key existing), update the test to `expect(...).toEqual([])`
and document the reason in a one-line code comment at the test site.
Default to fixing the writer.

**Verify:**

```bash
pnpm vitest run src/routes/memory-usage.test.ts
```

All four tests in the `Memory Routes - Usage Tracking` suite pass.

### 2.5 + 2.6  mission-map color logic (×2)

**Files:**
- `packages/agentos-d/src/services/mission-map.ts:128` — code
- `packages/agentos-d/src/services/mission-map.test.ts:126` — unit
- `packages/agentos-d/src/routes/admin-mission-map.integration.test.ts:244` — integration

**Symptom:** test expects `#ef4444` (red-500) for blocked issue status; code
returns `#991b1b` (red-900).

**Read both tests end-to-end** to see the full color contract:

```typescript
// services/mission-map.test.ts (the contract):
//   issue.status=done       -> #10b981  (green-500)
//   issue.status=review     -> #8b5cf6  (purple-500)
//   issue.status=blocked    -> #ef4444  (red-500)        // <-- failing
//   run.status=failed       -> #ef4444  (red-500)
//   evidence.severity=block -> #991b1b  (red-900)        // <-- not yet hit
```

The intended convention: red-500 (`#ef4444`) for "danger" status (blocked
issues, failed runs), red-900 (`#991b1b`) reserved for severe-evidence
nodes. Current code mis-routes blocked issues to red-900, and the
evidence branch only matches `severity === "critical"` not `"block"`.

**Fix `mission-map.ts` lines 122–137:**

```diff
   if (node.kind === "issue") {
     switch (node.status) {
       case "done":  return "#10b981"; // green-500
       case "review":return "#8b5cf6"; // purple-500
-      case "blocked":return "#991b1b"; // red-900 for blocked severity
+      case "blocked":return "#ef4444"; // red-500
     }
   }
   
   if (node.kind === "run" && node.status === "failed") return "#ef4444"; // red-500
   
-  if (node.kind === "evidence" && node.meta.severity === "critical") return "#991b1b"; // red-900
+  if (node.kind === "evidence" && (node.meta.severity === "critical" || node.meta.severity === "block")) return "#991b1b"; // red-900
```

Also update the comment on the new `case "blocked"` line so future
readers don't repeat the confusion: `// red-500 — danger; #991b1b is
reserved for severe-evidence nodes`.

**Verify:**

```bash
pnpm vitest run src/services/mission-map.test.ts src/routes/admin-mission-map.integration.test.ts
```

Both `computes node colors correctly` tests pass.

---

## 3. Full-suite verification

After all six are fixed:

```bash
cd ~/Projects/agentworks-os-public
pnpm --filter @agentworks/agentos-d test
```

Expected: `0 failed`, `~629 passed | 8 skipped`, no failed suites.

Then full workspace:

```bash
pnpm verify
```

Expected: full workspace build clean, `tests/substrate-e2e.test.ts`
**8/8 green**.

If a previously-passing test now fails because of your fix, that's a
regression — root-cause it before claiming done. Common cause: changing
shared color constants ripples to admin-ui snapshot tests; if you see a
snapshot fail, regenerate it intentionally with `vitest -u` and confirm
the diff is the color you changed.

---

## 4. Stranger E2E

```bash
rm -rf /tmp/awos-smoke-v0.1.2
git clone --branch release/v0.1.2 ~/Projects/agentworks-os-public /tmp/awos-smoke-v0.1.2
cd /tmp/awos-smoke-v0.1.2
pnpm install
pnpm verify
```

Expected: clean install + 8/8 substrate-e2e green from a fresh clone.

---

## 5. Commits

Land your work as separate commits per category — easier to revert if one
introduces a regression. Conventional-commits format, no emojis, body
explains *why*:

1. `test(agentos-d): rename AGENTWORKS_DATA_DIR to AGENTOS_DATA_DIR in autopilot test`
2. `fix(agentos-d): backup-restore CLI test populates data dir before snapshot`
   (or whatever §2.2/2.3 root-cause turns out to be)
3. `fix(agentos-d): omit empty lastUsedBy from provenance frontmatter`
4. `fix(agentos-d): blocked issues use red-500, evidence severity=block uses red-900`

If the cli.test fixes are simple test-side updates, that's a `test:` commit.
If they require changes to `bin/restore.ts` or `bin/db-utils.ts`, split:
one `fix:` commit for runtime, one `test:` commit for adjusted setup.

---

## 6. Version bump

Once all green:

```bash
# Bump every package.json from 0.1.1 to 0.1.2
for f in package.json packages/*/package.json apps/*/package.json; do
  python3 -c "
import json
d = json.load(open('$f'))
if d.get('version') == '0.1.1': d['version'] = '0.1.2'
json.dump(d, open('$f','w'), indent=2)
open('$f','a').write('\n')
"
done

# Bump installer + doc URLs
sed -i.bak 's|releases/download/v0.1.1/install.sh|releases/download/v0.1.2/install.sh|g' \
  apps/installer/src/install.sh README.md docs/install-runbook.md docs/migration-guide.md \
  docs/quickstart.md docs/users-guide.md
sed -i.bak 's|INSTALLER_VERSION="0.1.1"|INSTALLER_VERSION="0.1.2"|g' apps/installer/src/install.sh
sed -i.bak 's|blob/v0.1.1/|blob/v0.1.2/|g' docs/awcp.md
sed -i.bak 's|--branch v0.1.1|--branch v0.1.2|g' docs/install-runbook.md
find . -name '*.bak' -delete
```

### CHANGELOG entry

Add to `CHANGELOG.md` above the `## [0.1.1]` section:

```markdown
## [0.1.2] — <YYYY-MM-DD>

Patch release. Closes the v0.1.1 known-issues list — the agentos-d test
suite is now fully green.

### Fixed

- **`packages/agentos-d` autopilot integration test** — env var
  `AGENTWORKS_DATA_DIR` was renamed to `AGENTOS_DATA_DIR` in v0.1.0 but
  the test still spawned the daemon with the old name, so the daemon
  never reached the test's tmp data dir and never became healthy.
- **Backup / restore CLI tests** — restore round-trip now returns exit 0
  consistently against the v0.1.1 backup-safety guards.
- **Provenance frontmatter** — reads without an `actorId` no longer emit
  `lastUsedBy: []`; the key is omitted entirely (consistent with how
  `authoringAgent`, `lastUpdatedBy`, etc. are handled).
- **Mission-map node colors** — blocked issues now render red-500
  (`#ef4444`) like failed runs; red-900 (`#991b1b`) is reserved for
  evidence nodes with `severity` of `block` or `critical`.

### Known issues

None at the substrate level. `tests/substrate-e2e.test.ts` 8/8 green;
`packages/agentos-d` 629/629 (8 skipped by design).
```

Commit:

```
chore(release): bump to 0.1.2
```

---

## 7. Final report (post this back to the operator)

```
v0.1.2 ready on branch release/v0.1.2.

Tests:
  agentos-d:        629 passed, 8 skipped, 0 failed (was 5 failed + 1 suite startup fail)
  substrate-e2e:    8/8 green
  Stranger clone:   pnpm verify green from /tmp/awos-smoke-v0.1.2
  Full workspace:   pnpm verify green

Commits:
  <SHA1> test(agentos-d): rename AGENTWORKS_DATA_DIR to AGENTOS_DATA_DIR in autopilot test
  <SHA2> ... (etc)
  <SHA-bump> chore(release): bump to 0.1.2

What I did NOT do (operator's call):
  - Did not push to main
  - Did not tag v0.1.2
  - Did not create the GitHub release
  - Did not update the announcement drafts in vault

Outstanding observations / risks:
  <anything you noticed during the work — e.g., "test setup wipes
  package-relative data/ between runs, vulnerable to parallel-vitest
  collisions" — be specific. If clean, write "None.">
```

---

## Hard rules

- **No `--no-verify`** on commits.
- **Don't disable or skip a failing test** to make it "pass". If a test is
  genuinely wrong, fix the assertion AND document why in a one-line
  comment at the test site.
- **No new dependencies** unless one of the existing fixes genuinely
  requires it. Surface to operator first.
- **No churn outside the failing-test surface.** Don't refactor
  `mission-map.ts` to use a constants object "while you're in there" —
  bug-fix discipline. v0.1.2 is a patch release, not a refactor.
- **Don't change shipping behavior.** If a fix would change what end-users
  see (e.g., changing the actual color shown to admins), confirm intent
  is consistent with the test expectations before shipping.
- **One commit, one logical change.** No "wip" or "fixes" commits.

If you hit a wall (a test that doesn't fit any of the patterns above, or a
fix that requires more than ~30 lines of change), stop and write up the
blocker for the operator instead of pushing through.
