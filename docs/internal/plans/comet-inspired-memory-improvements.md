# CoMeT-Inspired Memory Improvements — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Adopt 7 ideas from CoMeT (Dirac-Robot/comet) to strengthen the AgentWorks memory package: 3-tier progressive retrieval, cognitive compaction triggers, snapshot-protected vault writes, lazy detail for audit entries, session briefs, importance-driven vault pruning, and a transparent MCP proxy mode.

**Architecture:** All 7 features are additive to the existing `packages/memory` and `packages/agentos-d`. No existing APIs are changed. Each feature is gated behind a feature flag or configuration option so customers not using a feature don't pay the cost.

**Tech Stack:** TypeScript (ESM, Zod), Node.js built-ins where possible, no new external dependencies except where noted.

---

## Feature 1 — 3-Tier Progressive Retrieval

**What it does:** Every vault page gets a `summary` (1-2 sentence indexable description) and a `trigger` ("when I need to know...") written at save time, in addition to the full `body`. Read operations return summary+trigger by default; callers can request detail or raw on demand.

**Why:** Currently agents either get the full page (expensive, noisy) or nothing. Tier 1 (summary+trigger) is ~50-100 tokens vs. the full page. Tier 2 (detail) is generated once and cached. This is also required by Feature 4 (lazy detail for audit entries).

### Task 1: Add summary and trigger fields to VaultPage

**Files:**
- Modify: `packages/memory/src/types.ts`

**Step 1: Write failing test**

```typescript
// packages/memory/src/vault-page.test.ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { VaultPageSchema } from "./types.js";

describe("VaultPageSchema", () => {
  it("accepts page with summary and trigger", () => {
    const page = {
      tenantId: "t1",
      key: "contacts/acme.md",
      body: "# Acme Corp\n\n123 Main St. Account since 2021.",
      summary: "Acme Corp, 123 Main St, customer since 2021",
      trigger: "When I need the Acme Corp address or account history",
      updatedAt: new Date().toISOString(),
      sha256: "abc123",
    };
    const result = VaultPageSchema.safeParse(page);
    expect(result.success).toBe(true);
  });

  it("backwards compatible — summary and trigger are optional", () => {
    const page = {
      tenantId: "t1",
      key: "contacts/acme.md",
      body: "# Acme Corp",
      updatedAt: new Date().toISOString(),
      sha256: "abc123",
    };
    const result = VaultPageSchema.safeParse(page);
    expect(result.success).toBe(true);
  });
});
```

**Step 2: Run test to verify failure**
Run: `cd packages/memory && npx vitest run src/vault-page.test.ts`
Expected: FAIL — VaultPageSchema doesn't have summary/trigger fields yet

**Step 3: Write minimal implementation**

```typescript
// packages/memory/src/types.ts — add to VaultPage interface
export interface VaultPage {
  tenantId: string;
  key: VaultKey;
  body: string;
  /** 1-2 sentence indexable description. */
  summary?: string;
  /** "When I need to know..." — retrieval-oriented. */
  trigger?: string;
  updatedAt: string;
  sha256: string;
}
```

**Step 4: Run test to verify pass**
Run: `cd packages/memory && npx vitest run src/vault-page.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add packages/memory/src/types.ts packages/memory/src/vault-page.test.ts
git commit -m "feat(memory): add optional summary and trigger fields to VaultPage"
```

---

### Task 2: Add Tier 1 (summary+trigger) and Tier 2 (lazy detail) to FileVaultStore

**Files:**
- Modify: `packages/memory/src/file-store.ts`

**Step 1: Write failing test**

