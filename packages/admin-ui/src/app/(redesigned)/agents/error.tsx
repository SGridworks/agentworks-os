'use client';

import { useEffect, useState } from 'react';

export default function ErrorBoundary({
  error,
  reset,
}: { error: Error; reset: () => void }) {
  const [apiHealth, setApiHealth] = useState<'healthy' | 'unhealthy' | 'unknown'>('unknown');
  const [tenant, setTenant] = useState<string>('—');

  // Probe health endpoint
  useEffect(() => {
    async function probe() {
      try {
        const res = await fetch('/api/health');
        setApiHealth(res.ok ? 'healthy' : 'unhealthy');
      } catch {
        setApiHealth('unhealthy');
      }
    }
    probe();
  }, []);

  // Attempt to surface tenant name (if any)
  useEffect(() => {
    async function fetchTenant() {
      try {
        const res = await fetch('/api/tenants');
        if (res.ok) {
          const tenants = await res.json();
          setTenant(tenants[0]?.name ?? '—');
        }
      } catch {
        // tenant fetch failure is fine – we still show fallback
      }
    }
    fetchTenant();
  }, []);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4">
      <h1 className="text-2xl font-semibold text-error mb-2">Error</h1>
      <p className="text-lg text-muted mb-4">Something went wrong.</p>

      <div className="bg-background border border-error rounded-lg p-6 shadow-sm max-w-md">
        <p className="text-sm text-error font-medium mb-2">Last error:</p>
        <pre className="text-xs text-error break-all">{error.message}</pre>

        <p className="text-sm text-muted">Tenant: {tenant}</p>
        <p className="text-sm text-muted">API health: {apiHealth}</p>

        <button
          className="mt-4 btn-primary"
          onClick={reset}
        >
          Retry
        </button>
      </div>
    </div>
  );
}
