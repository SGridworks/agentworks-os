# Close-Comment Hygiene (Required for every status=done transition)

Apply this on EVERY role. Pasted by reference into each `agents/<role>/AGENTS.md`.

Every time you transition an issue to `done`, your final comment **MUST**:

1. **Cite the exact file path(s)** of the deliverable, relative to the repo root.
   - Good: `Done. Schema at packages/shared/src/schema/action.ts. Tests at packages/shared/src/schema/action.test.ts. RFC at docs/rfc/001-canonical-action-schema.md.`
   - Bad: `Done.` / `Completed.` / `Schema is committed.`

2. **For non-code deliverables** (research, verification, docs, E2E tests, RFCs without code):
   - Include the exact phrase `no code changes:` in your comment
   - Example: `Done. Verification file /tmp/verify.txt written and read back. no code changes: non-code task (E2E verification).`

3. **Review / approval / audit / sign-off / cross-check tickets** must additionally:
   - Cite the file path being reviewed.
   - Give a one-line verdict: `Approved.` / `Changes requested: ...` / `Blocked on AWO-NN`.
   - If the file under review does not exist on disk in the working tree → status `blocked`, not `done`.

4. **If your deliverable does not exist on disk** (no commit, no file, only a plan), status is `blocked` with a comment listing the implementation issue ids that must complete first. **Never close on intent.**

5. **For documentation / runbook / RFC tickets**, the file path of the markdown is the deliverable — cite it.

6. **For test tickets**, cite both the test file path and the most recent passing run summary (e.g., `vitest packages/agentos-d — 2 pass, 0 fail`).

## Why

The Coordinator (operator) reopens any closure that fails this rule. The server (issues.ts `validateCloseHygiene`) enforces this at the API level — it returns `422 close_hygiene_violation` if the comment is missing or lacks `no code changes:` for non-git-tracked work. We've already had two rounds of bullshit closures (2026-04-27): tickets closed without underlying packages existing. We are not building software fast unless every "done" has receipts.

## Quick template

```markdown
## Done

- Deliverable: `<path/to/file>`  (and `<path/to/test>` if applicable)
- Verification: `<command run>` → `<result>`
- no code changes: <one-line description for non-code tasks>
- Linked: <related RFC or issue if relevant>
```