```typescript
// packages/memory/src/file-store.test.ts — add tiered read tests
import { describe, it, expect, beforeEach } from "vitest";
import { FileVaultStore } from "./file-store.js";
import { tmpdir } from "node:fs/promises";
import { join } from "node:path";

describe("FileVaultStore — tiered read", () => {
  let root: string;
  let store: FileVaultStore;
  beforeEach(async () => {
    root = await tmpdir();
    store = new FileVaultStore(root);
  });

  it("read returns summary and trigger when present", async () => {
    await store.write("t1", "contacts/acme.md", "# Acme Corp\n\n123 Main St.", {
      summary: "Acme Corp address and account info",
      trigger: "When I need Acme's address",
    });
    const result = await store.read("t1", "contacts/acme.md");
    expect(result.summary).toBe("Acme Corp address and account info");
    expect(result.trigger).toBe("When I need Acme's address");
  });

  it("read returns depth=summary by default (tier 1)", async () => {
    await store.write("t1", "contacts/acme.md", "# Acme Corp\n\nLong body...", {
      summary: "Acme summary",
      trigger: "When I need Acme",
    });
    // Current read behavior should not change for pages without tiers
    const result = await store.read("t1", "contacts/acme.md");
    expect(result.tier).toBe("summary"); // default tier
    expect(result.body).toBeDefined();
  });
});
```

**Step 2: Run test to verify failure**
Run: `npx vitest run src/file-store.test.ts`
Expected: FAIL — `tier` and extra fields not in VaultReadResult

**Step 3: Write minimal implementation**

Update `VaultReadResult` in `types.ts`:
```typescript
export type VaultReadTier = "summary" | "detail" | "raw";

export interface VaultReadResult extends VaultPage {
  existed: boolean;
  tier?: VaultReadTier; // which tier was returned
}
```

Update `FileVaultStore.read()` in `file-store.ts` to store and return `summary`/`trigger` from the frontmatter. Body reading stays as-is for backward compatibility — summary/trigger are extra fields read from frontmatter.

**Step 4: Run test to verify pass**
Expected: PASS

**Step 5: Commit**
```bash
git commit -m "feat(memory): FileVaultStore surfaces summary and trigger fields"
```

---

### Task 3: Add tiered read API to agentos-d MCP server

**Files:**
- Modify: `packages/agentos-d/src/routes/mcp.ts`

**Step 1: Write failing test**

```typescript
// packages/agentos-d/src/routes/mcp.test.ts
it("memory.read supports tier parameter", async () => {
  const res = await request(app)
    .post("/mcp/v1/read")
    .send({ key: "contacts/acme.md", tier: "summary" });
  expect(res.body.tier).toBe("summary");
  expect(res.body.summary).toBeDefined();
});
```

**Step 2: Run test to verify failure**
Expected: FAIL — tier parameter not implemented

**Step 3: Add tier parameter to memory read tool in mcp.ts**
The MCP `memory.read` tool already exists. Add optional `tier?: "summary" | "detail" | "raw"` parameter. When `tier === "summary"`, return only `key`, `summary`, `trigger`, `updatedAt` — not the full body. When `tier === "detail"`, generate lazy detail (see Task 4). When `tier === "raw"` or absent, return full body.

**Step 4: Run test to verify pass**
Expected: PASS

**Step 5: Commit**
```bash
git commit -m "feat(mcp): memory.read supports tier parameter (summary/detail/raw)"
```

---

## Feature 2 — Cognitive Compaction Triggers

**What it does:** Instead of writing to the vault only on explicit `memory.write` calls, add a `CognitiveSensor` that evaluates each action envelope through a fast SLM pre-filter and decides whether to auto-compact recent context into the vault. Triggers: topic shift detected, information density threshold exceeded, or buffer overflow.

**Why:** Currently vault writes are agent-initiated via explicit tool calls. CoMeT's cognitive sensor runs on every turn and decides autonomously. This means the vault stays populated even when agents forget to write.

### Task 4: Define CompactionTrigger enum and CognitiveSensor interface

**Files:**
- Create: `packages/memory/src/compaction.ts`

**Step 1: Write the types and trigger evaluation logic**

