import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import MorningBrief from './morning-brief';
import * as api from '@/lib/api';

vi.mock('@/lib/api', () => ({
  getMorningBrief: vi.fn(),
  dismissMorningBrief: vi.fn(),
}));

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
});

// Mock window.location
const mockLocation = { href: '' };
Object.defineProperty(window, 'location', {
  value: mockLocation,
  writable: true,
});

beforeEach(() => {
  // Reset localStorage mocks before each test
  vi.clearAllMocks();
  // By default, return null for localStorage (not dismissed)
  localStorageMock.getItem.mockReturnValue(null);
});

describe('MorningBrief', () => {
  it('renders nothing when loading', () => {
    vi.mocked(api.getMorningBrief).mockReturnValue(new Promise(() => {})); // Never resolves

    const { container } = render(
      <MorningBrief tenantId="test-tenant" onNav={vi.fn()} />
    );

    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when no brief data', async () => {
    vi.mocked(api.getMorningBrief).mockResolvedValue(null);

    const { container } = render(
      <MorningBrief tenantId="test-tenant" onNav={vi.fn()} />
    );

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it('renders nothing when brief has no items', async () => {
    vi.mocked(api.getMorningBrief).mockResolvedValue({
      generated_at: '2026-05-19T07:00:04Z',
      dismissible_until: '2026-05-20T04:00:00Z',
      items: [],
    });

    const { container } = render(
      <MorningBrief tenantId="test-tenant" onNav={vi.fn()} />
    );

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it('renders brief with items', async () => {
    const mockBrief = {
      generated_at: '2026-05-19T07:00:04Z',
      dismissible_until: '2026-05-20T04:00:00Z',
      items: [
        {
          id: 'mbr_01',
          kind: 'policy_review' as const,
          severity: 'block' as const,
          title: 'Fair-Housing rule pack: 3 listings need review',
          body: 'Generated 2026-05-18 22:11; agents: listing-bot-a, listing-bot-b',
          call_to_action: {
            label: 'Open queue',
            href: '/approvals?filter=needs_review',
          },
        },
        {
          id: 'mbr_02',
          kind: 'agent_blocked' as const,
          severity: 'review' as const,
          title: 'Agent "cold-caller-01" has been blocked for 14 h',
          body: 'Last violation: TCPA voice-script missing opt-out',
          call_to_action: {
            label: 'View agent',
            href: '/agents/cold-caller-01',
          },
        },
      ],
    };

    vi.mocked(api.getMorningBrief).mockResolvedValue(mockBrief);

    render(<MorningBrief tenantId="test-tenant" onNav={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Morning Brief — 2 items needing attention')).toBeInTheDocument();
      expect(screen.getByText('Fair-Housing rule pack: 3 listings need review')).toBeInTheDocument();
      expect(screen.getByText('Agent "cold-caller-01" has been blocked for 14 h')).toBeInTheDocument();
      expect(screen.getByText('Open queue')).toBeInTheDocument();
      expect(screen.getByText('View agent')).toBeInTheDocument();
    });
  });

  it('uses error color when any item has block severity', async () => {
    const mockBrief = {
      generated_at: '2026-05-19T07:00:04Z',
      dismissible_until: '2026-05-20T04:00:00Z',
      items: [
        {
          id: 'mbr_01',
          kind: 'policy_review' as const,
          severity: 'block' as const,
          title: 'Fair-Housing rule pack: 3 listings need review',
          body: 'Generated 2026-05-18 22:11; agents: listing-bot-a, listing-bot-b',
          call_to_action: {
            label: 'Open queue',
            href: '/approvals?filter=needs_review',
          },
        },
      ],
    };

    vi.mocked(api.getMorningBrief).mockResolvedValue(mockBrief);

    render(<MorningBrief tenantId="test-tenant" onNav={vi.fn()} />);

    await waitFor(() => {
      // Check that the component renders with block severity item
      expect(screen.getByText('Morning Brief — 1 item needing attention')).toBeInTheDocument();
      expect(screen.getByText('BLOCK')).toBeInTheDocument();
    });
  });

  it('uses info color when no items have block severity', async () => {
    const mockBrief = {
      generated_at: '2026-05-19T07:00:04Z',
      dismissible_until: '2026-05-20T04:00:00Z',
      items: [
        {
          id: 'mbr_01',
          kind: 'vault_anomaly' as const,
          severity: 'info' as const,
          title: 'Vault anomaly: hash mismatch detected at 03:42',
          body: 'Run integrity check or contact support',
          call_to_action: {
            label: 'Run check',
            href: '/vault/check',
          },
        },
      ],
    };

    vi.mocked(api.getMorningBrief).mockResolvedValue(mockBrief);

    render(<MorningBrief tenantId="test-tenant" onNav={vi.fn()} />);

    await waitFor(() => {
      // Check that the component renders with info severity item
      expect(screen.getByText('Morning Brief — 1 item needing attention')).toBeInTheDocument();
      expect(screen.getByText('INFO')).toBeInTheDocument();
    });
  });

  it('calls dismissMorningBrief when dismiss button is clicked', async () => {
    const mockBrief = {
      generated_at: '2026-05-19T07:00:04Z',
      dismissible_until: '2026-05-20T04:00:00Z',
      items: [
        {
          id: 'mbr_01',
          kind: 'policy_review' as const,
          severity: 'block' as const,
          title: 'Fair-Housing rule pack: 3 listings need review',
          body: 'Generated 2026-05-18 22:11; agents: listing-bot-a, listing-bot-b',
          call_to_action: {
            label: 'Open queue',
            href: '/approvals?filter=needs_review',
          },
        },
      ],
    };

    vi.mocked(api.getMorningBrief).mockResolvedValue(mockBrief);
    vi.mocked(api.dismissMorningBrief).mockResolvedValue(undefined);

    render(<MorningBrief tenantId="test-tenant" onNav={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Dismiss until tomorrow')).toBeInTheDocument();
    });

    const dismissButton = screen.getByText('Dismiss until tomorrow');
    fireEvent.click(dismissButton);

    await waitFor(() => {
      expect(api.dismissMorningBrief).toHaveBeenCalledWith('test-tenant');
    });
  });

  it('calls onNav with correct path when action button is clicked', async () => {
    const mockBrief = {
      generated_at: '2026-05-19T07:00:04Z',
      dismissible_until: '2026-05-20T04:00:00Z',
      items: [
        {
          id: 'mbr_01',
          kind: 'policy_review' as const,
          severity: 'block' as const,
          title: 'Fair-Housing rule pack: 3 listings need review',
          body: 'Generated 2026-05-18 22:11; agents: listing-bot-a, listing-bot-b',
          call_to_action: {
            label: 'Open queue',
            href: '/approvals?filter=needs_review',
          },
        },
      ],
    };

    const mockOnNav = vi.fn();

    vi.mocked(api.getMorningBrief).mockResolvedValue(mockBrief);

    render(<MorningBrief tenantId="test-tenant" onNav={mockOnNav} />);

    await waitFor(() => {
      expect(screen.getByText('Open queue')).toBeInTheDocument();
    });

    const actionButton = screen.getByText('Open queue');
    fireEvent.click(actionButton);

    await waitFor(() => {
      expect(mockOnNav).toHaveBeenCalledWith('/approvals?filter=needs_review');
    });
  });

  it('uses window.location for external URLs', async () => {
    const mockBrief = {
      generated_at: '2026-05-19T07:00:04Z',
      dismissible_until: '2026-05-20T04:00:00Z',
      items: [
        {
          id: 'mbr_01',
          kind: 'policy_review' as const,
          severity: 'block' as const,
          title: 'Fair-Housing rule pack: 3 listings need review',
          body: 'Generated 2026-05-18 22:11; agents: listing-bot-a, listing-bot-b',
          call_to_action: {
            label: 'Open queue',
            href: 'https://example.com/approvals',
          },
        },
      ],
    };

    vi.mocked(api.getMorningBrief).mockResolvedValue(mockBrief);

    render(<MorningBrief tenantId="test-tenant" onNav={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Open queue')).toBeInTheDocument();
    });

    const actionButton = screen.getByText('Open queue');
    fireEvent.click(actionButton);

    await waitFor(() => {
      expect(window.location.href).toBe('https://example.com/approvals');
    });
  });

  it('does not render brief when it has been dismissed for the day', async () => {
    const mockBrief = {
      generated_at: '2026-05-19T07:00:04Z',
      dismissible_until: '2026-05-20T04:00:00Z',
      items: [
        {
          id: 'mbr_01',
          kind: 'policy_review' as const,
          severity: 'block' as const,
          title: 'Fair-Housing rule pack: 3 listings need review',
          body: 'Generated 2026-05-18 22:11; agents: listing-bot-a, listing-bot-b',
          call_to_action: {
            label: 'Open queue',
            href: '/approvals?filter=needs_review',
          },
        },
      ],
    };

    // Mock localStorage to indicate this brief has been dismissed
    localStorageMock.getItem.mockImplementation((key: string) => {
      if (key === 'dismissed-brief-test-tenant-2026-05-19') {
        return 'true';
      }
      return null;
    });

    vi.mocked(api.getMorningBrief).mockResolvedValue(mockBrief);

    const { container } = render(<MorningBrief tenantId="test-tenant" onNav={vi.fn()} />);

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it('stores dismissal in localStorage when dismiss button is clicked', async () => {
    const mockBrief = {
      generated_at: '2026-05-19T07:00:04Z',
      dismissible_until: '2026-05-20T04:00:00Z',
      items: [
        {
          id: 'mbr_01',
          kind: 'policy_review' as const,
          severity: 'block' as const,
          title: 'Fair-Housing rule pack: 3 listings need review',
          body: 'Generated 2026-05-18 22:11; agents: listing-bot-a, listing-bot-b',
          call_to_action: {
            label: 'Open queue',
            href: '/approvals?filter=needs_review',
          },
        },
      ],
    };

    vi.mocked(api.getMorningBrief).mockResolvedValue(mockBrief);
    vi.mocked(api.dismissMorningBrief).mockResolvedValue(undefined);

    render(<MorningBrief tenantId="test-tenant" onNav={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Dismiss until tomorrow')).toBeInTheDocument();
    });

    const dismissButton = screen.getByText('Dismiss until tomorrow');
    fireEvent.click(dismissButton);

    await waitFor(() => {
      expect(api.dismissMorningBrief).toHaveBeenCalledWith('test-tenant');
      expect(localStorageMock.setItem).toHaveBeenCalledWith('dismissed-brief-test-tenant-2026-05-19', 'true');
    });
  });
});
