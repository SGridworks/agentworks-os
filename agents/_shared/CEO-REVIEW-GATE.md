# CEO Review Gate (active for any project named "F1..F7 ·")

This file is paste-by-reference into every Operator UX v2 issue body.
It encodes the lifecycle every implementation ticket in the seven
Operator UX v2 projects MUST follow.

## Lifecycle

```
todo  →  in_progress    (assignee picks up the ticket)
       →  review         (assignee finishes work, reassigns to CEO)
       →  done           (CEO accepts after running pass/fail checklist)
       OR
       →  in_progress    (CEO posts "Changes requested: ..." and reassigns back)
```

Spec issues (one per feature, owned by CEO from the start) skip the
review reassignment — the CEO authors the spec deliverable and
self-closes once the markdown is on disk and committed.

GATE issues (one per feature, owned by CEO, last in dependency chain)
run the **feature-level** acceptance checklist found in the issue body.
The CEO authors a release note at
`docs/operator-ux-v2/<feature-slug>-shipped.md`, transitions the GATE to
`done`, and the human operator reviews the release note.

## Assignee responsibilities (BE / FE / etc.)

Before transitioning to `review`:

1. Self-check every pass/fail checkbox in the issue body. Every box must
   be ticked, with evidence in the close comment (file paths, command
   output tails, test summaries).
2. Verify your changes are inside your declared lane. Run
   `git diff --name-only` and confirm no path crosses into another role.
3. Post your close comment in the format below.
4. PATCH the issue: `status: review`, `assigneeAgentId: <CEO-id>`.
5. **Never self-close on Operator UX v2 work.** The substrate's
   `validateCloseHygiene` will catch a missing receipt anyway, but the
   discipline starts here.

### Required close-comment format (assignee → CEO)

```markdown
## Ready for review

Files changed (all inside lane):
- packages/.../<file> (diff: +N -M)
- ...

Tests added / updated:
- packages/.../*.test.ts (vitest: <N pass / 0 fail>)

Verification:
- <command run> → <result>

Pass/fail self-check: all boxes ticked above.

Reassigned to CEO for review gate.
```

## CEO responsibilities

When a ticket lands in `review` with you as assignee:

1. Open the issue. Run every pass/fail checkbox in order.
2. For BE work: run `npx vitest run <package>` from the package dir.
3. For FE work: run `pnpm --dir packages/admin-ui build`. If a new page
   was added or an existing one changed, smoke-test it against the live
   daemon at http://127.0.0.1:7710 with curl (expect 200, no 500s).
4. For SPEC issues authored by another agent: open the markdown,
   confirm sections present, no obvious holes.
5. **Refuse review** if any of:
   - Close-comment hygiene fails (`agents/_shared/CLOSE-COMMENT-HYGIENE.md`)
   - Any pass/fail criterion is not demonstrably met
   - Files outside the assignee's lane are touched
   - Compliance-relevant code bypassed policy-engine review

   On refuse: post `Changes requested: ...` with concrete asks,
   PATCH to `status: in_progress` and reassign to the original assignee.

6. **Approve and close** when all checks pass:
   ```markdown
   ## Approved.

   Verified:
   - <each ticked criterion + how>
   - <test runs / curl probes>

   Closing.
   ```

## When the human reviews

Only GATE issues need explicit human review. After the CEO closes a GATE,
the human reads `docs/operator-ux-v2/<feature>-shipped.md`, exercises the
feature against the live daemon, and gives a thumbs-up. Implementation
tickets do not block on the human.
