/**
 * Real-DB coverage for POST /api/policy/evaluate after it was converged onto the
 * rule-pack engine (Finding 3). Before convergence /evaluate was allow-by-default
 * and could never return `block`; these tests lock in that a DNC-listed contact
 * now blocks, using a controlled single-pack (smb-starter) subscription so the
 * matched pack is deterministic.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createApp } from "../app.js";
import { initDb, resetDb } from "../db/client.js";
import { migrate } from "../db/migrations/index.js";
import { assignPackToTenant } from "../rule-pack-assignments.js";

const REPO_RULE_PACKS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../rule-packs",
);

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    requestId: randomUUID(),
    proposedAt: new Date().toISOString(),
    actor: { id: "test-actor", type: "system", label: "Test" },
    actionKind: "outbound.sms",
    payload: {},
    context: { vaultRefs: [], conversationRefs: [], projectRefs: [], meta: {} },
    reviewed: false,
    proposedAction: { kind: "outbound.sms", summary: "test outreach" },
    shadowMode: false,
    ...overrides,
  };
}

describe("POST /api/policy/evaluate — real rule-pack engine", () => {
  let app: ReturnType<typeof createApp>;
  let dataDir: string;
  let tenantId: string;

  beforeAll(() => {
    process.env.RULE_PACKS_DIR = REPO_RULE_PACKS;
  });

  beforeEach(() => {
    resetDb();
    dataDir = mkdtempSync(join(tmpdir(), "awo-eval-engine-"));
    const config = {
      host: "127.0.0.1",
      port: 0,
      logLevel: "warn" as const,
      awcpVersion: "awcp/v0.1",
      dataDir,
      scannerSidecarUrl: "http://127.0.0.1:0",
      scannerPollIntervalMs: 30_000,
      auditLogRetentionDays: 30,
    };
    initDb({ config, migrations: migrate });
    app = createApp(config);
    tenantId = randomUUID();
    // Subscribe the tenant to exactly one pack so the matched pack is deterministic.
    assignPackToTenant(tenantId, "smb-starter", "enforce");
  });

  afterEach(() => {
    resetDb();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns block for a DNC-listed contact (unreachable via /evaluate before convergence)", async () => {
    const res = await request(app)
      .post("/api/policy/evaluate")
      .send(
        envelope({
          tenantId,
          evidenceSnapshot: { dnc_status: true, contact_id: "contact-1" },
        }),
      );
    expect(res.status).toBe(201);
    expect(res.body.decision).toBe("block");
    expect(res.body.rulePackId).toBe("smb-starter");
  });

  it("routes to review and enqueues an approval when required data is missing", async () => {
    const res = await request(app)
      .post("/api/policy/evaluate")
      .send(envelope({ tenantId, evidenceSnapshot: {} }));
    expect(res.status).toBe(201);
    expect(res.body.decision).toBe("route_to_review");
    expect(res.body.rulePackId).toBe("smb-starter");
    expect(res.body.approvalQueueId).toBeTruthy();
  });

  it("populates rulePackId from the real engine, not a hardcoded null", async () => {
    const res = await request(app)
      .post("/api/policy/evaluate")
      .send(
        envelope({
          tenantId,
          evidenceSnapshot: { dnc_status: true, contact_id: "contact-2" },
        }),
      );
    expect(res.status).toBe(201);
    expect(res.body.rulePackId).not.toBeNull();
  });
});
