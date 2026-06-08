import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import MapPage from './page';

// Mock the API calls
vi.mock('@/lib/api', () => ({
  listTenants: vi.fn().mockResolvedValue([
    { id: 'test-tenant', name: 'Test Tenant', description: 'Test', industry: 'other', vaultRoot: '/test', createdAt: '2024-01-01', updatedAt: '2024-01-01' }
  ]),
  getMapGraph: vi.fn().mockResolvedValue({
    nodes: [
      {
        id: 'test-node-1',
        tenantId: 'test-tenant',
        kind: 'company' as const,
        title: 'Test Company',
        status: 'active',
        color: '#0F172A',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z'
      },
      {
        id: 'test-node-2',
        tenantId: 'test-tenant',
        kind: 'agent' as const,
        title: 'Test Agent',
        status: 'active',
        color: '#F59E0B',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z'
      }
    ],
    edges: [
      {
        id: 'test-edge-1',
        tenantId: 'test-tenant',
        fromNodeId: 'test-node-1',
        toNodeId: 'test-node-2',
        kind: 'owns' as const,
        createdAt: '2024-01-01T00:00:00Z'
      }
    ]
  })
}));

// Mock the navigation hook
vi.mock('@/components/v2/nav', () => ({
  useV2Nav: vi.fn(() => vi.fn())
}));

describe('MapPage Integration', () => {
  it('should render without errors', () => {
    const { container } = render(<MapPage />);
    expect(container).toBeTruthy();
  });

  it('should display the mission map title', () => {
    render(<MapPage />);
    expect(screen.getByText('Mission Map')).toBeTruthy();
  });

  it('should show loading state initially', () => {
    render(<MapPage />);
    expect(screen.getByText('Loading mission map...')).toBeTruthy();
  });
});
