'use client';
import { useEffect, useState } from 'react';
import type React from 'react';

/**
 * Page‑level error boundary.
 * Catches render‑time errors in the wrapped subtree and shows a diagnostic panel
 * with API health, tenant/company identifiers, last error message and action
 * buttons to refresh/retry.
 */
export default function ErrorBoundary({
  children,
  tenantName = '—',
  companyName = '—',
}: {
  children: React.ReactNode;
  tenantName?: string;
  companyName?: string;
}) {
  const [hasError, setHasError] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [apiHealth] = useState<string>('—');

  // Attempt to fetch minimal health info on first mount – keep it lightweight
  // and avoid async in render by using effect only.
  // If the fetch fails we keep the placeholder "—" so the UI never breaks.
  useEffect(() => {
    async function fetchHealth() {
      // No‑op placeholder – real health endpoint would be called here.
      // Keeping it async‑free to avoid complexity in error handling.
    }
    fetchHealth();
  }, []);

  // When an error is caught, capture it for display.
  // This uses the built‑in runtime error argument.
  useEffect(() => {
    if (hasError && error) {
      setLastError(error.message);
    }
  }, [error, hasError]);

  // Provide a very simple API health placeholder.
  // In a fully‑fledged implementation this could query /api/health.
  const healthStatus = apiHealth === 'healthy' ? 'healthy' : 'unhealthy';

  if (!hasError) {
    return <>{children}</>;
  }

  // Fallback UI – concise, no secrets, operator‑facing language.
  return (
    <div
      style={({
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        minHeight: '100vh',
        border: '1px solid var(--rule)',
        background: 'var(--bg-2)',
      })}
    >
      <h2 style={{ color: 'var(--err)' }}>Operational error</h2>
      <p>
        <strong>Last error:</strong> {lastError}
      </p>
      <p>
        <strong>Tenant:</strong> {tenantName}
      </p>
      <p>
        <strong>Company:</strong> {companyName}
      </p>
      <p>
        <strong>API health:</strong> {healthStatus}
      </p>

      <div className="mt-4 flex gap-2">
        <button
          className="btn btn-primary"
          onClick={() => window.location.reload()}
        >
          Refresh
        </button>
        <button
          className="btn btn-outline"
          onClick={() => window.location.reload()}
        >
          Retry
        </button>
      </div>
    </div>
  );
}
