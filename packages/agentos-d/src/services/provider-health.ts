import { stat } from "fs/promises";
import { join } from "path";
import { env } from "node:process";
import { randomUUID } from "crypto";
import pino from "pino";
import { getSqlite } from "../db/index.js";
import { fireWorkflowEvent } from "./workflow-events.js";
import type { Config } from "../config.js";

export interface ProviderStatus {
  id: string;
  displayName: string;
  category: "llm" | "sidecar" | "storage" | "rules";
  status: "healthy" | "degraded" | "down";
  lastSeen: string;
  latencyMs: number;
  error: string | null;
}

interface ProviderCheckResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  status?: ProviderStatus["status"];
}

export interface TrustStatus {
  status: "healthy" | "degraded" | "down";
  lastUpdated: string;
  providers: ProviderStatus[];
}

interface ProviderConfig {
  id: string;
  displayName: string;
  category: "llm" | "sidecar" | "storage" | "rules";
  check: () => Promise<ProviderCheckResult>;
}

const healthLogger = pino({ name: "provider-health" });

/**
 * Provider health poller with 30s TTL cache and non-blocking checks.
 * Populates the providers[] array for /api/admin/trust endpoint.
 */
export class ProviderHealthService {
  private cache: TrustStatus | null = null;
  private cacheExpiry = 0;
  private pollInterval = 30_000; // 30 seconds default
  private providers: ProviderConfig[];
  private polling = false;
  /** Tracks the last-known status per provider id for edge-trigger detection. */
  private readonly lastKnownStatus = new Map<string, ProviderStatus["status"]>();
  private config: Config | null = null;

  constructor() {
    // Override poll interval from env var
    const envPollSec = Number(env.TRUST_POLL_SEC);
    if (Number.isFinite(envPollSec) && envPollSec > 0) {
      this.pollInterval = envPollSec * 1000;
    }

    // Initialize provider configurations
    this.providers = [
      {
        id: "openai",
        displayName: "OpenAI",
        category: "llm",
        check: () => this.checkOpenAI(),
      },
      {
        id: "anthropic",
        displayName: "Anthropic",
        category: "llm",
        check: () => this.checkAnthropic(),
      },
      {
        id: "ollama",
        displayName: "Ollama",
        category: "llm",
        check: () => this.checkOllama(),
      },
      {
        id: "scanner",
        displayName: "AgentGuard Scanner",
        category: "sidecar",
        check: () => this.checkScanner(),
      },
      {
        id: "vault",
        displayName: "FileVault Store",
        category: "storage",
        check: () => this.checkVault(),
      },
      {
        id: "n8n",
        displayName: "n8n Workflows",
        category: "sidecar",
        check: () => this.checkN8n(),
      },
      {
        id: "rules",
        displayName: "Rule Pack Loader",
        category: "rules",
        check: () => this.checkRules(),
      },
    ];
  }

  /**
   * Provide the daemon config so pollProviders can fire workflow events.
   * Called once during daemon startup from wherever the singleton is obtained.
   */
  setConfig(config: Config): void {
    this.config = config;
  }

  /**
   * Get current trust status, polling if cache is expired.
   */
  async getStatus(): Promise<TrustStatus> {
    const now = Date.now();

    // Return cached data if still valid
    if (this.cache && now < this.cacheExpiry) {
      return this.cache;
    }

    // No cache available, must poll synchronously
    return await this.pollProviders();
  }

  /**
   * Force immediate refresh of provider status.
   */
  async refresh(): Promise<TrustStatus> {
    return await this.pollProviders();
  }

