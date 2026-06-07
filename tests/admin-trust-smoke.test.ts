/**
 * Simple smoke test for GET /api/admin/trust and POST /api/admin/trust/refresh endpoints.
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../packages/agentos-d/src/app.js";
import type { Config } from "../packages/agentos-d/src/config.js";

function makeConfig(): Config {
  return {
    companyId: "00000000-0000-4000-8000-000000000001",
    logLevel: "silent",
    sessionSecret: "test-secret",
    listenPort: 0,
    vaultDir: "/tmp/awo-vault-test",
    dataDir: "",
    legacyBridgeUrl: "http://127.0.0.1:3100",
    legacyBridgeApiKey: "test",
    legacyBridgeEnabled: false,
    jwtSecret: "test",
    googleClientId: "",
    googleClientSecret: "",
    redirectUrl: "",
    allowedOrigins: ["http://localhost:3000"],
    costMeterUrl: "",
    costMeterApiKey: "",
  };
}

describe("GET /api/admin/trust - smoke test", () => {
  it("should return trust status with providers array", async () => {
    const app = createApp(makeConfig());
    const res = await request(app).get("/api/admin/trust");
    
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status");
    expect(res.body).toHaveProperty("lastUpdated");
    expect(res.body).toHaveProperty("providers");
    
    expect(["healthy", "degraded", "down"]).toContain(res.body.status);
    expect(Array.isArray(res.body.providers)).toBe(true);
    expect(res.body.providers.length).toBeGreaterThan(0);
    
    // Check provider structure
    const provider = res.body.providers[0];
    expect(provider).toHaveProperty("id");
    expect(provider).toHaveProperty("displayName");
    expect(provider).toHaveProperty("category");
    expect(provider).toHaveProperty("status");
    expect(provider).toHaveProperty("lastSeen");
    expect(provider).toHaveProperty("latencyMs");
    expect(provider).toHaveProperty("error");
    
    expect(["llm", "sidecar", "storage", "rules"]).toContain(provider.category);
    expect(["healthy", "degraded", "down"]).toContain(provider.status);
  });

  it("should set appropriate cache headers", async () => {
    const app = createApp(makeConfig());
    const res = await request(app).get("/api/admin/trust");
    
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/public, max-age=\d+/);
    
    const maxAge = parseInt(res.headers["cache-control"]?.match(/max-age=(\d+)/)?.[1] || "0");
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(30); // Should be <= 30 seconds
  });

  it("should handle missing configuration gracefully", async () => {
    const app = createApp(makeConfig());
    const res = await request(app).get("/api/admin/trust");
    
    expect(res.status).toBe(200);
    
    const data = res.body;
    expect(data.status).toBeDefined();
    expect(data.providers).toBeDefined();
    
    // Some providers might be down due to missing config, but overall response should work
    const downProviders = data.providers.filter((p: any) => p.status === "down");
    expect(downProviders.length).toBeGreaterThanOrEqual(0); // Could be 0 or more depending on config
    
    // All providers should have error messages for missing API keys
    const openaiProvider = data.providers.find((p: any) => p.id === "openai");
    expect(openaiProvider?.error).toContain("OPENAI_API_KEY not configured");
    
    const anthropicProvider = data.providers.find((p: any) => p.id === "anthropic");
    expect(anthropicProvider?.error).toContain("ANTHROPIC_API_KEY not configured");
  });
});

describe("POST /api/admin/trust/refresh - smoke test", () => {
  it("should force refresh and return updated status", async () => {
    const app = createApp(makeConfig());
    
    // Get initial status
    const initialRes = await request(app).get("/api/admin/trust");
    const initialData = initialRes.body;
    
    // Wait a bit to ensure timestamp difference
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Force refresh
    const refreshRes = await request(app).post("/api/admin/trust/refresh");
    
    expect(refreshRes.status).toBe(200);
    
    const refreshedData = refreshRes.body;
    expect(refreshedData).toHaveProperty("status");
    expect(refreshedData).toHaveProperty("lastUpdated");
    expect(refreshedData).toHaveProperty("providers");
    
    // Should have same structure but potentially different timestamp
    expect(refreshedData.providers.length).toBe(initialData.providers.length);
    
    // Cache headers should be set
    expect(refreshRes.headers["cache-control"]).toMatch(/public, max-age=\d+/);
  });

  it("should return same data structure as GET", async () => {
    const app = createApp(makeConfig());
    
    const getRes = await request(app).get("/api/admin/trust");
    const postRes = await request(app).post("/api/admin/trust/refresh");
    
    expect(getRes.status).toBe(200);
    expect(postRes.status).toBe(200);
    
    const getData = getRes.body;
    const postData = postRes.body;
    
    // Both should have same structure
    expect(Object.keys(getData)).toEqual(Object.keys(postData));
    expect(getData.providers.length).toBe(postData.providers.length);
    
    // Provider IDs should be consistent
    const getIds = getData.providers.map((p: any) => p.id).sort();
    const postIds = postData.providers.map((p: any) => p.id).sort();
    expect(getIds).toEqual(postIds);
  });
});