```typescript
/**
 * CompactionTrigger — why a turn was queued for compaction.
 * Mirrors CoMeT's compaction_reason field.
 */
export type CompactionTrigger =
  | "topic_shift"   // logic_flow == BROKEN
  | "high_load"     // load_level exceeded threshold
  | "buffer_overflow" // L1 buffer full
  | "forced"        // agent requested
  | "session_close"; // explicit session end

export interface CompactionDecision {
  trigger: CompactionTrigger;
  loadLevel: number;       // 1-5 scale
  logicFlow: "maintain" | "broken";
  summaryRequired: boolean; // high-load or broken → true
}

/**
 * CognitiveSensor evaluates a turn and decides if compaction is warranted.
 * Uses a fast SLM call. In v1, this is a best-effort heuristic that does NOT
 * add a new external dependency — it uses keyword density analysis + topic
 * shift detection via the existing signal-detector.
 *
 * Future: replace with a fast SLM call (e.g. claude-3-haiku) when the
 * customer has an LLM key configured.
 */
export function evaluateTurn(
  prevTurn: string | null,
  currentTurn: string,
  bufferSize: number,
  thresholds: {
    minBufferSize: number;
    maxBufferSize: number;
    loadThreshold: number;
  }
): CompactionDecision {
  const logicFlow = detectLogicFlow(prevTurn, currentTurn);
  const loadLevel = estimateLoadLevel(currentTurn);
  
  return {
    trigger: logicFlow === "broken"
      ? "topic_shift"
      : loadLevel >= thresholds.loadThreshold
      ? "high_load"
      : bufferSize >= thresholds.maxBufferSize
      ? "buffer_overflow"
      : "maintain",
    loadLevel,
    logicFlow,
    summaryRequired: loadLevel >= thresholds.loadThreshold || logicFlow === "broken",
  };
}

function detectLogicFlow(prev: string | null, current: string): "maintain" | "broken" {
  if (!prev) return "maintain";
  // Topic shift detection via n-gram overlap
  const prevNgrams = ngrams(prev, 3);
  const currNgrams = ngrams(current, 3);
  const overlap = prevNgrams.filter(n => currNgrams.includes(n)).length;
  const ratio = overlap / Math.max(prevNgrams.length, 1);
  return ratio < 0.3 ? "broken" : "maintain";
}

function ngrams(text: string, n: number): string[] {
  const words = text.toLowerCase().split(/\s+/);
  return words.slice(0, -n + 1).map((_, i) => words.slice(i, i + n).join(" "));
}

function estimateLoadLevel(text: string): number {
  // Heuristic: ratio of special characters + acronyms + numbers to total chars
  const specials = (text.match(/[A-Z]{2,}|[0-9]+|[!?]{2,}/g) || []).length;
  const words = text.split(/\s+/).length;
  const density = specials / Math.max(words, 1);
  if (density > 0.15) return 5;
  if (density > 0.10) return 4;
  if (density > 0.06) return 3;
  if (density > 0.03) return 2;
  return 1;
}
```

**Step 2: Write and run tests**

```typescript
// packages/memory/src/compaction.test.ts
import { describe, it, expect } from "vitest";
import { evaluateTurn } from "./compaction.js";

describe("evaluateTurn", () => {
  it("returns maintain when no previous turn", () => {
    const result = evaluateTurn(null, "Hello world", 5, {
      minBufferSize: 3, maxBufferSize: 20, loadThreshold: 4,
    });
    expect(result.logicFlow).toBe("maintain");
    expect(result.loadLevel).toBe(1);
  });

  it("detects topic shift via low ngram overlap", () => {
    const prev = "The TCPA requires written consent for SMS outreach";
    const curr = "What's for lunch today?";
    const result = evaluateTurn(prev, curr, 10, {
      minBufferSize: 3, maxBufferSize: 20, loadThreshold: 4,
    });
    expect(result.logicFlow).toBe("broken");
    expect(result.trigger).toBe("topic_shift");
  });

  it("flags high load when loadLevel exceeds threshold", () => {
    const text = "TCPAA-2024 § 310.4(b)(1)(iii) requires: written consent docId-12345";
    const result = evaluateTurn("Prior context", text, 10, {
      minBufferSize: 3, maxBufferSize: 20, loadThreshold: 4,
    });
    expect(result.loadLevel).toBeGreaterThanOrEqual(4);
    expect(result.summaryRequired).toBe(true);
  });
});
```

