# Heartbeat Protocol — Read FIRST Every Wakeup

You run in **heartbeats**. Each wakeup is a short window where you do something useful and exit. The Paperclip control plane is your task tracker. Skipping the lifecycle means **your work doesn't count** — the ticket stays open, the orchestrator thinks nothing happened, and the Coordinator has to clean up by hand.

## The Protocol (Required Every Wakeup)

```
0. Identity            GET /api/agents/me
0b. GitHub routing     Check: was this wakeup triggered by a GitHub issue?
                        If reason contains "github.com/SGridworks/agentworks-os/issues/NNN":
                          → work that GitHub issue first, ignore Paperclip inbox this heartbeat
                        If reason contains a specific PAPERCLIP_TASK_ID:
                          → work that ticket, ignore inbox
1. Inbox               GET /api/agents/me/inbox-lite
2. Pick work           Only if no GitHub issue or PAPERCLIP_TASK_ID is set:
                        in_progress first → then todo. Otherwise exit cleanly.
3. Checkout            POST /api/issues/{id}/checkout
                        {"agentId":"<your-id>","expectedStatuses":["todo","backlog","blocked"]}
4. Context             GET /api/issues/{id}/heartbeat-context
5. Do the work         Code, docs, tests, whatever the ticket says.
6. Understand context – read prior progress
                        cat $HOME/.paperclip/runs/$PAPERCLIP_RUN_ID/progress.md 2>/dev/null || true
7. Close or block      PATCH /api/issues/{id}
                        {"status":"done|blocked|in_progress",
                         "comment":"<file paths> no code changes:"}
```

**Step 7 comment is required for every done/blocked transition.** The server enforces close hygiene — the comment must cite file path(s) and include the exact phrase `no code changes:` (for non-code deliverables like research, verification, docs) OR a git commit diff reference. Without it the server returns 422 `close_hygiene_violation`.

**For `in_progress`** — still post a comment describing what you're doing.

## Auth (local_trusted mode)

Server runs in `local_trusted` mode. Use `Authorization: Bearer $PAPER...KEY` in every call (the env var is auto-injected; value `local-trusted` is fine — the server treats loopback callers as the local board user).

Base URL: `$PAPERCLIP_API_URL` (defaults `http://localhost:3100`).

## Common mistakes that cost a heartbeat

- **Doing the work but skipping checkout.** Tickets stay `todo`. Coordinator has to backfill or close by hand. **Always checkout first.**
- **Closing without a comment.** Every `done` transition requires a comment with file paths and `no code changes:`. Server rejects transitions without it (422 `close_hygiene_violation`).
- **Closing without a file-path citation.** See `agents/_shared/CLOSE-COMMENT-HYGIENE.md`. Coordinator reopens these.
- **Bulk reopening.** Never reopen multiple tickets in a loop. Reopen is high-risk; check the deliverable on disk first.
- **Closing on intent.** If the file isn't on disk, the ticket is `blocked`, not `done`.
- **No comment on `in_progress`.** Every heartbeat where you touched a ticket gets a comment, even if it's `in_progress: still working on X`.

## When GitHub Issue is in Wakeup Reason

If the wakeup reason contains `github.com/SGridworks/agentworks-os/issues/NNN`:
1. Extract the issue number
2. Verify it's assigned to you or unassigned
3. Checkout the corresponding Paperclip issue (or create one if none exists)
4. Do the work described in the GitHub issue
5. Post results as a comment on the GitHub issue
6. Also close/comment the Paperclip ticket if one exists

Do NOT go to the Paperclip inbox unless the GitHub issue is genuinely blocked or done.

## When PAPERCLIP_TASK_ID is Set

The wakeup payload pointed you at a specific ticket. That's your priority for this heartbeat. Checkout it, work on it, comment, and either close or leave `in_progress` with a progress comment. Do not wander to other tickets unless the targeted one is genuinely blocked or already done.

## ProcessWatcher monitoring

ProcessWatcher monitors heartbeat hygiene — stale checkouts, missing close comments, and auto-commit mismatches are flagged automatically (AWO-164). See `agents/processwatcher/AGENTS.md` for the seven-check list.

## When the Inbox is Empty

Exit cleanly. Do not invent work. Do not browse other agents' assignments. The orchestrator will wake you when there's something to do. If you were wake by a GitHub issue and the inbox is empty, still work the GitHub issue.
