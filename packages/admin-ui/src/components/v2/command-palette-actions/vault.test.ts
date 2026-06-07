import { describe, it, expect, vi } from 'vitest';
import { createVaultSearchActions, createVaultSearchResultActions, executeVaultSearch } from './vault';

// Mock the API
vi.mock('@/lib/api', () => ({
  listTenants: vi.fn().mockResolvedValue([
    { id: 'test-tenant-1', name: 'Test Tenant', description: null, industry: null, vaultRoot: '/test', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' }
  ]),
}));

// Mock fetch for vault search
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('Vault Search Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createVaultSearchActions', () => {
    it('should create vault search action', () => {
      const actions = createVaultSearchActions();
      
      expect(actions).toHaveLength(1);
      expect(actions[0]).toEqual({
        id: 'vault-search',
        verb: 'Search',
        noun: 'Vault Notes',
        description: 'Search memory vault for notes and knowledge',
        icon: '🔍',
        scope: 'global',
        handler: 'vault.search',
        keywords: ['vault', 'memory', 'search', 'notes', 'knowledge', 'find'],
      });
    });
  });

  describe('executeVaultSearch', () => {
    it('should execute vault search successfully', async () => {
      const mockResults = [
        {
          kind: 'episode' as const,
          id: 'test-episode-1',
          tenantId: 'test-tenant-1',
          text: 'Test episode summary',
          score: 0.9,
          meta: { role: 'test-role', taskType: 'test-task' }
        },
        {
          kind: 'insight' as const,
          id: 'test-insight-1',
          tenantId: 'test-tenant-1',
          text: 'Test insight content',
          score: 0.8,
          meta: { frameType: 'fact', subject: 'test subject' }
        }
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: { hits: mockResults }
        })
      });

      const results = await executeVaultSearch('test query');
      
      expect(results).toEqual(mockResults);
      expect(mockFetch).toHaveBeenCalledWith('/api/memory/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: 'test-tenant-1',
          query: 'test query',
          topK: 10,
        }),
      });
    });

    it('should handle search failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      });

      await expect(executeVaultSearch('test query')).rejects.toThrow('Search failed: 500 Internal Server Error');
    });

    it('should handle API error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: false,
          error: 'Search service unavailable'
        })
      });

      await expect(executeVaultSearch('test query')).rejects.toThrow('Search failed');
    });
  });

  describe('createVaultSearchResultActions', () => {
    it('should create result actions from search results', () => {
      const mockResults = [
        {
          kind: 'episode' as const,
          id: 'test-episode-1',
          tenantId: 'test-tenant-1',
          text: 'This is a test episode summary that is longer than 100 characters to test the excerpt truncation functionality',
          score: 0.9,
          meta: { role: 'test-role', taskType: 'test-task' }
        },
        {
          kind: 'insight' as const,
          id: 'test-insight-1',
          tenantId: 'test-tenant-1',
          text: 'Short insight',
          score: 0.8,
          meta: { frameType: 'fact', subject: 'test subject' }
        }
      ];

      const mockNavigate = vi.fn();
      const actions = createVaultSearchResultActions(mockResults, mockNavigate);

      expect(actions).toHaveLength(2);
      
      // Check first action (episode)
      expect(actions[0]).toMatchObject({
        id: expect.stringContaining('vault-result-episode-test-episode-1'),
        verb: 'View',
        noun: 'test-task', // From meta.taskType
        description: 'This is a test episode summary that is longer than 100 characters to test the excerpt truncation …',
        icon: '📝',
        scope: 'global',
      });

      // Check second action (insight)
      expect(actions[1]).toMatchObject({
        id: expect.stringContaining('vault-result-insight-test-insight-1'),
        verb: 'View',
        noun: 'test subject', // From meta.subject
        description: 'Short insight',
        icon: '💡',
        scope: 'global',
      });

      // Test navigation
      actions[0].handler();
      expect(mockNavigate).toHaveBeenCalledWith('/memory-vault?selected=test-episode-1');
    });

    it('should handle missing meta information', () => {
      const mockResults = [
        {
          kind: 'episode' as const,
          id: 'test-episode-1',
          tenantId: 'test-tenant-1',
          text: 'Test episode',
          score: 0.9,
          meta: {}
        }
      ];

      const mockNavigate = vi.fn();
      const actions = createVaultSearchResultActions(mockResults, mockNavigate);

      expect(actions[0].noun).toBe('test-episode-1'); // Falls back to ID
    });
  });
});