'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { StatusDot } from '@/components/v2/primitives';
import { listTenants, listCompanies } from '@/lib/api';
import { V2Shell } from '@/components/v2/shell';

export default function MissionControlError({ error, resetErrorBoundary }: { error: Error; resetErrorBoundary: () => void }) {
  const router = useRouter();
  const [tenant, setTenant] = useState<any>(null);
  const [company, setCompany] = useState<any>(null);

  useEffect(() => {
    async function init() {
      try {
        const t = await listTenants();
        setTenant(t[0] ?? null);
        if (tenant) {
          const c = await listCompanies(tenant.id);
          setCompany(c[0] ?? null);
        }
      } catch (e) {
        // Keep tenant/company as null if fetch fails
      } finally {}
    }
    init();
  }, []);

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      textAlign: 'center',
      color: 'var(--ink-3)'
    }}>
      <StatusDot kind="error" />
      <h1 style={{ marginTop: '20px' }}>Mission Control Unavailable</h1>
      <p style={{ margin: '12px 0' }}>
        Error: <strong>{error.message}</strong>
      </p>
      <p>
        Tenant: {tenant ? `${tenant.name} (<code>${tenant.id.slice(0, 6)}...</code>)` : 'Loading…'}
      </p>
      <p>
        Company: {company ? `${company.name} (<code>${company.id.slice(0, 6)}...</code>)` : 'Loading…'}
      </p>
      <button
        onClick={resetErrorBoundary}
        style={{
          marginTop: '24px',
          padding: '8px 16px',
          background: 'var(--accent)',
          color: '#fff',
          border: 'none',
          borderRadius: 4,
          cursor: 'pointer'
        }}
      >
        Refresh
      </button>
    </div>
  );
}