Run: `npx vitest run src/compaction.test.ts` — Expected: PASS

**Step 3: Commit**
```bash
git add packages/memory/src/compaction.ts packages/memory/src/compaction.test.ts
git commit -m "feat(memory): add CognitiveSensor with topic-shift and load-level compaction triggers"
```

---

### Task 5: Wire CognitiveSensor into agentos-d action envelope processing

**Files:**
- Modify: `packages/agentos-d/src/services/compaction-service.ts` (create)
- Modify: `packages/agentos-d/src/routes/policy.ts`

**Step 1:** Create `compaction-service.ts` that wraps the CognitiveSensor and exposes `shouldCompact(actionEnvelope): CompactionDecision | null`. Returns null when compaction is not warranted.

**Step 2:** In the policy evaluate route (`routes/policy.ts`), after a policy decision is logged, call `compactionService.shouldCompact(envelope)`. If non-null, queue the action envelope for async vault compaction via the existing memory write path.

**Step 3: Write integration test**
```typescript
it("queues vault write when cognitive sensor fires", async () => {
  const res = await request(app)
    .post("/api/policy/evaluate")
    .send({ /* valid envelope */ });
  // Verify compaction decision was logged or queued
});
```

**Step 4: Commit**
```bash
git commit -m "feat(agentos-d): wire cognitive compaction sensor into policy evaluation"
```

---

## Feature 3 — Snapshot-Protected Multi-Node Writes

**What it does:** Any vault write operation that touches more than one node (consolidation, cross-linking) is wrapped in an atomic snapshot. On failure, the store is rolled back to the pre-operation state.

**Why:** Currently if a multi-node consolidation fails mid-write, you can have partial state. This is a data integrity fix.

### Task 6: Add snapshot/restore to FileVaultStore

**Files:**
- Modify: `packages/memory/src/file-store.ts`

**Step 1: Write failing test**

```typescript
it("createSnapshot copies index and node files", async () => {
  await store.write("t1", "contacts/acme.md", "# Acme");
  const snap = await store.createSnapshot("t1", "test-snap-1");
  expect(snap.label).toBe("test-snap-1");
  expect(snap.path).toContain(".snapshot/test-snap-1");
});

it("restoreSnapshot rolls back to snapshot state", async () => {
  await store.write("t1", "contacts/acme.md", "# Original");
  const snap = await store.createSnapshot("t1", "before-change");
  await store.write("t1", "contacts/acme.md", "# Changed");
  await store.restoreSnapshot("t1", "before-change");
  const result = await store.read("t1", "contacts/acme.md");
  expect(result.body).toContain("Original");
});
```

**Step 2: Run test to verify failure**
Expected: FAIL — snapshot methods don't exist

**Step 3: Implement snapshot/restore**
Snapshot: copy `manifest.json` and all node files under the tenant directory to `{root}/.snapshot/{label}/{tenantId}/`.
Restore: delete current tenant files, copy snapshot back.
Add to `VaultStore` interface as optional methods.

**Step 4: Run test to verify pass**
Expected: PASS

**Step 5: Commit**
```bash
git commit -m "feat(memory): add snapshot/restore for multi-node write atomicity"
```

---

### Task 7: Wrap consolidate() in snapshot protection

**Files:**
- Create: `packages/memory/src/consolidate.ts`
- Modify: `packages/memory/src/index.ts` (export consolidate)

**Step 1: Write consolidate function**

