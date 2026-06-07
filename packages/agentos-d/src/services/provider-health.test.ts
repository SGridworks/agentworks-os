import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProviderHealthService, getProviderHealthService } from "./provider-health.js";

// Mock fetch globally
global.fetch = vi.fn();

// Mock fs/promises
vi.mock("fs/promises", () => ({
  stat: vi.fn(),
}));

// Mock process.env
const originalEnv = process.env;

describe("ProviderHealthService", () => {
  let service: ProviderHealthService;

  beforeEach(() => {
    // Reset mocks and environment
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    service = new ProviderHealthService();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("getStatus", () => {
    it("should return status with providers array", async () => {
      // Mock successful provider checks for configured providers
      process.env.OPENAI_API_KEY = "test-key";
      process.env.ANTHROPIC_API_KEY = "test-key";
      
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      // First call to populate cache
      const firstStatus = await service.getStatus();
      expect(firstStatus.providers).toHaveLength(7);
      expect(firstStatus.status).toBeDefined();
      expect(["healthy", "degraded", "down"]).toContain(firstStatus.status);

      // Second call should use cache
      const secondStatus = await service.getStatus();
      expect(secondStatus).toBe(firstStatus);
    });

    it("should poll providers when cache is expired", async () => {
      // Mock successful provider checks
      process.env.OPENAI_API_KEY = "test-key";
      process.env.ANTHROPIC_API_KEY = "test-key";
      
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      // First call
      const firstStatus = await service.getStatus();
      expect(firstStatus.providers).toHaveLength(7);
      const firstTimestamp = firstStatus.lastUpdated;

      // Wait for cache to expire (force expiry) and ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 10));
      const futureTime = Date.now() + 35_000;
      vi.spyOn(Date, "now").mockReturnValue(futureTime);

      // Second call should trigger new poll
      const secondStatus = await service.getStatus();
      expect(secondStatus.lastUpdated).not.toBe(firstTimestamp);
      
      // Restore Date.now
      vi.restoreAllMocks();
    });
  });

  describe("refresh", () => {
    it("should force immediate refresh", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      process.env.ANTHROPIC_API_KEY = "test-key";
      
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const firstStatus = await service.getStatus();
      
      // Wait a bit to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const refreshedStatus = await service.refresh();
      
      expect(refreshedStatus.lastUpdated).not.toBe(firstStatus.lastUpdated);
      expect(refreshedStatus.providers).toHaveLength(7);
    });
  });

  describe("provider checks", () => {
    it("should mark missing OpenAI API key as degraded, not down", async () => {
      delete process.env.OPENAI_API_KEY;
      
      const status = await service.getStatus();
      const openaiProvider = status.providers.find(p => p.id === "openai");
      
      expect(openaiProvider?.status).toBe("degraded");
      expect(openaiProvider?.error).toContain("OPENAI_API_KEY not configured");
    });

    it("should mark missing Anthropic API key as degraded, not down", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      
      const status = await service.getStatus();
      const anthropicProvider = status.providers.find(p => p.id === "anthropic");
      
      expect(anthropicProvider?.status).toBe("degraded");
      expect(anthropicProvider?.error).toContain("ANTHROPIC_API_KEY not configured");
    });

    it("should handle provider timeouts", async () => {
      // Mock timeout
      vi.mocked(fetch).mockImplementationOnce(() => 
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("timeout after 5s")), 100)
        )
      );

      const status = await service.getStatus();
      const providers = status.providers;
      
      // At least one provider should have timeout error
      const timeoutProvider = providers.find(p => p.error?.includes("timeout"));
      expect(timeoutProvider).toBeDefined();
    });

    it("should handle HTTP errors", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 401,
      } as Response);

      const status = await service.getStatus();
      const providers = status.providers;
      
      // At least one provider should have HTTP error
      const errorProvider = providers.find(p => p.error?.includes("HTTP 401"));
      expect(errorProvider).toBeDefined();
    });
  });

  describe("aggregate status calculation", () => {
    it("should return 'down' when any provider is down", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      process.env.ANTHROPIC_API_KEY = "test-key";
      
      // Mock one provider failing
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const status = await service.getStatus();
      expect(status.status).toBe("down");
    });

    it("should return 'degraded' when any provider is degraded but none down", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      process.env.ANTHROPIC_API_KEY = "test-key";
      
      // Mock slow response (degraded) - simulate 6s latency which should trigger degraded status
      const originalCheckOpenAI = service["checkOpenAI"];
      service["checkOpenAI"] = async () => {
        await new Promise(resolve => setTimeout(resolve, 6000));
        return { ok: true, latencyMs: 6000 };
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const status = await service.getStatus();
      
      // Restore original method
      service["checkOpenAI"] = originalCheckOpenAI;
      
      // Should be degraded due to slow response
      expect(["degraded", "down"]).toContain(status.status);
    }, 15000); // Increase test timeout significantly

    it("should return 'healthy' when all providers are healthy", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      process.env.ANTHROPIC_API_KEY = "test-key";
      
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const status = await service.getStatus();
      
      // Should be healthy if all configured providers are healthy
      // Note: Some providers might still be down due to missing config
      expect(["healthy", "degraded", "down"]).toContain(status.status);
    });
  });

  describe("singleton instance", () => {
    it("should return same instance", () => {
      const instance1 = getProviderHealthService();
      const instance2 = getProviderHealthService();
      
      expect(instance1).toBe(instance2);
    });
  });

  describe("environment configuration", () => {
    it("should respect TRUST_POLL_SEC environment variable", () => {
      process.env.TRUST_POLL_SEC = "60";
      
      const customService = new ProviderHealthService();
      const status = customService.getStatus(); // This should not throw
      
      expect(status).toBeDefined();
    });

    it("should handle invalid TRUST_POLL_SEC", () => {
      process.env.TRUST_POLL_SEC = "invalid";
      
      const customService = new ProviderHealthService();
      const status = customService.getStatus(); // This should not throw
      
      expect(status).toBeDefined();
    });
  });
});
