import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { V2Shell } from './shell';

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
  listAgents: vi.fn().mockResolvedValue([]),
  getActiveAgentsCount: vi.fn().mockResolvedValue(5),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

describe('CommandPalette Integration', () => {
  it('opens command palette when cmdk is clicked', () => {
    render(
      <V2Shell
        active="mission-control"
        onNav={vi.fn()}
      >
        <div>Test content</div>
      </V2Shell>
    );

    // Find the cmdk element and click it
    const cmdkElement = screen.getByTitle('Command palette (Cmd+K)');
    fireEvent.click(cmdkElement);

    // Command palette should be open (input should be visible)
    expect(screen.getByPlaceholderText('Search commands...')).toBeInTheDocument();
  });

  it('closes command palette when Escape is pressed', () => {
    render(
      <V2Shell
        active="mission-control"
        onNav={vi.fn()}
      >
        <div>Test content</div>
      </V2Shell>
    );

    // Open command palette
    const cmdkElement = screen.getByTitle('Command palette (Cmd+K)');
    fireEvent.click(cmdkElement);

    // Verify it's open
    const input = screen.getByPlaceholderText('Search commands...');
    expect(input).toBeInTheDocument();

    // Press Escape
    fireEvent.keyDown(input, { key: 'Escape' });

    // Should be closed now
    expect(screen.queryByPlaceholderText('Search commands...')).not.toBeInTheDocument();
  });
});