  /**
   * Poll all providers and update cache.
   */
  private async pollProviders(): Promise<TrustStatus> {
    if (this.polling) {
      // If already polling, wait a bit and return current cache
      await new Promise(resolve => setTimeout(resolve, 100));
      if (this.cache) return this.cache;
      throw new Error("Provider poll already in progress");
    }

    this.polling = true;
    const startTime = Date.now();

    try {
      // Poll all providers in parallel with timeout protection
      const providerPromises = this.providers.map(async (provider) => {
        const start = Date.now();
        try {
          const result = await Promise.race([
            provider.check(),
            new Promise<ProviderCheckResult>((_, reject) =>
              setTimeout(() => reject(new Error("timeout after 10s")), 10_000)
            ),
          ]);

          const latencyMs = Date.now() - start;

          return {
            id: provider.id,
            displayName: provider.displayName,
            category: provider.category,
            status: result.status ?? this.mapStatus(result.ok, latencyMs),
            lastSeen: new Date().toISOString(),
            latencyMs,
            error: result.error || null,
          } as ProviderStatus;
        } catch (error) {
          const latencyMs = Date.now() - start;
          return {
            id: provider.id,
            displayName: provider.displayName,
            category: provider.category,
            status: this.mapStatus(false, latencyMs),
            lastSeen: new Date().toISOString(),
            latencyMs,
            error: error instanceof Error ? error.message : String(error),
          } as ProviderStatus;
        }
      });

      const providers = await Promise.all(providerPromises);

      // Edge-trigger: emit provider.degraded for each healthy→degraded|down transition.
      if (this.config) {
        const config = this.config;
        for (const p of providers) {
          const prior = this.lastKnownStatus.get(p.id);
          const isNewlyUnhealthy =
            prior === "healthy" &&
            (p.status === "degraded" || p.status === "down");
          if (isNewlyUnhealthy) {
            // Fan out across all tenants that have an active provider.degraded workflow.
            try {
              const sqlite = getSqlite();
              const tenantRows = sqlite
                .prepare(
                  `SELECT DISTINCT tenant_id FROM native_automation_workflows
                   WHERE status = 'active'
                     AND trigger_kind = 'event'
                     AND event_kind = 'provider.degraded'`,
                )
                .all() as { tenant_id: string }[];
              for (const row of tenantRows) {
                fireWorkflowEvent(
                  "provider.degraded",
                  { provider: { id: p.id, status: p.status, error: p.error } },
                  { tenantId: row.tenant_id },
                  config,
                ).catch((err: unknown) => {
                  healthLogger.error(
                    { providerId: p.id, tenantId: row.tenant_id, err },
                    "workflow-events: fireWorkflowEvent(provider.degraded) failed",
                  );
                });
              }
            } catch (err) {
              healthLogger.error(
                { providerId: p.id, err },
                "provider-health: failed to query tenants for provider.degraded event",
              );
            }
          }
        }
      }

      // Update prior-status map after processing transitions.
      for (const p of providers) {
        this.lastKnownStatus.set(p.id, p.status);
      }

      // Determine aggregate status
      const aggregateStatus = this.calculateAggregateStatus(providers);

      this.cache = {
        status: aggregateStatus,
        lastUpdated: new Date().toISOString(),
        providers,
      };

      // Set cache expiry with jitter (±10% to avoid thundering herd)
      const jitter = 0.9 + Math.random() * 0.2; // 0.9 to 1.1
      this.cacheExpiry = Date.now() + Math.round(this.pollInterval * jitter);

      return this.cache;
    } finally {
      this.polling = false;
    }
  }

  /**
   * Map check result to status enum.
   */
  private mapStatus(ok: boolean, latencyMs: number): "healthy" | "degraded" | "down" {
    if (!ok) return "down";
    if (latencyMs > 10_000) return "down"; // >10s timeout is critical failure
    if (latencyMs > 5_000) return "degraded"; // >5s is non-critical failure
    return "healthy";
  }

  /**
   * Calculate aggregate status from all providers.
   */
  private calculateAggregateStatus(providers: ProviderStatus[]): "healthy" | "degraded" | "down" {
    if (providers.length === 0) return "healthy";

    const hasDown = providers.some(p => p.status === "down");
    const hasDegraded = providers.some(p => p.status === "degraded");

    if (hasDown) return "down";
    if (hasDegraded) return "degraded";
    return "healthy";
  }

