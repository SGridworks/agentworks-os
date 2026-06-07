import { describe, it, expect } from 'vitest';
import type { MapNode, MapEdge, MapGraph } from './api';

describe('Map API Types', () => {
  it('should support server-computed colors on nodes', () => {
    const node: MapNode = {
      id: 'test-node',
      tenantId: 'test-tenant',
      kind: 'company',
      title: 'Test Company',
      status: 'active',
      color: '#0F172A', // Server-computed color
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    expect(node.color).toBe('#0F172A');
    expect(node.kind).toBe('company');
  });

  it('should support optional color field', () => {
    const node: MapNode = {
      id: 'test-node',
      tenantId: 'test-tenant',
      kind: 'agent',
      title: 'Test Agent',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      // color is optional
    };

    expect(node.color).toBeUndefined();
  });

  it('should support all node kinds', () => {
    const kinds: Array<MapNode['kind']> = [
      'company',
      'project',
      'issue',
      'agent',
      'run',
      'evidence',
      'memory'
    ];

    kinds.forEach(kind => {
      const node: MapNode = {
        id: `test-${kind}`,
        tenantId: 'test-tenant',
        kind,
        title: `Test ${kind}`,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };
      expect(node.kind).toBe(kind);
    });
  });
});
