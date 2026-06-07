import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TrustDrawer } from './trust-drawer';

// vi.mock is hoisted — factory must not reference module-level variables
vi.mock('@/lib/api', () => ({
  getTrustStatus: vi.fn().mockResolvedValue({
    summary: 'healthy',
    checked_at: '2026-05-20T17:34:12Z',
    warnings: [],
    providers: [
      {
        id: 'openai',
        kind: 'model_host',
        display_name: 'OpenAI',
        status: 'healthy',
        last_ok: '2026-05-20T17:33:57Z',
        latency_ms: 234,
        errors_last_24h: 0,
        endpoint: 'https://api.openai.com/v1/models',
        note: null,
      },
    ],
    daemon: {
      pid: 12345,
      version: '0.1.9',
      startedAt: '2026-05-20T10:00:00Z',
      uptimeS: 27252,
    },
    db: {
      path: '/tmp/agentworks.db',
      sizeBytes: 30 * 1024 * 1024,
      usingProfile: true,
      writable: true,
    },
    agents: { active: 6, paused: 0, retired: 2 },
    dispatch: { queued: 0, dispatched: 0, stale: 0, duplicateWakeups: 0 },
    inspector: { listening: false },
  }),
}));

const BASE_RESPONSE = {
  summary: 'healthy' as const,
  checked_at: '2026-05-20T17:34:12Z',
  warnings: [] as string[],
  providers: [
    {
      id: 'openai',
      kind: 'model_host' as const,
      display_name: 'OpenAI',
      status: 'healthy' as const,
      last_ok: '2026-05-20T17:33:57Z',
      latency_ms: 234,
      errors_last_24h: 0,
      endpoint: 'https://api.openai.com/v1/models',
      note: null,
    },
  ],
  daemon: {
    pid: 12345,
    version: '0.1.9',
    startedAt: '2026-05-20T10:00:00Z',
    uptimeS: 27252,
  },
  db: {
    path: '/tmp/agentworks.db',
    sizeBytes: 30 * 1024 * 1024,
    usingProfile: true,
    writable: true,
  },
  agents: { active: 6, paused: 0, retired: 2 },
  dispatch: { queued: 0, dispatched: 0, stale: 0, duplicateWakeups: 0 },
  inspector: { listening: false },
};

describe('TrustDrawer', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { getTrustStatus } = await import('@/lib/api');
    vi.mocked(getTrustStatus).mockResolvedValue(BASE_RESPONSE);
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <TrustDrawer open={false} onClose={vi.fn()} tenantId="test-tenant" />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders when open', () => {
    render(
      <TrustDrawer open={true} onClose={vi.fn()} tenantId="test-tenant" />
    );

    expect(screen.getByText('Trust / Health')).toBeInTheDocument();
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(
      <TrustDrawer open={true} onClose={onClose} tenantId="test-tenant" />
    );

    const backdrop = screen.getByRole('presentation');
    fireEvent.click(backdrop);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose when drawer content is clicked', () => {
    const onClose = vi.fn();
    render(
      <TrustDrawer open={true} onClose={onClose} tenantId="test-tenant" />
    );

    const drawer = screen.getByText('Trust / Health').closest('.trust-drawer');
    fireEvent.click(drawer!);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <TrustDrawer open={true} onClose={onClose} tenantId="test-tenant" />
    );

    const closeButton = screen.getByLabelText('Close');
    fireEvent.click(closeButton);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fetches trust data when opened', async () => {
    const { getTrustStatus } = await import('@/lib/api');

    render(
      <TrustDrawer open={true} onClose={vi.fn()} tenantId="test-tenant" />
    );

    await waitFor(() => {
      expect(getTrustStatus).toHaveBeenCalledWith('test-tenant', false);
    });

    // With zero warnings, overall status is "Healthy"
    expect(screen.getByText('Healthy')).toBeInTheDocument();
  });

  it('displays provider information correctly', async () => {
    render(
      <TrustDrawer open={true} onClose={vi.fn()} tenantId="test-tenant" />
    );

    await waitFor(() => {
      expect(screen.getByText('OpenAI')).toBeInTheDocument();
      expect(screen.getByText('234ms')).toBeInTheDocument();
    });
  });

  it('handles missing tenantId gracefully', () => {
    render(
      <TrustDrawer open={true} onClose={vi.fn()} tenantId="" />
    );

    expect(screen.getByText('Trust / Health')).toBeInTheDocument();
  });

  it('shows warning severity for vault-manifest-stale', async () => {
    const { getTrustStatus } = await import('@/lib/api');
    vi.mocked(getTrustStatus).mockResolvedValueOnce({
      ...BASE_RESPONSE,
      warnings: ['vault-manifest-stale'],
    });

    render(
      <TrustDrawer open={true} onClose={vi.fn()} tenantId="test-tenant" />
    );

    await waitFor(() => {
      expect(screen.getByText('Issues detected')).toBeInTheDocument();
    });
  });

  it('shows critical severity for zero-byte-db', async () => {
    const { getTrustStatus } = await import('@/lib/api');
    vi.mocked(getTrustStatus).mockResolvedValueOnce({
      ...BASE_RESPONSE,
      warnings: ['zero-byte-db'],
    });

    render(
      <TrustDrawer open={true} onClose={vi.fn()} tenantId="test-tenant" />
    );

    await waitFor(() => {
      expect(screen.getByText('Critical issues detected')).toBeInTheDocument();
    });
  });

  it('Export Snapshot button is disabled with terminal tooltip', async () => {
    render(
      <TrustDrawer open={true} onClose={vi.fn()} tenantId="test-tenant" />
    );

    await waitFor(() => {
      expect(screen.getByText('Healthy')).toBeInTheDocument();
    });

    const snapshotBtn = screen.getByRole('button', { name: /Export Snapshot/i });
    expect(snapshotBtn).toBeDisabled();
    expect(snapshotBtn.title).toContain('awos-snapshot');
  });

  it('shows cleanup preview panel on button click', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        keep: [],
        candidates: [{ id: 'AGE-100', reason: 'no-heartbeat' }],
        counts: { keep: 89, candidate: 376 },
      }),
    } as Response);

    render(
      <TrustDrawer open={true} onClose={vi.fn()} tenantId="test-tenant" />
    );

    await waitFor(() => {
      expect(screen.getByText('Healthy')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Show Cleanup Preview/i }));

    await waitFor(() => {
      expect(screen.getByText('Cleanup Preview')).toBeInTheDocument();
    });
  });
});
