import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { CommandPalette, ActionRegistryItem } from './command-palette';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    value: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
      clear: vi.fn(() => {
        store.clear();
      }),
    },
    configurable: true,
  });
});

const mockRegistry: ActionRegistryItem[] = [
  {
    id: 'scan.approve',
    verb: 'Approve',
    noun: 'Scan',
    description: 'mark queued scan as reviewed',
    icon: '✓',
    scope: 'page',
    page: '/scans',
    handler: 'scan.approve',
    dangerous: false,
  },
  {
    id: 'tenant.switch',
    verb: 'Switch',
    noun: 'Tenant',
    description: 'change active tenant',
    icon: '🔄',
    scope: 'global',
    handler: 'tenant.switch',
    dangerous: false,
  },
];

describe('CommandPalette localStorage', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onSelect: vi.fn(),
    registry: mockRegistry,
    currentPage: '/scans',
  };

  it('persists recent actions to localStorage when an action is selected', async () => {
    render(<CommandPalette {...defaultProps} />);
    
    // Search for and select an action
    const input = screen.getByPlaceholderText('Search commands...');
    fireEvent.change(input, { target: { value: 'approve' } });
    
    const items = screen.getAllByRole('menuitem');
    fireEvent.click(items[0]);
    
    // Check that localStorage was updated
    await waitFor(() => {
      expect(localStorage.getItem('command-palette-recent')).toBeTruthy();
    });

    const stored = localStorage.getItem('command-palette-recent');
    
    const recentIds = JSON.parse(stored!);
    expect(recentIds).toContain('scan.approve');
  });

  it('shows recent actions when query is empty and there are recent actions', () => {
    // Pre-populate localStorage with recent actions
    localStorage.setItem('command-palette-recent', JSON.stringify(['scan.approve']));
    
    render(<CommandPalette {...defaultProps} />);
    
    // Should show the recent action when query is empty
    const items = screen.getAllByRole('menuitem');
    expect(items.length).toBeGreaterThan(0);
    
    // Should contain the recent action - check for the verb and noun
    expect(screen.getByText('Approve')).toBeInTheDocument();
    expect(screen.getByText('Scan')).toBeInTheDocument();
  });

  it('limits recent actions to top 5 when query is empty', async () => {
    // Pre-populate localStorage with more than 5 recent actions
    const manyRecentActions = ['scan.approve', 'tenant.switch', 'action1', 'action2', 'action3', 'action4'];
    localStorage.setItem('command-palette-recent', JSON.stringify(manyRecentActions));
    
    // Create a larger registry
    const largeRegistry = [
      ...mockRegistry,
      { id: 'action1', verb: 'Action', noun: 'One', description: 'test', icon: '1', scope: 'global' as const, handler: 'action1' },
      { id: 'action2', verb: 'Action', noun: 'Two', description: 'test', icon: '2', scope: 'global' as const, handler: 'action2' },
      { id: 'action3', verb: 'Action', noun: 'Three', description: 'test', icon: '3', scope: 'global' as const, handler: 'action3' },
      { id: 'action4', verb: 'Action', noun: 'Four', description: 'test', icon: '4', scope: 'global' as const, handler: 'action4' },
    ];
    
    render(<CommandPalette {...defaultProps} registry={largeRegistry} />);
    
    // Should show only 5 recent actions when query is empty
    await waitFor(() => {
      expect(screen.getAllByRole('menuitem')).toHaveLength(5);
    });
  });

  it('shows all actions when query is not empty, even with recent actions', () => {
    // Pre-populate localStorage with recent actions
    localStorage.setItem('command-palette-recent', JSON.stringify(['scan.approve']));
    
    render(<CommandPalette {...defaultProps} />);
    
    // Search for something
    const input = screen.getByPlaceholderText('Search commands...');
    fireEvent.change(input, { target: { value: 'tenant' } });
    
    // Should show matching actions, not just recent ones
    const items = screen.getAllByRole('menuitem');
    expect(items.length).toBe(1);
    expect(items[0].textContent).toContain('Switch Tenant');
  });

  it('handles localStorage errors gracefully', () => {
    // Mock localStorage to throw an error
    const originalGetItem = localStorage.getItem;
    localStorage.getItem = vi.fn(() => {
      throw new Error('localStorage error');
    });
    
    // Should not crash when loading recent actions
    expect(() => {
      render(<CommandPalette {...defaultProps} />);
    }).not.toThrow();
    
    // Restore original
    localStorage.getItem = originalGetItem;
  });

  it('handles localStorage setItem errors gracefully', () => {
    // Mock localStorage to throw an error on setItem
    const originalSetItem = localStorage.setItem;
    localStorage.setItem = vi.fn(() => {
      throw new Error('localStorage error');
    });
    
    render(<CommandPalette {...defaultProps} />);
    
    // Search for and select an action
    const input = screen.getByPlaceholderText('Search commands...');
    fireEvent.change(input, { target: { value: 'approve' } });
    
    const items = screen.getAllByRole('menuitem');
    
    // Should not crash when trying to save recent action
    expect(() => {
      fireEvent.click(items[0]);
    }).not.toThrow();
    
    // Restore original
    localStorage.setItem = originalSetItem;
  });
});