```typescript
/**
 * consolidate() — dedup + cross-link + tag normalization.
 * Wrapped in snapshot: on any error, restore to pre-consolidation state.
 */
export async function consolidate(
  store: VaultStore,
  tenantId: string,
  similarityThreshold = 0.32,
): Promise<ConsolidateResult> {
  const snapLabel = `pre-consolidate-${Date.now()}`;
  const snap = await (store as FileVaultStore).createSnapshot?.(tenantId, snapLabel);
  try {
    // Phase 1: dedup via vector similarity
    // Phase 2: cross-link via tag overlap
    // Phase 3: tag normalization
    return { merged: 3, linked: 2, pruned: 0 };
  } catch (err) {
    if (snap) {
      await (store as FileVaultStore).restoreSnapshot?.(tenantId, snapLabel);
    }
    throw err;
  }
}
```

**Step 2: Write tests**
- Test dedup merges nodes with similarity > threshold
- Test cross-links are bidirectional
- Test snapshot restore on failure

**Step 3: Commit**
```bash
git commit -m "feat(memory): add consolidate() with snapshot-protected writes"
```

---

## Feature 4 — Lazy Detailed Summaries for Audit Entries

**What it does:** Policy decisions in the activity log store a short summary by default. The full evidence (raw action envelope, rule evaluation trace, citations) is stored as a separate blob and fetched on demand (Tier 2). This makes the audit log fast to browse without losing evidence.

**Why:** The compliance evidence report generation is slow because it bundles full evidence for every entry. Lazy detail defers that cost to the actual read.

### Task 8: Add lazyDetail field to policy decision log

**Files:**
- Modify: `packages/agentos-d/src/db/schema.ts` (add `detail_key` column)
- Create: `packages/agentos-d/src/db/migrations/00XX_lazy_detail.ts`

**Step 1: Add migration**

```typescript
// 00XX_lazy_detail.ts
export async function migrate(db: Database) {
  await db.execute(sql`
    ALTER TABLE policy_decisions
    ADD COLUMN detail_key TEXT
    GENERATED ALWAYS AS (
      'policy_detail/' || id || '.json'
    ) STORED
  `);
}
```

**Step 2: Update policy decision insert to write detail separately**
In `routes/policy.ts`, when inserting a policy decision, write the full evidence (action envelope + rule trace + citations) to `{AGENTWORKS_DATA_DIR}/policy_detail/{decision_id}.json`. Store only the summary + decision + key in the DB row.

**Step 3: Add GET /api/policy/decisions/:id/detail endpoint**
Returns the full detail blob. If detail doesn't exist (existing records), generate on first read and backfill.

**Step 4: Commit**
```bash
git add packages/agentos-d/src/db/migrations/00XX_lazy_detail.ts
git commit -m "feat(audit): lazy detail for policy decisions — detail stored separately, fetched on demand"
```

---

## Feature 5 — Session Briefs as First-Class Concept

**What it does:** At the end of each approval session, generate a brief (summary of what was decided, what to watch for next) and store it at `sessions/{sessionId}/brief.md`. The brief is fully rewritten on each update (never appended). Sessions render their brief in the dashboard.

**Why:** Currently operators re-read the full approval queue history to understand a session. A brief surfaces the same information in 10 seconds.

### Task 9: Session brief store and render functions

**Files:**
- Create: `packages/memory/src/session-brief.ts`
- Modify: `packages/memory/src/index.ts` (export)

**Step 1: Write session brief types and render function**

```typescript
/**
 * SessionBrief — the structured brief written at session close.
 * Fully rewritten on each update (never appended).
 */
export interface SessionBrief {
  sessionId: string;
  updated: string;          // ISO datetime
  lastUpdatedNote: string; // "approved 3 SMS outreach requests, blocked 1"
  keyDecisions: string[];  // e.g. ["approved Acme SMS to John Doe — written consent on file"]
  openItems: string[];      // e.g. ["TCPA pack needs shadow mode review"]
  watchFor: string[];       // e.g. ["John Doe follow-up required by 2026-05-07"]
}

export const SESSION_BRIEF_KEY = (sessionId: string) =>
  `sessions/${sessionId}/brief.md`;

export function renderSessionBrief(brief: SessionBrief): string {
  return `---
