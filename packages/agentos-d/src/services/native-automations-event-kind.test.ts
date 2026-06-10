/**
 * native-automations-event-kind.test.ts
 *
 * Verifies that the four event-triggered templates wire event_kind through
 * installNativeAutomationTemplate so the event bus can match them.
 *
 * For each template: installs it, then reads the raw DB row to confirm
 * trigger_kind='event', the expected event_kind, and status='active'.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, resetDb, getSqlite } from "../db/index.js";
import { migrate } from "../db/migrations/index.js";
import { _resetVaultStoreForTesting } from "../routes/memory.js";
import { installNativeAutomationTemplate } from "./native-automations.js";
import type { Config } from "../config.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const COMPANY_ID = "00000000-0000-4000-8000-000000000002";

let root: string;

function makeConfig(dataDir: string): Config {
  return {
    host: "127.0.0.1",
    port: 7710,
    logLevel: "silent",
    awcpVersion: "awcp/v0.1",
    dataDir,
    scannerSidecarUrl: "http://127.0.0.1:3101",
    scannerPollIntervalMs: 30_000,
    auditLogRetentionDays: 30,
    companyId: "",
    standingIssueId: "standing",
    legacyBridgeUrl: "http://127.0.0.1:3100",
    legacyBridgeApiKey: "local-trusted",
    legacyBridgeEnabled: false,
    agentsRoot: "",
  } as unknown as Config;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "awos-event-kind-"));
  const config = makeConfig(join(root, "data"));
  process.env.VAULT_ROOT = join(root, "vault");
  _resetVaultStoreForTesting();
  initDb({ config: config as unknown as Parameters<typeof initDb>[0]["config"], migrations: migrate });
});

afterEach(() => {
  resetDb();
  _resetVaultStoreForTesting();
  delete process.env.VAULT_ROOT;
  rmSync(root, { recursive: true, force: true });
});

const CASES: Array<{ templateId: string; expectedEventKind: string }> = [
  { templateId: "failed-dispatch-recovery", expectedEventKind: "dispatch.failed" },
  { templateId: "provider-degradation-watch", expectedEventKind: "provider.degraded" },
  { templateId: "approval-sla-watchdog", expectedEventKind: "approval.sla_breach" },
  { templateId: "issue-stuck-escalator", expectedEventKind: "issue.stuck" },
];

describe("event-triggered template event_kind wiring", () => {
  for (const { templateId, expectedEventKind } of CASES) {
    it(`${templateId} → event_kind='${expectedEventKind}', trigger_kind='event', status='active'`, () => {
      const workflow = installNativeAutomationTemplate(templateId, {
        tenantId: TENANT_ID,
        companyId: COMPANY_ID,
      });

      expect(workflow.status).toBe("active");
      expect(workflow.trigger).toBe("event");

      const row = getSqlite()
        .prepare("SELECT trigger_kind, event_kind, status FROM native_automation_workflows WHERE id = ?")
        .get(workflow.id) as { trigger_kind: string; event_kind: string | null; status: string } | undefined;

      expect(row).toBeDefined();
      expect(row?.trigger_kind).toBe("event");
      expect(row?.event_kind).toBe(expectedEventKind);
      expect(row?.status).toBe("active");
    });
  }
});
