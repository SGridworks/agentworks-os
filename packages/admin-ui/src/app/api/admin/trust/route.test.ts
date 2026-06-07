import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

describe('/api/admin/trust BFF', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalises camelCase daemon provider fields for the UI', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      Response.json({
        warnings: [],
        agents: { active: 1, paused: 0, retired: 0 },
        providers: [
          {
            id: 'ollama',
            displayName: 'Ollama',
            category: 'llm',
            status: 'healthy',
            lastSeen: '2026-05-16T14:20:58.663Z',
            latencyMs: 6,
            error: null,
          },
          {
            id: 'vault',
            displayName: 'FileVault Store',
            category: 'storage',
            status: 'down',
            lastSeen: '2026-05-16T14:20:58.663Z',
            latencyMs: 100,
            error: 'missing',
          },
        ],
      }),
    ));

    const response = await GET(
      new Request('http://localhost/api/admin/trust?tenantId=t1&fresh=1'),
    );
    const body = await response.json();

    expect(body.providers).toEqual([
      {
        id: 'ollama',
        kind: 'model_host',
        display_name: 'Ollama',
        status: 'healthy',
        last_ok: '2026-05-16T14:20:58.663Z',
        latency_ms: 6,
        errors_last_24h: 0,
        endpoint: null,
        note: null,
      },
      {
        id: 'vault',
        kind: 'object_store',
        display_name: 'FileVault Store',
        status: 'down',
        last_ok: '2026-05-16T14:20:58.663Z',
        latency_ms: 100,
        errors_last_24h: 0,
        endpoint: null,
        note: 'missing',
      },
    ]);
  });
});
