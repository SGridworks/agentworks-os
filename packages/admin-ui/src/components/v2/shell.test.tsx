import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TopBar } from './shell';

// Mock the API calls
vi.mock('@/lib/api', () => ({
  getHealth: vi.fn().mockResolvedValue({
    status: 'ok',
    version: '1.0.0',
    awcp: 'test',
    startedAt: '2024-01-01T00:00:00Z',
    now: '2024-01-01T00:00:00Z',
  }),
  listTenants: vi.fn().mockResolvedValue([
    { id: 'test-tenant', name: 'Test Tenant', description: null, industry: null, vaultRoot: '/test', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' }
  ]),
  getActiveAgentsCount: vi.fn().mockResolvedValue(5),
}));

describe('TopBar', () => {
  const mockLiveStatus = {
    health: { status: 'ok', version: '1.0.0', awcp: 'test', startedAt: '2024-01-01T00:00:00Z', now: '2024-01-01T00:00:00Z' },
    lastOkAt: Date.now(),
    state: 'ok' as const,
    errorMessage: null,
    tenants: [{ id: 'test-tenant', name: 'Test Tenant', description: null, industry: null, vaultRoot: '/test', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' }],
    activeAgentsCount: 5,
  };

  const mockTenant = { mark: 'TT', name: 'Test Tenant' };
  const mockOnCommandPalette = vi.fn();

  it('renders active agents count when available', () => {
    render(
      <TopBar
        tenant={mockTenant}
        theme="dark"
        onTheme={vi.fn()}
        live={mockLiveStatus}
        onTrustInfo={vi.fn()}
        onCommandPalette={mockOnCommandPalette}
      />
    );
    
    // Should show active agents count
    const activeAgentsElement = screen.getByText('active');
    expect(activeAgentsElement).toBeInTheDocument();
    // Check that it contains the number 5
    expect(activeAgentsElement.parentElement?.textContent).toContain('5');
  });

  it('renders trust info button', () => {
    render(
      <TopBar
        tenant={mockTenant}
        theme="dark"
        onTheme={vi.fn()}
        live={mockLiveStatus}
        onTrustInfo={vi.fn()}
        onCommandPalette={mockOnCommandPalette}
      />
    );
    
    // Should have the trust info button
    const trustButton = screen.getByLabelText('Trust layer information');
    expect(trustButton).toBeInTheDocument();
  });

  it('does not show active agents count when null', () => {
    const liveStatusWithoutAgents = { ...mockLiveStatus, activeAgentsCount: null };
    
    render(
      <TopBar
        tenant={mockTenant}
        theme="dark"
        onTheme={vi.fn()}
        live={liveStatusWithoutAgents}
        onTrustInfo={vi.fn()}
        onCommandPalette={mockOnCommandPalette}
      />
    );
    
    // Should not show active agents count
    expect(screen.queryByText('active')).not.toBeInTheDocument();
  });
});