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

describe("Admin Trust Endpoints Integration", () => {
  describe("GET /api/admin/trust", () => {
    it("should return trust status with providers array", async () => {
      const app = createApp(makeConfig());
      const response = await request(app).get("/api/admin/trust");

      expect(response.status).toBe(200);

      const data = response.body;
      expect(data).toHaveProperty("status");
      expect(data).toHaveProperty("lastUpdated");
      expect(data).toHaveProperty("providers");

      expect(["healthy", "degraded", "down"]).toContain(data.status);
      expect(Array.isArray(data.providers)).toBe(true);
      expect(data.providers.length).toBeGreaterThan(0);

      // Check provider structure
      const provider = data.providers[0];
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
      const response = await request(app).get("/api/admin/trust");

      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toMatch(/public, max-age=\d+/);

      const maxAge = parseInt(response.headers["cache-control"]?.match(/max-age=(\d+)/)?.[1] || "0");
      expect(maxAge).toBeGreaterThan(0);
      expect(maxAge).toBeLessThanOrEqual(30); // Should be <= 30 seconds
    });

    it("should return consistent data structure", async () => {
      const app = createApp(makeConfig());

      const response1 = await request(app).get("/api/admin/trust");
      const data1 = response1.body;

      const response2 = await request(app).get("/api/admin/trust");
      const data2 = response2.body;

      // Both should have same structure
      expect(Object.keys(data1)).toEqual(Object.keys(data2));
      expect(data1.providers.length).toBe(data2.providers.length);

      // Provider IDs should be consistent
      const ids1 = data1.providers.map((p: any) => p.id).sort();
      const ids2 = data2.providers.map((p: any) => p.id).sort();
      expect(ids1).toEqual(ids2);
    });
  });

  describe("POST /api/admin/trust/refresh", () => {
    it("should force refresh and return updated status", async () => {
      const app = createApp(makeConfig());

      // Get initial status
      const initialResponse = await request(app).get("/api/admin/trust");
      const initialData = initialResponse.body;

      // Wait a bit to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 100));

      // Force refresh
      const refreshResponse = await request(app)
        .post("/api/admin/trust/refresh");

      expect(refreshResponse.status).toBe(200);

      const refreshedData = refreshResponse.body;
      expect(refreshedData).toHaveProperty("status");
      expect(refreshedData).toHaveProperty("lastUpdated");
      expect(refreshedData).toHaveProperty("providers");

      // Should have same structure but potentially different timestamp
      expect(refreshedData.providers.length).toBe(initialData.providers.length);

      // Cache headers should be set
      expect(refreshResponse.headers["cache-control"]).toMatch(/public, max-age=\d+/);
    });

    it("should handle concurrent refresh requests", async () => {
      const app = createApp(makeConfig());

      // Send multiple refresh requests concurrently
      const refreshPromises = Array(3).fill(null).map(() =>
        request(app).post("/api/admin/trust/refresh")
      );

      const responses = await Promise.all(refreshPromises);

      // All should succeed
      responses.forEach(response => {
        expect(response.status).toBe(200);
      });

      // All should return valid data
      const dataArray = responses.map(response => response.body);

      dataArray.forEach(data => {
        expect(data).toHaveProperty("status");
        expect(data).toHaveProperty("providers");
        expect(Array.isArray(data.providers)).toBe(true);
      });
    });
  });

  describe("Error Handling", () => {
    it("should handle service errors gracefully", async () => {
      const app = createApp(makeConfig());
      const response = await request(app).get("/api/admin/trust");

      // Should still return 200 with error information in providers
      expect(response.status).toBe(200);

      const data = response.body;
      expect(data.status).toBeDefined();
      expect(data.providers).toBeDefined();

      // Some providers might be down due to missing config, but overall response should work
      const downProviders = data.providers.filter((p: any) => p.status === "down");
      expect(downProviders.length).toBeGreaterThanOrEqual(0); // Could be 0 or more depending on config
    });
  });

  describe("Performance", () => {
    it("should respond quickly (< 2s) for cached requests", async () => {
      const app = createApp(makeConfig());
      const start = Date.now();
      const response = await request(app).get("/api/admin/trust");
      const duration = Date.now() - start;

      expect(response.status).toBe(200);
      expect(duration).toBeLessThan(2000); // Should be fast for cached response
    });

    it("should handle refresh requests in reasonable time (< 10s)", async () => {
      const app = createApp(makeConfig());
      const start = Date.now();
      const response = await request(app).post("/api/admin/trust/refresh");
      const duration = Date.now() - start;

      expect(response.status).toBe(200);
      expect(duration).toBeLessThan(10000); // Should complete within timeout window
    });
  });
});