  /**
   * Check OpenAI API health.
   */
  private async checkOpenAI(): Promise<ProviderCheckResult> {
    const start = Date.now();
    try {
      const apiKey = env.OPENAI_API_KEY;
      if (!apiKey) {
        return {
          ok: false,
          status: "degraded",
          latencyMs: Date.now() - start,
          error: "OPENAI_API_KEY not configured",
        };
      }

      const response = await fetch("https://api.openai.com/v1/models", {
        method: "HEAD",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(5000),
      });

      return response.ok
        ? { ok: true, latencyMs: Date.now() - start }
        : { ok: false, latencyMs: Date.now() - start, error: `HTTP ${response.status}` };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Check Anthropic API health.
   */
  private async checkAnthropic(): Promise<ProviderCheckResult> {
    const start = Date.now();
    try {
      const apiKey = env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return {
          ok: false,
          status: "degraded",
          latencyMs: Date.now() - start,
          error: "ANTHROPIC_API_KEY not configured",
        };
      }

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "HEAD",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(5000),
      });

      return response.ok
        ? { ok: true, latencyMs: Date.now() - start }
        : { ok: false, latencyMs: Date.now() - start, error: `HTTP ${response.status}` };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Check Ollama API health.
   */
  private async checkOllama(): Promise<ProviderCheckResult> {
    const start = Date.now();
    try {
      const baseUrl = env.OLLAMA_BASE_URL || "http://localhost:11434";

      const response = await fetch(`${baseUrl}/api/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });

      return response.ok
        ? { ok: true, latencyMs: Date.now() - start }
        : { ok: false, latencyMs: Date.now() - start, error: `HTTP ${response.status}` };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Check AgentGuard scanner sidecar health.
   */
  private async checkScanner(): Promise<ProviderCheckResult> {
    const start = Date.now();
    try {
      const scannerUrl = env.SCANNER_URL || "http://localhost:8001";

      const response = await fetch(`${scannerUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });

      return response.ok
        ? { ok: true, latencyMs: Date.now() - start }
        : { ok: false, latencyMs: Date.now() - start, error: `HTTP ${response.status}` };
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      if (env.SCANNER_REQUIRED !== "1") {
        return {
          ok: false,
          status: "degraded",
          latencyMs: Date.now() - start,
          error: `optional scanner sidecar unavailable: ${errorText}`,
        };
      }
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: errorText
      };
    }
  }

  /**
   * Check FileVault store health.
   */
  private async checkVault(): Promise<ProviderCheckResult> {
    const start = Date.now();
    try {
      const vaultRoot = env.VAULT_ROOT || "/tmp/awo-vault";
      const okFile = join(vaultRoot, ".aw-ok");

      // Check if vault root exists and is accessible
      await stat(vaultRoot);

      // Check for the OK marker file (creates it if missing)
      try {
        await stat(okFile);
      } catch {
        // OK file doesn't exist, but vault is accessible
        // This is acceptable for health check
      }

      return { ok: true, latencyMs: Date.now() - start };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Check n8n workflow automation health.
   */
  private async checkN8n(): Promise<ProviderCheckResult> {
    const start = Date.now();
    try {
      const baseUrl = env.N8N_BASE_URL || "http://localhost:5678";

      const response = await fetch(`${baseUrl}/healthz`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });

      return response.ok
        ? { ok: true, latencyMs: Date.now() - start }
        : { ok: false, latencyMs: Date.now() - start, error: `HTTP ${response.status}` };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check rule pack loader health.
   */
  private async checkRules(): Promise<ProviderCheckResult> {
    const start = Date.now();
    try {
      const rulePacksDir = env.RULE_PACKS_DIR || "./rule-packs";

      // For now, just check if the directory exists
      // In a real implementation, we'd validate manifest.yaml files
      await stat(rulePacksDir);

      return { ok: true, latencyMs: Date.now() - start };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

// Singleton instance
let instance: ProviderHealthService | null = null;

export function getProviderHealthService(): ProviderHealthService {
  if (!instance) {
    instance = new ProviderHealthService();
  }
  return instance;
}