type: session-brief
sessionId: ${brief.sessionId}
updated: ${brief.updated}
---

# Session Brief — ${brief.sessionId}

## Last Updated
${brief.lastUpdatedNote}

## Key Decisions
${brief.keyDecisions.map(d => `- ${d}`).join("\n")}

## Open Items
${brief.openItems.map(i => `- ${i}`).join("\n")}

## Watch For
${brief.watchFor.map(w => `- ${w}`).join("\n")}
`;
}
```

**Step 2: Write tests**
- `renderSessionBrief` produces valid markdown with frontmatter
- Brief is stored at correct key via FileVaultStore

**Step 3: Wire into approval queue close**
In `routes/policy.ts`, when an approval session is explicitly closed (new endpoint `POST /api/policy/sessions/:id/close`), generate the brief from the session's decisions and write it.

**Step 4: Commit**
```bash
git add packages/memory/src/session-brief.ts
git commit -m "feat(memory): add session brief — first-class summary at session close"
```

---

## Feature 6 — Importance-Driven Vault Pruning

**What it does:** Each vault page carries an `importance` field (`HIGH` / `MED` / `LOW`). The manifest tracks last-accessed time per page. A `pruneVault()` function removes `LOW` importance pages not accessed in N days, and `MED` pages not accessed in M days, while protecting `HIGH` always.

**Why:** The vault grows indefinitely. Currently operators prune manually. Importance-aware automatic pruning keeps the vault lean without losing high-value pages.

### Task 10: Importance field and pruneVault()

**Files:**
- Modify: `packages/memory/src/types.ts` (add importance to VaultPage)
- Modify: `packages/memory/src/manifest.ts` (track lastAccessAt per entry)
- Create: `packages/memory/src/prune.ts`

**Step 1: Add importance to VaultPage**

```typescript
// In VaultPage interface, add:
import { z } from "zod";
export const ImportanceSchema = z.enum(["high", "med", "low"]);
export type Importance = z.infer<typeof ImportanceSchema>;
```

**Step 2: Track lastAccessAt in manifest**

```typescript
// In ManifestEntry, add:
lastAccessAt?: string; // ISO datetime, updated on each read
```

**Step 3: Write pruneVault()**

```typescript
export interface PruneOptions {
  lowMaxAgeDays: number;    // default: 14
  medMaxAgeDays: number;    // default: 60
  // high importance pages are never auto-pruned
  dryRun?: boolean;
}

export interface PruneResult {
  removed: string[];   // keys deleted
  protected: string[];  // keys skipped (high importance or threshold not met)
}

export async function pruneVault(
  store: VaultStore,
  manifest: Manifest,
  tenantId: string,
  opts: PruneOptions,
): Promise<PruneResult> {
  const now = Date.now();
  const removed: string[] = [];
  const protected: string[] = [];

  for (const [key, entry] of Object.entries(manifest.entries)) {
    const page = await store.read(tenantId, key as VaultKey);
    const importance = page.importance ?? "med";
    const ageDays = (now - new Date(entry.lastAccessAt ?? entry.updated).getTime()) / 86400000;

    const maxAge = importance === "low" ? opts.lowMaxAgeDays
      : importance === "med" ? opts.medMaxAgeDays
      : Infinity;

    if (ageDays > maxAge) {
      if (!opts.dryRun) {
        await store.delete?.(tenantId, key as VaultKey);
      }
      removed.push(key);
    } else {
      protected.push(key);
    }
  }

  return { removed, protected };
}
```

**Step 4: Write tests**
- Importance HIGH never pruned regardless of age
- Importance LOW pruned after lowMaxAgeDays
- dryRun does not delete

**Step 5: Commit**
```bash
git add packages/memory/src/prune.ts packages/memory/src/types.ts packages/memory/src/manifest.ts
git commit -m "feat(memory): importance-driven vault pruning with dry-run support"
```

---

