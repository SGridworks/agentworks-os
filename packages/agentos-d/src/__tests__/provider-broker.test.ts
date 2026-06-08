import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProviderBroker, ProviderRoute } from '../provider-broker';

// Mock db object with select, from, where, first, orderBy, and insert methods
const makeMockDb = () => {
  const routes: ProviderRoute[] = [
    {
      id: 'route-ollama',
      provider: 'Ollama Cloud',
      model: 'gpt-3.5-turbo',
      credential_source: 'api_key',
      base_url: 'https://api.ollama.com',
      auth_mode: 'api_key',
      priority: 1,
      cost_quality_tier: 'low',
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
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  // Simple in-memory db mock
  const db = {
    select: () => ({
      from: () => ({
        where: (cond: any) => ({
          first: () => (cond.id === 'provider_routes.id' ? undefined : routes.find(r => r.id === cond.id)),
        }),
        orderBy: (order: any) => ({
          asc: () => ({}), // no-op for ordering logic in tests
        }),
      }),
    }),

    insert: (table: string, data: any) => {
      // Track inserts for later verification
      if (!db.insert.logs) db.insert.logs = [];
      db.insert.logs.push({ table, data });
      return { id: Math.random().toString() };
    },
    // Helper to retrieve logged inserts
    getInsertLogs: () => db.insert?.logs || [],
  };

  return db;
};

describe('ProviderBroker', () => {
  let broker: any;
  let mockDb: any;

  beforeEach(() => {
    mockDb = makeMockDb();
    broker = new ProviderBroker(mockDb);
  });

  it('should fallback from unhealthy Ollama to Anthropic OAuth when preferred order is set', async () => {
    const routes = await broker.getRoutes();
    const ollamaRoute = routes.find(r => r.provider === 'Ollama Cloud')!;
    const anthropicRoute = routes.find(r => r.provider === 'Anthropic OAuth')!;
    const xaiRoute = routes.find(r => r.provider === 'xAI')!;

    broker.markUnhealthy(ollamaRoute.id, 'api_connection', 'preferred_routes_unhealthy');
    broker.markUnhealthy(xaiRoute.id, 'api_connection', 'preferred_routes_unhealthy');

    // Mock getHealthyRoutes to return only Anthropic OAuth route as healthy
    vi.spyOn(broker as any, 'getHealthyRoutes').mockReturnValue([anthropicRoute]);

    // Execute selectRoute with preferred order specifying Ollama then Anthropic OAuth
    const result = await broker.selectRoute(['Ollama Cloud', 'Anthropic OAuth']);

    // Anthropic is still in the preferred order, so this is a preferred-route selection.
    expect(result.is_fallback).toBe(false);
    expect(result.fallback_reason).toBeUndefined();
    expect(result.route.provider).toBe('Anthropic OAuth');
  });
});
