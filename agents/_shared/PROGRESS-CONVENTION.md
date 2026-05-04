# Progress Convention – Resume‑Safe Agent Journals

Agents run in short heartbeat windows. When a heartbeat is interrupted (e.g., server restart, crash, or manual kill) the next run must be able to resume exactly where it left off. The **progress.md** journal provides that resumability.

## Location
```
~/.paperclip/runs/<runId>/progress.md
```
`<runId>` is the `PAPERCLIP_RUN_ID` environment variable set by the Paperclip agent runtime for each heartbeat.

## Format
Each entry is a single line prefixed with a 24‑hour timestamp (HH:MM) followed by a brief description. Optional indented blocks can contain more detail (e.g., command output, error traces).

```
[14:03] checkout issue 6a292c…
[14:04] git commit -m "Add PROGRESS-CONVENTION.md"
    Files changed:
      - agents/_shared/PROGRESS-CONVENTION.md
[14:07] PATCH /api/issues/… – add comment "updated heartbeat protocol"
[14:10] RESUMED – read last entry "PATCH /api/issues/…"
```

## When to Append
- After **every** successful `git commit`.
- After **every** successful `PATCH /api/issues/...` that mutates the ticket.
- After a **meaningful tool failure** (timeout, validation error) or a **decision pivot** (switching task, re‑assigning).
- After **checkout** of an issue (record the issue ID).

## When to Read
At the **start of every heartbeat**, *before* performing any new action, read the file to reconstruct the last known state:
```
cat $HOME/.paperclip/runs/$PAPERCLIP_RUN_ID/progress.md 2>/dev/null || true
```
If the file does not exist (first run) the command safely returns nothing.

## Integration with Heartbeat Protocol
Step 6 of `HEARTBEAT-PROTOCOL.md` now explicitly references the progress file and labels the step **"Understand context"**. Agents must read the journal before issuing any further API calls.

## Smoke Test
1. Start a heartbeat and perform a checkout, then append an entry.
2. Kill the heartbeat process mid‑run.
3. Restart the heartbeat; it should read the existing `progress.md`, log a `RESUMED` entry referencing the last line, and continue without duplicate work.

---
*Only the convention file is added; no code changes are required elsewhere.*