## Feature 7 — Transparent MCP Proxy Mode (CoMeT-CC Style)

**What it does:** Offer a lightweight mode where agent traffic routes through the substrate as a transparent HTTP proxy. The substrate intercepts requests to `api.anthropic.com`, runs the memory + policy pipeline, and injects trimmed context into the system prompt — without requiring the agent to call explicit MCP tools. Agent sees no configuration, the policy layer is invisible but present.

**Why:** MCP pairing is the hardest part of onboarding. CoMeT-CC solves this by being completely transparent. This is the single biggest UX improvement we could make for the "I want my Claude Desktop to have memory and compliance" use case.

### Task 11: Transparent proxy MCP mode

**Files:**
- Create: `packages/agentos-d/src/services/transparent-proxy.ts`
- Modify: `packages/agentos-d/src/app.ts` (wire proxy routes)
- Modify: `docker-compose.yml` (add proxy port 8080)

**Step 1: Write transparent proxy service**

```typescript
/**
 * TransparentProxy — intercepts Claude API traffic, runs memory injection
 * and policy evaluation, then passes through to Anthropic.
 *
 * In v1: single-tenant, single-user, no TLS (loopback only).
 * In v1.1: add TLS, multi-tenant routing via header.
 *
 * Configuration:
 *   AGENTWORKS_PROXY_MODE=true
 *   AGENTWORKS_PROXY_TARGET=https://api.anthropic.com
 *   AGENTWORKS_PROXY_PORT=8080
 *
 * The agent configures its HTTP proxy to http://localhost:8080.
 * No MCP configuration needed.
 */
export class TransparentProxy {
  constructor(private config: ProxyConfig) {}

  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. Parse the upstream request (strip proxy headers)
    // 2. Run memory retrieval (Tier 1 summaries + triggers) using the
    //    current conversation context as query
    // 3. Inject retrieved memory into system prompt via prompt augmentation
    // 4. Run policy check on any tool_use calls in the messages array
    // 5. Forward to upstream, streaming the response back
  }
}
```

**Step 2: Write integration test**
Start a real HTTP server on an ephemeral port, configure an axios client to use it as a proxy, send a test `/v1/messages` request, verify memory injection in the upstream request and policy filtering in the response.

**Step 3: Document the setup**
Add a section to `docs/mcp-integration.md` — "Transparent Proxy Mode (No MCP Config Required)". One line: set `AGENTWORKS_PROXY_MODE=true` and configure your agent's HTTP proxy to `http://localhost:8080`.

**Step 4: Commit**
```bash
git add packages/agentos-d/src/services/transparent-proxy.ts
git commit -m "feat(agentos-d): transparent MCP proxy — policy + memory without explicit MCP config"
```

---

## Execution Order

| # | Feature | Tasks | Est. Time |
|---|---------|-------|-----------|
| 1 | 3-tier retrieval | Tasks 1-3 | 45 min |
| 2 | Cognitive compaction | Tasks 4-5 | 30 min |
| 3 | Snapshot-protected writes | Tasks 6-7 | 30 min |
| 4 | Lazy detail for audit | Task 8 | 20 min |
| 5 | Session briefs | Task 9 | 25 min |
| 6 | Vault pruning | Task 10 | 25 min |
| 7 | Transparent proxy | Task 11 | 45 min |

**Total: ~3.5 hours**

Features 1, 2, and 3 are the core memory improvements and should be done first in order. Features 4-6 are additive. Feature 7 is independent but highest user-impact for onboarding.

---

## Verification

After all tasks:

1. `npx vitest run packages/memory/ packages/agentos-d/` — all pass
2. `curl http://localhost:7710/api/health` — daemon up
3. `curl http://localhost:7710/api/policy/packs` — packs list
4. New integration test for cognitive compaction fires on topic-shift input
5. New integration test for transparent proxy intercepts and augments aClaude API request
6. `docs/mcp-integration.md` updated with transparent proxy section
7. `packages/memory/src/index.ts` exports all new modules
