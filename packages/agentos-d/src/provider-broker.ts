export interface ProviderRoute {
  id: string;
  provider: string;
  model: string;
  credential_source: string;
  base_url: string;
  auth_mode: string;
  priority: number;
  cost_quality_tier: string;
  health_check: string;
  created_at: string;
  updated_at: string;
  failure_class?: string;
  cooldown_until?: string;
}

export interface ProviderHealth {
  healthy: boolean;
  checked_at: string;
  fallback_reason?: string;
  failure_class?: string;
  cooldown_until?: string;
}

export class ProviderBroker {
  private routes: ProviderRoute[] = [
    {
      id: 'route-ollama-cloud',
      provider: 'Ollama Cloud',
      model: 'gpt-3.5-turbo',
      credential_source: 'api_key',
      base_url: 'https://api.ollama.com',
      auth_mode: 'api_key',
      priority: 1,
      cost_quality_tier: 'low',
      health_check: 'initial',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 'route-anthropic-oauth',
      provider: 'Anthropic OAuth',
      model: 'sonnet-3.5',
      credential_source: 'oauth',
      base_url: 'https://api.anthropic.com',
      auth_mode: 'oauth',
      priority: 2,
      cost_quality_tier: 'high',
      health_check: 'initial',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 'route-xai',
      provider: 'xAI',
      model: 'grok-1',
      credential_source: 'api_key',
      base_url: 'https://api.x.ai',
      auth_mode: 'api_key',
      priority: 3,
      cost_quality_tier: 'medium',
      health_check: 'initial',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  private healthCache = new Map<string, ProviderHealth>();

  constructor() {
    // health state is managed entirely by healthCache
  }

  /** Get all configured provider routes */
  getRoutes(): ProviderRoute[] {
    return this.routes;
  }

  /** Get only the routes that are currently considered healthy */
  getHealthyRoutes(): ProviderRoute[] {
    return this.routes.filter((route) => this.isHealthy(route.id));
  }

  /** Determine whether a route is healthy, respecting any active cooldown */
  isHealthy(routeId: string): boolean {
    const entry = this.healthCache.get(routeId);
    if (!entry) return true; // Assume healthy if no health record exists
    if (entry.cooldown_until) {
      const now = new Date().getTime();
      return now >= new Date(entry.cooldown_until).getTime();
    }
    return entry.healthy;
  }

  /** Mark a route as unhealthy and start its cooldown */
  markUnhealthy(routeId: string, failureClass: string, reason: string): void {
    const nowMs = new Date().getTime();
    const offlineMs = this.getOfflineMs(failureClass);
    this.healthCache.set(routeId, {
      healthy: false,
      checked_at: new Date(nowMs).toISOString(),
      fallback_reason: reason,
      failure_class: failureClass,
      cooldown_until: new Date(nowMs + offlineMs).toISOString(),
    });
  }

  /** Return the configured cooldown length (ms) for a failure class */
  private getOfflineMs(failureClass: string): number {
    switch (failureClass) {
      case 'auth':
        return 300_000; // 5 minutes
      case 'quota':
        return 300_000; // 5 minutes
      case 'api_connection':
        return 300_000; // 5 minutes
      case 'serialization':
        return 300_000; // 5 minutes
      default:
        return 60_000; // 1 minute
    }
  }

  /** Clear cooldown for a provider after a successful call */
  recordSuccess(provider: string, tenantId: string): void {
    const entry = this.healthCache.get(provider);
    if (!entry) return;
    const { cooldown_until, ...rest } = entry;
    this.healthCache.set(provider, rest);
  }

  /** Record a failure for a provider; infer failure class from error code */
  recordFailure(provider: string, tenantId: string, errorCode?: string): void {
    let inferredClass: string | undefined;
    if (errorCode) {
      switch (errorCode) {
        case 'AUTHENTICATION_FAILED': inferredClass = 'auth'; break;
        case 'QUOTA_EXCEEDED': inferredClass = 'quota'; break;
        case 'API_CONNECTION_ERROR': inferredClass = 'api_connection'; break;
        case 'SERIALIZATION_ERROR': inferredClass = 'serialization'; break;
        default: inferredClass = 'default';
      }
    }
    if (inferredClass) {
      this.markUnhealthy(provider, inferredClass, errorCode || 'generic_error');
    }
  }

  /** Legacy method kept for backward compatibility */
  markUnhealthyOriginal(routeId: string, reason: string): void {
    this.healthCache.set(routeId, {
      healthy: false,
      checked_at: new Date().toISOString(),
      fallback_reason: reason,
    });
  }

  /** Select a route based on a preferred order of providers */
  selectRoute(preferredOrder: string[]): { route: ProviderRoute; is_fallback: boolean; fallback_reason?: string } {
    const healthyRoutes = this.getHealthyRoutes();
    if (!healthyRoutes.length) {
      const emptyRoute: ProviderRoute = {
        id: '',
        provider: '',
        model: '',
        credential_source: '',
        base_url: '',
        auth_mode: '',
        priority: 0,
        cost_quality_tier: '',
        health_check: '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      return { route: emptyRoute as ProviderRoute, is_fallback: false };
    }

    for (const provider of preferredOrder) {
      const route = healthyRoutes.find((r) => r.provider === provider);
      if (route) {
        return { route, is_fallback: false };
      }
    }

    // There is at least one healthy route, so fallback is safe
    const fallbackRoute = healthyRoutes[0] as ProviderRoute;
    return { route: fallbackRoute, is_fallback: true, fallback_reason: 'preferred_routes_unhealthy' };
  }
}
