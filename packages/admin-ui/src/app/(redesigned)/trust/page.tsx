'use client';

import { useCallback, useEffect, useState } from 'react';
import { V2Shell } from '@/components/v2/shell';
import { useV2Nav } from '@/components/v2/nav';
import { getTrustStatus, listTenants, type TrustStatus, type Tenant } from '@/lib/api';
import { RefreshCw, ExternalLink } from 'lucide-react';

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const SUMMARY_TEXT: Record<string, string> = {
  healthy: 'All systems operational',
  degraded: 'Degraded performance',
  down: 'Service disruption',
};

const SUMMARY_COLOR: Record<string, string> = {
  healthy: 'var(--success)',
  degraded: 'var(--warn)',
  down: 'var(--error)',
};

export default function TrustPage() {
  const navigate = useV2Nav();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [tenantLoaded, setTenantLoaded] = useState(false);
  const [trustData, setTrustData] = useState<TrustStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listTenants()
      .then((tenants) => {
        if (!cancelled) setTenant(tenants[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setTenant(null);
      })
      .finally(() => {
        if (!cancelled) setTenantLoaded(true);
      });
    return () => { cancelled = true; };
  }, []);

  const fetchData = useCallback(async () => {
    if (!tenant) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getTrustStatus(tenant.id);
      setTrustData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch trust status');
    } finally {
      setLoading(false);
    }
  }, [tenant]);

  useEffect(() => {
    if (!tenantLoaded) return;
    if (!tenant) {
      setLoading(false);
      return;
    }
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [tenantLoaded, tenant, fetchData]);

  const summaryText = trustData ? (SUMMARY_TEXT[trustData.summary] ?? trustData.summary) : '—';
  const summaryColor = trustData ? (SUMMARY_COLOR[trustData.summary] ?? 'var(--ink-3)') : 'var(--ink-3)';

  return (
    <V2Shell active="trust" onNav={navigate}>
      <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto' }}>
        <div>
          <div className="eyebrow">SYSTEM · TRUST LAYER</div>
          <div className="serif" style={{ fontSize: 30, letterSpacing: '-0.018em', marginTop: 4 }}>
            Trust Layer Verbose View
          </div>
          <div style={{ color: 'var(--ink-3)', fontSize: 13, maxWidth: '62ch', marginTop: 6 }}>
            Complete trust layer payload for debugging and bug reports.
          </div>
        </div>

        {error && (
          <div style={{ fontSize: 12, color: 'var(--err)', padding: '12px 16px', background: 'var(--bg-2)', borderRadius: 4 }}>
            {error}
          </div>
        )}

        {tenantLoaded && !tenant && !loading && (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--ink-3)' }}>
            No tenant configured.
          </div>
        )}

        {loading && !trustData ? (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--ink-3)' }}>
            <RefreshCw size={24} className="trust-loading-spinner" />
            <div style={{ marginTop: 12 }}>Loading trust status...</div>
          </div>
        ) : trustData ? (
          <div className="card" style={{ padding: '16px', background: 'var(--bg-1)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                Complete trust layer payload — suitable for screenshots when filing daemon bugs
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={fetchData}
                  disabled={loading}
                >
                  <RefreshCw size={14} className={loading ? 'trust-loading-spinner' : ''} />
                  Refresh
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    const blob = new Blob([JSON.stringify(trustData, null, 2)], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `trust-layer-${new Date().toISOString().slice(0, 19)}.json`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                  }}
                >
                  <ExternalLink size={14} />
                  Download JSON
                </button>
              </div>
            </div>
            <pre style={{
              margin: 0,
              padding: 12,
              background: 'var(--bg-0)',
              border: '1px solid var(--rule)',
              borderRadius: 4,
              fontSize: 11,
              maxHeight: 'calc(100vh - 300px)',
              overflow: 'auto',
              lineHeight: 1.4,
            }}>
              {JSON.stringify(trustData, null, 2)}
            </pre>
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--ink-3)' }}>
              Last updated: {formatRelativeTime(trustData.checked_at)} |
              Status: <span style={{ color: summaryColor, fontWeight: 600 }}>{summaryText}</span> |
              Providers: {trustData.providers.length}
            </div>
          </div>
        ) : null}
      </div>
    </V2Shell>
  );
}
