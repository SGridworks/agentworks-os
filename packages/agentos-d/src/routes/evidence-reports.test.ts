/**
 * Evidence-reports route tests.
 *
 * These tests verify:
 *   - POST /api/evidence-reports/generate validates input and calls the service
 *   - GET  /api/evidence-reports lists reports with pagination
 *   - GET  /api/evidence-reports/:id/verify checks the HMAC signature trailer
 *   - Errors are returned as { error, message } JSON
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createEvidenceReportsRouter,
} from "./evidence-reports.js";
import type { Config } from "../config.js";
import { initDb, resetDb, getDb as getRealDb } from "../db/client.js";
import { migrate } from "../db/migrations/index.js";
import { evidenceReports } from "../db/schema.js";

// ---------------------------------------------------------------------------
// Mock DB — uses a self-returning proxy so any drizzle chain method works.
// Required because generateEvidenceReport calls aggregateEvidenceReportData
// which calls getDb() to query policy_decisions and scanner_findings.
//
// The GET /verify describe block below points `activeDb` at a real (SQLite-
// backed) database so it can exercise actual persisted + signed reports;
// every other describe block leaves activeDb on this fake proxy.
// ---------------------------------------------------------------------------

function makeDbMock() {
  const target = {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "all") return () => [];
      if (prop === "get") return () => null;
      if (prop === "run") return () => {};
      const fn = vi.fn();
      // Return fn so .method().method() chaining works
      return fn.mockReturnThis();
    },
  });
}

const mockDb = makeDbMock();
let activeDb: unknown = mockDb;

vi.mock("../db/index.js", () => ({
  getDb: () => activeDb,
}));

// ---------------------------------------------------------------------------
// Fake PdfEngine
// ---------------------------------------------------------------------------

import type { PdfRenderResult } from "@agentworks/pdf";

const FAKE_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00]); // %PDF\0

function makeFakeEngine() {
  return {
    name: "FakePdfEngine",
    render: vi.fn((): Promise<PdfRenderResult> =>
      Promise.resolve({
        bytes: FAKE_BYTES,
        byteLength: FAKE_BYTES.byteLength,
        contentType: "application/pdf",
        generatedAt: new Date().toISOString(),
      }),
    ),
    shutdown: vi.fn(() => Promise.resolve()),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(config: Config) {
  const router = createEvidenceReportsRouter(config);
  const app = express();
  app.use(express.json());
  app.use("/api/evidence-reports", router);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/evidence-reports/generate", () => {
  it("returns 400 when tenantId is missing", async () => {
    const app = makeApp({} as Config);
    const res = await request(app)
      .post("/api/evidence-reports/generate")
      .send({ periodStart: "2026-01-01T00:00:00Z", periodEnd: "2026-01-31T00:00:00Z" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("returns 400 when periodStart >= periodEnd", async () => {
    const app = makeApp({} as Config);
    const res = await request(app)
      .post("/api/evidence-reports/generate")
      .send({
        tenantId: "00000000-0000-0000-0000-000000000001",
        periodStart: "2026-01-31T00:00:00Z",
        periodEnd: "2026-01-01T00:00:00Z",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_period");
  });

  it("returns 500 when PdfEngine is not configured", async () => {
    const app = makeApp({} as Config);
    const res = await request(app)
      .post("/api/evidence-reports/generate")
      .send({
        tenantId: "00000000-0000-0000-0000-000000000001",
        periodStart: "2026-01-01T00:00:00Z",
        periodEnd: "2026-01-31T00:00:00Z",
      });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("pdf_engine_unavailable");
  });

  it("returns the signed PDF result when PdfEngine is configured", async () => {
    // Isolated tmpdir dataDir: without this, evidenceReportKeyDir(config.dataDir
    // ?? "./data") falls back to a cwd-relative path and signs a real key into
    // the repo (packages/agentos-d/data/keys/evidence-report.key).
    const dataDir = mkdtempSync(join(tmpdir(), "awo-evid-route-"));
    try {
      const fakeEngine = makeFakeEngine();
      const app = makeApp({ pdfEngine: fakeEngine, dataDir } as Config);
      const res = await request(app)
        .post("/api/evidence-reports/generate")
        .send({
          tenantId: "00000000-0000-0000-0000-000000000001",
          periodStart: "2026-01-01T00:00:00Z",
          periodEnd: "2026-01-31T00:00:00Z",
        });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("pdfBase64");
      expect(res.body).toHaveProperty("pdfHash");
      expect(res.body).toHaveProperty("hmac");
      expect(res.body).toHaveProperty("signedAt");
      expect(res.body.status).toBe("complete");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("GET /api/evidence-reports", () => {
  it("returns 400 when tenantId is missing", async () => {
    const app = makeApp({} as Config);
    const res = await request(app).get("/api/evidence-reports");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("returns 400 for non-UUID tenantId", async () => {
    const app = makeApp({} as Config);
    const res = await request(app)
      .get("/api/evidence-reports")
      .query({ tenantId: "not-a-uuid" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/evidence-reports/:id/verify", () => {
  const TENANT_ID = "33333333-3333-3333-3333-333333333333";
  let dataDir: string;
  let config: Config;

  function testConfig(dir: string): Config {
    return {
      host: "127.0.0.1",
      port: 0,
      logLevel: "warn",
      awcpVersion: "awcp/v0.1",
      dataDir: dir,
      scannerSidecarUrl: "http://127.0.0.1:0",
      scannerPollIntervalMs: 30_000,
      auditLogRetentionDays: 30,
      pdfEngine: makeFakeEngine(),
    } as unknown as Config;
  }

  async function generateReport(app: express.Express) {
    const res = await request(app)
      .post("/api/evidence-reports/generate")
      .send({
        tenantId: TENANT_ID,
        periodStart: "2026-01-01T00:00:00Z",
        periodEnd: "2026-01-31T00:00:00Z",
      });
    expect(res.status).toBe(200);
    return res.body as { id: string; keyId?: string; signedAt: string; pdfHash: string };
  }

  beforeEach(() => {
    resetDb();
    dataDir = mkdtempSync(join(tmpdir(), "awo-evid-verify-"));
    config = testConfig(dataDir);
    initDb({ config, migrations: migrate });
    // Point the mocked getDb() at the real, migrated SQLite instance so
    // generate + verify persist and read an actual row.
    activeDb = getRealDb();
  });

  afterEach(() => {
    activeDb = mockDb;
    resetDb();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns valid:true for a freshly generated + signed report", async () => {
    const app = makeApp(config);
    const generated = await generateReport(app);

    const res = await request(app).get(`/api/evidence-reports/${generated.id}/verify`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      valid: true,
      keyId: expect.any(String),
      signedAt: generated.signedAt,
      pdfHash: generated.pdfHash,
    });
  });

  it("returns 404 for an unknown report id", async () => {
    const app = makeApp(config);
    const res = await request(app).get(`/api/evidence-reports/${randomUUID()}/verify`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns valid:false when the stored PDF has been tampered with", async () => {
    const app = makeApp(config);
    const generated = await generateReport(app);

    const db = getRealDb();
    const row = db
      .select({ pdfBase64: evidenceReports.pdfBase64 })
      .from(evidenceReports)
      .where(eq(evidenceReports.id, generated.id))
      .get() as { pdfBase64: string | null } | undefined;
    const tampered = Buffer.from(row?.pdfBase64 ?? "", "base64");
    // Flip a content byte that precedes the signature trailer so the
    // recomputed hash no longer matches what was signed.
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    db.update(evidenceReports)
      .set({ pdfBase64: tampered.toString("base64") })
      .where(eq(evidenceReports.id, generated.id))
      .run();

    const res = await request(app).get(`/api/evidence-reports/${generated.id}/verify`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.reason).toMatch(/hash mismatch/i);
  });
});
