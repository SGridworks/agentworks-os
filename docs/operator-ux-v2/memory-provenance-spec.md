# Memory Provenance Overlay — Design Spec

## Goal
Add an immutable, queryable provenance layer to every tenant-scoped memory page so operators can answer “who touched this, when, and how often?” without opening the vault. The overlay is stored as frontmatter in the markdown file and exposed through a lightweight REST endpoint. No UI changes in v1.

## Surfaces

### 1. Frontmatter fields (append-only)
```yaml
---
authoringAgent: <uuid>          # first writer
lastUpdatedBy: <uuid>           # most recent writer
lastUpdatedAt: <iso8601>        # wall-clock of last write
lastUsedBy:                     # rolling window of last 10 readers
  - { agentId: <uuid>, usedAt: <iso8601> }
  - ...
---
```

Rules
- All fields are optional on create; the substrate injects any missing ones.
- `lastUsedBy` is a FIFO ring buffer capped at 10 entries; older drops off.
- Timestamps are UTC, millisecond precision, ISO-8601 string.
- Agent IDs must be valid v4 UUIDs; invalid IDs are rejected with 400.

### 2. Capacity bounds (per tenant)
- Max 10 entries in `lastUsedBy` array; excess is truncated on write.
- Max 4 KB for the entire frontmatter block (YAML only). Oversized writes return 413.
- No limit on number of memory pages per tenant (existing vault behavior unchanged).

### 3. GET /api/memory/provenance
Return provenance metadata for a single page without returning the body.

**Request**
```
GET /api/memory/provenance?tenantId=<uuid>&pageId=<uuid>
Authorization: Bearer <tenant-scoped-token>
```

**Success 200**
```json
{
  "tenantId": "uuid",
  "pageId": "uuid",
  "authoringAgent": "uuid",
  "lastUpdatedBy": "uuid",
  "lastUpdatedAt": "2026-05-19T14:23:45.123Z",
  "lastUsedBy": [
    { "agentId": "uuid", "usedAt": "2026-05-19T14:20:01.000Z" },
    ...
  ],
  "readCount": 7,        // derived: length of lastUsedBy
  "writeCount": 3        // derived: number of distinct agents in lastUpdatedBy history (future)
}
```

**Errors**
- 401: missing or invalid bearer token
- 403: token scope does not include requested tenant
- 404: page not found
- 422: missing or malformed query params

**Caching**
- `Cache-Control: private, max-age=0, must-revalidate` (no caching; always fresh)

## Backend

### File layout
No new tables. Provenance lives inside the existing markdown file:
```
/Users/example/vault/tenants/<tenantId>/memory/<pageId>.md
```

### Write path (append-only)
1. Any write (PUT /memory/:pageId) loads existing frontmatter.
2. If `authoringAgent` absent, set to current agent.
3. Always overwrite `lastUpdatedBy` and `lastUpdatedAt`.
4. Append current agent to `lastUsedBy` (reader side does this on GET).
5. Truncate `lastUsedBy` to 10 entries.
6. Re-serialize YAML frontmatter; fail if > 4 KB.
7. Atomically replace file (same fsync guarantees as today).

### Read path
1. GET /memory/:pageId parses frontmatter, appends caller to `lastUsedBy`, and writes back immediately (read-side update).
2. GET /memory/provenance only reads frontmatter; no body, no read-side update.

### Migration
- Existing pages without provenance block return empty object (all fields null).
- First write backfills `authoringAgent` and `lastUpdatedBy` with the writing agent.
- No bulk migration job; provenance appears lazily.

## Frontend
Out of scope for v1. The admin-ui continues to show raw markdown; provenance is API-only.

## Out of scope
- Auto-merge UI or three-way merge logic.
- Cross-tenant provenance (tenant boundary remains hard).
- Historical write log beyond the single “last updated” slot.
- Cryptographic signatures or tamper evidence.
- Size limits on the markdown body itself (only frontmatter is capped).

## Open questions
1. Do we need a separate “createdAt” field or is “first write” sufficient?
   → Deferred; can add later without breaking shape.
2. Should `lastUsedBy` deduplicate the same agent within the window?
   → No; keep every touch for now (simple FIFO).
3. Future eviction policy when vault nears disk quota?
   → Not in v1; revisit with cost-meter work.

## End-state verification
- `npx vitest run tests/substrate-e2e.test.ts` includes a provenance probe:
  - create page → verify frontmatter injected
  - two agents read → verify `lastUsedBy` length 2
  - 12 agents read → verify `lastUsedBy` length 10, correct eviction order
  - GET /api/memory/provenance returns expected JSON without body
