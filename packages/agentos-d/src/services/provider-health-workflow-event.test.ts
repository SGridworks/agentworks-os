/**
 * Tests for provider.degraded edge-triggered workflow event in ProviderHealthService.
 *
 * Verifies that:
 * - healthy→degraded transition fires a workflow run for a subscribed tenant
 * - a second poll still degraded creates NO additional run (edge-trigger, not level-trigger)
 * - healthy→healthy creates no run
 * - down→degraded (already unhealthy) creates no run
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { initDb, resetDb, getSqlite } from "../db/index.js";
import { migrate } from "../db/migrations/index.js";
import { _resetVaultStoreForTesting } from "../routes/memory.js";
import { createNativeAutomationWorkflow } from "./native-automations.js";
import { ProviderHealthService } from "./provider-health.js";

// Suppress fs/promises in checks that might stat real paths.
vi.mock("fs/promises", () => ({
  stat: vi.fn().mockResolvedValue({}),
}));

const TENANT = "22222222-2222-2222-2222-222222222222";
const COMPANY = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

let root: string;
let config: Config;
let previousVaultRoot: string | undefined;

function makeConfig(dataDir: string): Config {
  return {
    companyId: COMPANY,
    logLevel: "silent",
    dataDir,
    legacyBridgeUrl: "http://127.0.0.1:3100",
    legacyBridgeApiKey: "test",
    legacyBridgeEnabled: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Config;
}

function createProviderDegradedWorkflow(tenantId: string, companyId: string) {
  return createNativeAutomationWorkflow({
    tenantId,
    companyId,
    name: "provider-degradation-watch",
    trigger: "event",
    eventKind: "provider.degraded",
    status: "active",
    definition: {
      trigger: "event",
      steps: [
        {
          id: "create-issue",
          name: "Create provider degradation issue",
          type: "issue.create",
          params: { title: "Provider degraded", description: "A provider transitioned to degraded." },
        },
      ],
    },
  });
}

function countRunsForWorkflow(workflowId: string): number {
  const row = getSqlite()
    .prepare("SELECT COUNT(*) AS c FROM native_automation_runs WHERE workflow_id = ?")
    .get(workflowId) as { c: number };
  return row.c;
}

/**
 * Build a ProviderHealthService whose providers list contains only a single
 * synthetic provider whose check function returns whatever we inject via
 * `statusRef.current`. This lets us control status between polls without
 * touching network or filesystem.
 */
function makeTestService(config: Config): {
  service: ProviderHealthService;
  setProviderStatus: (status: "healthy" | "degraded" | "down") => void;
} {
  let currentStatus: "healthy" | "degraded" | "down" = "healthy";

  const service = new ProviderHealthService();
  service.setConfig(config);

  // Replace the private providers array with a single synthetic provider.
  // Access via bracket notation to keep TypeScript happy with private fields.
  (service as unknown as { providers: unknown[] }).providers = [
    {
      id: "synthetic",
      displayName: "Synthetic Test Provider",
      category: "sidecar",
      check: async () => ({
        ok: currentStatus !== "down",
        status: currentStatus,
        latencyMs: 1,
        error: currentStatus !== "healthy" ? `synthetic ${currentStatus}` : undefined,
      }),
    },
  ];

  return {
    service,
    setProviderStatus: (s) => { currentStatus = s; },
  };
}

describe("provider.degraded edge-triggered workflow event", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), "awos-ph-wf-event-"));
    config = makeConfig(join(root, "data"));
    previousVaultRoot = process.env.VAULT_ROOT;
    process.env.VAULT_ROOT = join(root, "vault");
    _resetVaultStoreForTesting();
    initDb({ config: config as unknown as Parameters<typeof initDb>[0]["config"], migrations: migrate });
  });

  afterEach(() => {
    resetDb();
    _resetVaultStoreForTesting();
    if (previousVaultRoot === undefined) {
      delete process.env.VAULT_ROOT;
    } else {
      process.env.VAULT_ROOT = previousVaultRoot;
    }
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("healthy→degraded transition creates a workflow run for the subscribed tenant", async () => {
    const wf = createProviderDegradedWorkflow(TENANT, COMPANY);
    const { service, setProviderStatus } = makeTestService(config);

    // Poll 1: healthy — no run expected, establishes baseline in lastKnownStatus.
    setProviderStatus("healthy");
    await service.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    expect(countRunsForWorkflow(wf.id)).toBe(0);

    // Poll 2: degraded — transition fires the event.
    setProviderStatus("degraded");
    // Bypass cache expiry by using refresh().
    await service.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    expect(countRunsForWorkflow(wf.id)).toBe(1);
  });

  it("second consecutive degraded poll creates no additional run (edge-trigger, not level-trigger)", async () => {
    const wf = createProviderDegradedWorkflow(TENANT, COMPANY);
    const { service, setProviderStatus } = makeTestService(config);

    setProviderStatus("healthy");
    await service.refresh();
    await new Promise((resolve) => setImmediate(resolve));

    setProviderStatus("degraded");
    await service.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    expect(countRunsForWorkflow(wf.id)).toBe(1);

    // Poll 3: still degraded — no new run.
    await service.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    expect(countRunsForWorkflow(wf.id)).toBe(1);
  });

  it("healthy→healthy creates no run", async () => {
    const wf = createProviderDegradedWorkflow(TENANT, COMPANY);
    const { service, setProviderStatus } = makeTestService(config);

    setProviderStatus("healthy");
    await service.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    await service.refresh();
    await new Promise((resolve) => setImmediate(resolve));

    expect(countRunsForWorkflow(wf.id)).toBe(0);
  });

  it("healthy→down transition also fires the event", async () => {
    const wf = createProviderDegradedWorkflow(TENANT, COMPANY);
    const { service, setProviderStatus } = makeTestService(config);

    setProviderStatus("healthy");
    await service.refresh();
    await new Promise((resolve) => setImmediate(resolve));

    setProviderStatus("down");
    await service.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    expect(countRunsForWorkflow(wf.id)).toBe(1);
  });

  it("already-degraded→degraded (no prior healthy) creates no run on first poll", async () => {
    const wf = createProviderDegradedWorkflow(TENANT, COMPANY);
    const { service, setProviderStatus } = makeTestService(config);

    // First poll is degraded — no prior status in map, so no transition from healthy.
    setProviderStatus("degraded");
    await service.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    expect(countRunsForWorkflow(wf.id)).toBe(0);
  });

  it("creates no run when no provider-degradation-watch workflow exists", async () => {
    const { service, setProviderStatus } = makeTestService(config);

    setProviderStatus("healthy");
    await service.refresh();
    await new Promise((resolve) => setImmediate(resolve));

    setProviderStatus("degraded");
    await service.refresh();
    await new Promise((resolve) => setImmediate(resolve));

    const total = (
      getSqlite()
        .prepare("SELECT COUNT(*) AS c FROM native_automation_runs")
        .get() as { c: number }
    ).c;
    expect(total).toBe(0);
  });
});
