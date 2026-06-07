/**
 * GET /api/admin/vault-graph
 *
 * Compatibility adapter for older admin views. The daemon owns vault indexing;
 * this route only reshapes /api/memory/metadata into the former graph payload.
 */

export const dynamic = 'force-dynamic';

const AGENTOS_API_URL = process.env.AGENTOS_API_URL ?? 'http://127.0.0.1:7710';
const TENANT_ID = process.env.AGENTOS_TENANT_ID;

interface MetadataPage {
  key: string;
  title: string;
}

interface MetadataLink {
  source: string;
  targetKey?: string;
  resolved: boolean;
}

interface MetadataResponse {
  ok: boolean;
  data?: {
    tenantId: string;
    pages: MetadataPage[];
    links: MetadataLink[];
    unresolvedLinks: MetadataLink[];
  };
}

function dirOf(key: string): string {
  const parts = key.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '/';
}

export async function GET(): Promise<Response> {
  if (!TENANT_ID) {
    return Response.json(
      { error: 'config_missing', message: 'AGENTOS_TENANT_ID env var is required' },
      { status: 500 },
    );
  }

  try {
    const url = new URL('/api/memory/metadata', AGENTOS_API_URL);
    url.searchParams.set('tenantId', TENANT_ID);
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      return Response.json(
        { error: 'metadata_fetch_failed', status: response.status },
        { status: 502 },
      );
    }
    const payload = (await response.json()) as MetadataResponse;
    if (!payload.ok || !payload.data) {
      return Response.json({ error: 'metadata_fetch_failed' }, { status: 502 });
    }

    const nodes = payload.data.pages.map((page) => ({
      id: `${page.key}.md`,
      title: page.title || page.key.split('/').pop() || page.key,
      dir: dirOf(page.key),
    }));

    const edgeSet = new Set<string>();
    const edges: Array<{ source: string; target: string }> = [];
    for (const link of payload.data.links) {
      if (!link.resolved || !link.targetKey || link.source === link.targetKey) continue;
      const source = `${link.source}.md`;
      const target = `${link.targetKey}.md`;
      const sig = `${source}\0${target}`;
      if (edgeSet.has(sig)) continue;
      edgeSet.add(sig);
      edges.push({ source, target });
    }

    return Response.json({
      tenantId: payload.data.tenantId,
      nodes,
      edges,
      stats: {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        unresolvedLinks: payload.data.unresolvedLinks.length,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[vault-graph] failed:', message);
    return Response.json({ error: 'metadata_fetch_failed', message }, { status: 500 });
  }
}
