import { ActionRegistryItem } from '../command-palette';
import { listTenants } from '@/lib/api';

export interface VaultSearchResult {
  kind: 'episode' | 'insight';
  id: string;
  tenantId: string;
  text: string;
  score: number;
  meta: Record<string, unknown>;
}

export function createVaultSearchActions(): ActionRegistryItem[] {
  return [
    {
      id: 'vault-search',
      verb: 'Search',
      noun: 'Vault Notes',
      description: 'Search memory vault for notes and knowledge',
      icon: '🔍',
      scope: 'global',
      handler: 'vault.search',
      keywords: ['vault', 'memory', 'search', 'notes', 'knowledge', 'find'],
    },
  ];
}

export async function executeVaultSearch(query: string): Promise<VaultSearchResult[]> {
  try {
    const tenants = await listTenants();
    if (!tenants || tenants.length === 0) {
      throw new Error('No tenants available');
    }

    const response = await fetch('/api/memory/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId: tenants[0].id,
        query: query,
        topK: 10,
      }),
    });

    if (!response.ok) {
      throw new Error(`Search failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.ok) {
      throw new Error(data.error || 'Search failed');
    }

    return data.data.hits as VaultSearchResult[];
  } catch (error) {
    console.error('Vault search error:', error);
    if (error instanceof Error && error.message.includes('Search service unavailable')) {
      throw new Error('Search failed');
    }
    throw error;
  }
}

export function createVaultSearchResultActions(
  results: VaultSearchResult[],
  onNavigate: (path: string) => void
): ActionRegistryItem[] {
  return results.map((result, index) => {
    // Create excerpt from text (first 97 characters + ellipsis for 100 total)
    const excerpt = result.text.length > 97 
      ? result.text.substring(0, 97) + '…'
      : result.text;

    // Determine icon based on kind
    const icon = result.kind === 'episode' ? '📝' : '💡';
    
    // Create title from meta information or fallback to ID
    const title = result.meta?.subject || result.meta?.taskType || result.meta?.role || result.id;

    return {
      id: `vault-result-${result.kind}-${result.id}-${index}`,
      verb: 'View',
      noun: title as string,
      description: excerpt,
      icon,
      scope: 'global',
      handler: () => {
        // Navigate to memory vault with the selected note ID
        onNavigate(`/memory-vault?selected=${encodeURIComponent(result.id)}`);
      },
      keywords: [result.kind, result.id, ...(result.meta ? Object.values(result.meta).map(v => String(v)) : [])],
    };
  });
}