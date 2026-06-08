import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import TrustPage from './page';

const mockTrustData = {
  summary: 'healthy' as const,
  checked_at: new Date().toISOString(),
  providers: [
    {
      id: 'openai',
      kind: 'model_host' as const,
      display_name: 'OpenAI',
      status: 'healthy' as const,
      last_ok: new Date().toISOString(),
      latency_ms: 234,
      errors_last_24h: 0,
      endpoint: 'https://api.openai.com/v1/models',
      note: null,
    },
    {
      id: 'pgvector',
      kind: 'vector_store' as const,
      display_name: 'pgvector',
      status: 'degraded' as const,
      last_ok: new Date().toISOString(),
      latency_ms: 1200,
      errors_last_24h: 3,
      endpoint: null,
      note: 'Elevated latency',
    },
  ],
};

const mockTenant = {
  id: 'tenant-abc-123',
  name: 'Test Tenant',
  description: null,
  industry: 'other' as const,
  vaultRoot: '/tmp/vault',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

vi.mock('@/lib/api', () => ({
  getTrustStatus: vi.fn(),
  listTenants: vi.fn(),
}));

vi.mock('@/components/v2/nav', () => ({
  useV2Nav: vi.fn(() => vi.fn()),
}));

vi.mock('@/components/v2/shell', () => ({
  V2Shell: ({ children, active }: { children: React.ReactNode; active: string }) => (
    <div data-testid="v2-shell" data-active={active}>
      {children}
    </div>
  ),
}));

import * as api from '@/lib/api';

describe('TrustPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.listTenants as any).mockResolvedValue([mockTenant]);
    (api.getTrustStatus as any).mockResolvedValue(mockTrustData);
  });

  it('renders the verbose trust page with JSON payload', async () => {
    render(<TrustPage />);

    await waitFor(() => {
      expect(screen.getByTestId('v2-shell')).toHaveAttribute('data-active', 'trust');
    });

    expect(screen.getByText('Trust Layer Verbose View')).toBeInTheDocument();

    await waitFor(() => {
      expect(api.getTrustStatus).toHaveBeenCalledWith(mockTenant.id);
    });

    // JSON payload should be rendered inside <pre>
    const pre = screen.getByText((content) => content.includes('"summary": "healthy"'), { selector: 'pre' });
    expect(pre).toBeInTheDocument();
    expect(pre.textContent).toContain('openai');
    expect(pre.textContent).toContain('pgvector');
  });

  it('shows loading state initially', () => {
    render(<TrustPage />);
    expect(screen.getByText('Loading trust status...')).toBeInTheDocument();
  });

  it('refreshes trust data when Refresh is clicked', async () => {
    render(<TrustPage />);

    await waitFor(() => {
      expect(api.getTrustStatus).toHaveBeenCalledTimes(1);
    });

    const refreshBtn = screen.getByRole('button', { name: /refresh/i });
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(api.getTrustStatus).toHaveBeenCalledTimes(2);
    });
  });

  it('shows a Download JSON button', async () => {
    render(<TrustPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /download json/i })).toBeInTheDocument();
    });
  });

  it('renders no-tenant state when no tenants exist', async () => {
    (api.listTenants as any).mockResolvedValue([]);

    render(<TrustPage />);

    await waitFor(() => {
      expect(screen.getByText('No tenant configured.')).toBeInTheDocument();
    });

    expect(api.getTrustStatus).not.toHaveBeenCalled();
  });

  it('handles API errors gracefully', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    (api.getTrustStatus as any).mockRejectedValue(new Error('Network failure'));

    render(<TrustPage />);

    await waitFor(() => {
      expect(screen.getByText('Network failure')).toBeInTheDocument();
    });

    consoleError.mockRestore();
  });
});
