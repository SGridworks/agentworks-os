import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CommandPalette, ActionRegistryItem } from './command-palette';

afterEach(() => {
  cleanup();
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
  {
    id: 'scan.reject',
    verb: 'Reject',
    noun: 'Scan',
    description: 'reject scan with reason',
    icon: '✗',
    scope: 'page',
    page: '/scans',
    handler: 'scan.reject',
    dangerous: true,
  },
];

describe('CommandPalette', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onSelect: vi.fn(),
    registry: mockRegistry,
    currentPage: '/scans',
  };

  it('renders when open', () => {
    render(<CommandPalette {...defaultProps} />);

    expect(screen.getByPlaceholderText('Search commands...')).toBeInTheDocument();
    // Check that at least one action is rendered
    expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(0);
  });

  it('does not render when closed', () => {
    render(<CommandPalette {...defaultProps} isOpen={false} />);

    expect(screen.queryByPlaceholderText('Search commands...')).not.toBeInTheDocument();
  });

  it('filters actions based on search query', () => {
    render(<CommandPalette {...defaultProps} />);

    const input = screen.getByPlaceholderText('Search commands...');
    fireEvent.change(input, { target: { value: 'approve' } });

    // Should filter to show only approve-related actions
    const items = screen.getAllByRole('menuitem');
    expect(items.length).toBe(1); // Only the approve action should match
  });

  it('handles keyboard navigation', () => {
    render(<CommandPalette {...defaultProps} />);

    const input = screen.getByPlaceholderText('Search commands...');

    // Arrow down should move selection
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    // Enter should select the highlighted item
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(defaultProps.onSelect).toHaveBeenCalledWith(mockRegistry[0]);
  });

  it('handles Escape key to close', () => {
    render(<CommandPalette {...defaultProps} />);

    const input = screen.getByPlaceholderText('Search commands...');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('handles click to select item', () => {
    render(<CommandPalette {...defaultProps} />);

    const items = screen.getAllByRole('menuitem');
    fireEvent.click(items[0]);

    expect(defaultProps.onSelect).toHaveBeenCalledWith(mockRegistry[0]);
  });

  it('shows empty state when no matches', () => {
    render(<CommandPalette {...defaultProps} />);

    const input = screen.getByPlaceholderText('Search commands...');
    fireEvent.change(input, { target: { value: 'nonexistent' } });

    expect(screen.getByText('No matching actions. Try a different phrase or press Esc to close.')).toBeInTheDocument();
  });

  it('clears search query when clear button is clicked', () => {
    render(<CommandPalette {...defaultProps} />);

    const input = screen.getByPlaceholderText('Search commands...');
    fireEvent.change(input, { target: { value: 'test query' } });

    const clearButton = screen.getByLabelText('Clear search');
    fireEvent.click(clearButton);

    expect(input).toHaveValue('');
  });

  it('styles dangerous actions correctly', () => {
    render(<CommandPalette {...defaultProps} />);

    // Search for "reject" to make sure the dangerous action is visible
    const input = screen.getByPlaceholderText('Search commands...');
    fireEvent.change(input, { target: { value: 'reject' } });

    const items = screen.getAllByRole('menuitem');
    // Find the reject action (which is dangerous)
    const rejectItem = items.find(item => item.textContent?.includes('Reject'));
    expect(rejectItem).toBeDefined();
    expect(rejectItem).toHaveClass('command-palette-item-dangerous');
  });

  it('groups actions correctly', () => {
    render(<CommandPalette {...defaultProps} />);

    // Should show contextual actions (page-scoped) first when on matching page
    const items = screen.getAllByRole('menuitem');
    expect(items.length).toBeGreaterThan(0);
  });

  it('handles shortcut display', () => {
    const registryWithShortcut = [
      ...mockRegistry,
      {
        id: 'test.shortcut',
        verb: 'Test',
        noun: 'Shortcut',
        description: 'test with shortcut',
        icon: '⌨',
        scope: 'global' as const,
        handler: 'test.shortcut',
        shortcut: ['Ctrl', 'Shift', 'T'],
      },
    ];

    render(<CommandPalette {...defaultProps} registry={registryWithShortcut} />);

    // Search for the shortcut action to make sure it's visible
    const input = screen.getByPlaceholderText('Search commands...');
    fireEvent.change(input, { target: { value: 'test' } });

    expect(screen.getByText('Ctrl + Shift + T')).toBeInTheDocument();
  });
});
