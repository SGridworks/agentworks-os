/**
 * Tests for autopilot dispatch endpoint.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE_ROOT = resolve(__dirname, "../..");
const REPO_ROOT = resolve(__dirname, "../../../..");
const DAEMON_ENTRY = join(PACKAGE_ROOT, "dist", "cli.js");
const RULE_PACKS = join(REPO_ROOT, "rule-packs");

let daemon: ChildProcess;
let tmpRoot: string;
let baseUrl: string;
let tenantId: string;
let daemonStderr = "";

async function postJson(path: string, body: unknown): Promise<Response> {
  return await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson(path: string): Promise<Response> {
  return await fetch(`${baseUrl}${path}`);
}

async function deleteJson(path: string): Promise<Response> {
  return await fetch(`${baseUrl}${path}`, { method: "DELETE" });
}

async function evaluatePolicy(args: {
  tenantId: string;
  actor: { id: string; type: "human" | "agent" | "system"; label: string };
  proposedAction: { kind: string; summary: string };
  evidenceSnapshot: Record<string, unknown>;
  consent?: { source: "written" | "verbal" | "inferred" | "none" | "unknown"; verified?: boolean };
}): Promise<Record<string, unknown>> {
  const actionId = randomUUID();
  const res = await postJson("/api/policy/evaluate", {
    requestId: actionId,
    actionId,
    proposedAt: new Date().toISOString(),
    tenantId: args.tenantId,
    actor: args.actor,
    actionKind: args.proposedAction.kind,
    payload: {
      action_kind: args.proposedAction.kind,
      ...args.evidenceSnapshot,
    },
    context: { vaultRefs: [], conversationRefs: [], projectRefs: [], meta: {} },
    proposedAction: args.proposedAction,
    evidenceSnapshot: args.evidenceSnapshot,
    ...(args.consent ? { consent: args.consent } : {}),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (res.status !== 201) {
    throw new Error(`policy/evaluate failed: ${JSON.stringify({ status: res.status, body })}`);
  }
  return body;
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "awo-autopilot-test-"));
  const port = 17750 + Math.floor(Math.random() * 1000);
  baseUrl = `http://127.0.0.1:${port}`;
  daemon = spawn("node", [DAEMON_ENTRY], {
    env: {
      ...process.env,
      AGENTOS_PORT: String(port),
      AGENTOS_HOST: "127.0.0.1",
      AGENTOS_LOG_LEVEL: "warn",
      RULE_PACKS_DIR: RULE_PACKS,
      VAULT_ROOT: join(tmpRoot, "vault"),
      AGENTOS_DATA_DIR: join(tmpRoot, "data"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stderr?.on("data", (chunk) => {
    daemonStderr += String(chunk);
  });
  // Wait until /api/health responds OK
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Daemon at ${baseUrl} did not become healthy in 10s\n${daemonStderr}`);
}, 30_000);

afterAll(() => {
  daemon?.kill("SIGTERM");
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("autopilot dispatch endpoint", () => {
  it("creates a tenant for testing", async () => {
    const res = await postJson("/api/tenants", {
      name: "Autopilot Test Tenant",
      description: "Testing autopilot dispatch functionality",
      industry: "real_estate",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    tenantId = body.id;

    // Assign rule packs
    for (const packId of ["tcpa-real-estate", "fair-housing"]) {
      const r = await postJson(`/api/tenants/${tenantId}/rule-packs`, {
        packId,
        mode: "enforce",
      });
      expect(r.status).toBe(201);
    }

    // Tenant creation auto-assigns the smb-starter baseline (tenants.ts
    // DEFAULT_PACK_ID). That pack is unscoped (target_action_kinds: null) and
    // its pack-level missing_data_disposition routes ANY action lacking
    // contact/DNC/consent evidence to review — so with it subscribed, even a
    // benign memory.write returns route_to_review and autopilot can never find
    // a genuinely-allowed action to dispatch. Unassign it here so this suite
    // exercises the scoped tcpa/fair-housing behavior: non-targeted actions
    // (memory.write, file.read) are auto-allowed, outbound.sms is gated.
    const unassign = await deleteJson(
      `/api/tenants/${tenantId}/rule-packs/smb-starter`,
    );
    expect(unassign.status).toBe(204);
  });

  it("creates low-risk actions that should be auto-allowed", async () => {
    // Create a low-risk memory write action
    const result1 = await evaluatePolicy({
      tenantId,
      actor: { id: "agent-1", type: "agent", label: "TestAgent" },
      proposedAction: { kind: "memory.write", summary: "Write safe data" },
      evidenceSnapshot: {
        action_kind: "memory.write",
        data_classification: "public",
        contains_pii: false,
      },
    });

    expect(result1.decision).toBe("allow");

    // Create another low-risk action
    const result2 = await evaluatePolicy({
      tenantId,
      actor: { id: "agent-1", type: "agent", label: "TestAgent" },
      proposedAction: { kind: "file.read", summary: "Read config file" },
      evidenceSnapshot: {
        action_kind: "file.read",
        file_path: "/config/app.json",
        file_classification: "public",
      },
    });

    expect(result2.decision).toBe("allow");
  });

  it("creates medium-risk actions that need approval", async () => {
    // An outbound.sms is targeted by tcpa-real-estate. Without dnc_status in
    // the evidence, TCPA-RE-001's required-data check routes it to review
    // (missing data is not a passing grade) — a genuine "needs approval" case.
    const result = await evaluatePolicy({
      tenantId,
      actor: { id: "agent-1", type: "agent", label: "TestAgent" },
      proposedAction: { kind: "outbound.sms", summary: "Text a prospect" },
      evidenceSnapshot: {
        action_kind: "outbound.sms",
        message_body: "Hi from Acme Realty",
        contains_pii: false,
      },
      consent: { source: "written", verified: false },
    });

    expect(result.decision).toBe("route_to_review");
  });

  it("dispatches safe actions via autopilot", async () => {
    // Get the action IDs from the policy decisions we created
    const decisionsRes = await getJson(`/api/policy/decisions?tenantId=${tenantId}`);
    expect(decisionsRes.status).toBe(200);
    const decisions = (await decisionsRes.json()) as { items: Array<{ actionId: string; decision: string }> };

    const safeActionIds = decisions.items
      .filter(d => d.decision === "allow")
      .map(d => d.actionId)
      .slice(0, 2); // Take first 2 safe actions

    expect(safeActionIds.length).toBeGreaterThan(0);

    // Dispatch safe actions
    const dispatchRes = await postJson("/api/admin/autopilot/dispatch", {
      actionIds: safeActionIds,
      idempotencyKey: `test-dispatch-${Date.now()}`,
      dryRun: false,
    });

    expect(dispatchRes.status).toBe(200);
    const result = (await dispatchRes.json()) as {
      dispatched: number;
      skipped: number;
      failed: number;
      results: Array<{
        actionId: string;
        decision: string;
        riskScore: number;
        reasons: string[];
        dispatched: boolean;
      }>;
    };

    expect(result.dispatched).toBe(safeActionIds.length);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.results.length).toBe(safeActionIds.length);

    // All results should be auto-allowed
    result.results.forEach(r => {
      expect(r.decision).toBe("allow");
      expect(r.dispatched).toBe(true);
      expect(r.riskScore).toBeLessThanOrEqual(0.3);
    });
  });

  it("skips risky actions and only dispatches safe ones", async () => {
    // Get all action IDs
    const decisionsRes = await getJson(`/api/policy/decisions?tenantId=${tenantId}&decision=allow`);
    expect(decisionsRes.status).toBe(200);
    const decisions = (await decisionsRes.json()) as { items: Array<{ actionId: string; decision: string }> };

    const allActionIds = decisions.items.map(d => d.actionId);

    // Dispatch mixed actions
    const dispatchRes = await postJson("/api/admin/autopilot/dispatch", {
      actionIds: allActionIds,
      idempotencyKey: `test-mixed-${Date.now()}`,
      dryRun: false,
    });

    expect(dispatchRes.status).toBe(200);
    const result = (await dispatchRes.json()) as {
      dispatched: number;
      skipped: number;
      failed: number;
      results: Array<{
        actionId: string;
        decision: string;
        riskScore: number;
        reasons: string[];
        dispatched: boolean;
      }>;
    };

    // Should have some dispatched (safe) and some skipped (needs approval or risky)
    expect(result.dispatched + result.skipped).toBe(allActionIds.length);
    expect(result.failed).toBe(0);

    // Verify decisions are reasonable
    result.results.forEach(r => {
      if (r.decision === "allow") {
        expect(r.dispatched).toBe(true);
        expect(r.riskScore).toBeLessThanOrEqual(0.3);
      } else {
        expect(r.dispatched).toBe(false);
        expect(r.riskScore).toBeGreaterThan(0.3);
      }
    });
  });

  it("supports idempotency - same key returns same results", async () => {
    const decisionsRes = await getJson(`/api/policy/decisions?tenantId=${tenantId}&decision=allow`);
    expect(decisionsRes.status).toBe(200);
    const decisions = (await decisionsRes.json()) as { items: Array<{ actionId: string }> };

    const actionIds = decisions.items.slice(0, 2).map(d => d.actionId);
    const idempotencyKey = `test-idempotent-${Date.now()}`;

    // First dispatch
    const dispatch1Res = await postJson("/api/admin/autopilot/dispatch", {
      actionIds,
      idempotencyKey,
      dryRun: false,
    });
    expect(dispatch1Res.status).toBe(200);
    const result1 = await dispatch1Res.json();

    // Second dispatch with same key
    const dispatch2Res = await postJson("/api/admin/autopilot/dispatch", {
      actionIds,
      idempotencyKey,
      dryRun: false,
    });
    expect(dispatch2Res.status).toBe(200);
    const result2 = await dispatch2Res.json();

    // Results should be identical
    expect(result2.idempotent).toBe(true);
    expect(result2.dispatched).toBe(result1.dispatched);
    expect(result2.skipped).toBe(result1.skipped);
    expect(result2.failed).toBe(result1.failed);
  });

  it("supports dry run mode", async () => {
    const decisionsRes = await getJson(`/api/policy/decisions?tenantId=${tenantId}`);
    expect(decisionsRes.status).toBe(200);
    const decisions = (await decisionsRes.json()) as { items: Array<{ actionId: string }> };

    const actionIds = decisions.items.slice(0, 2).map(d => d.actionId);

    // Dry run dispatch
    const dispatchRes = await postJson("/api/admin/autopilot/dispatch", {
      actionIds,
      idempotencyKey: `test-dryrun-${Date.now()}`,
      dryRun: true,
    });

    expect(dispatchRes.status).toBe(200);
    const result = (await dispatchRes.json()) as {
      dispatched: number;
      skipped: number;
      failed: number;
      results: Array<{ dispatched: boolean }>;
    };

    // In dry run, should calculate but not actually dispatch
    expect(result.results.length).toBe(actionIds.length);
    expect(result.dispatched + result.skipped).toBe(actionIds.length);
    expect(result.failed).toBe(0);
  });

  it("rejects invalid requests", async () => {
    // Empty action IDs
    const res1 = await postJson("/api/admin/autopilot/dispatch", {
      actionIds: [],
      idempotencyKey: "test",
    });
    expect(res1.status).toBe(400);

    // Too many action IDs
    const res2 = await postJson("/api/admin/autopilot/dispatch", {
      actionIds: Array(51).fill("00000000-0000-0000-0000-000000000000"),
      idempotencyKey: "test",
    });
    expect(res2.status).toBe(400);

    // Missing idempotency key
    const res3 = await postJson("/api/admin/autopilot/dispatch", {
      actionIds: ["00000000-0000-0000-0000-000000000000"],
    });
    expect(res3.status).toBe(400);

    // Non-existent action IDs
    const res4 = await postJson("/api/admin/autopilot/dispatch", {
      actionIds: ["00000000-0000-0000-0000-000000000000"],
      idempotencyKey: "test-nonexistent",
    });
    expect(res4.status).toBe(404);
  });
});
