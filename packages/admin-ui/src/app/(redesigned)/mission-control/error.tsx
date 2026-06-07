'use client';

import { useEffect, useState } from 'react';
import { StatusDot } from '@/components/v2/primitives';
import { listTenants, listCompanies } from '@/lib/api';

export default function MissionControlError({ error, reset }: { error: Error; reset: () => void }) {
  const [tenant, setTenant] = useState<any>(null);
  const [company, setCompany] = useState<any>(null);

  useEffect(() => {
    async function init() {
      try {
        const tenants = await listTenants();
        const firstTenant = tenants[0] ?? null;
        setTenant(firstTenant);
        if (firstTenant) {
          const c = await listCompanies(firstTenant.id);
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
        Tenant: {tenant ? <>{tenant.name} (<code>{tenant.id.slice(0, 6)}...</code>)</> : 'Loading...'}
      </p>
      <p>
        Company: {company ? <>{company.name} (<code>{company.id.slice(0, 6)}...</code>)</> : 'Loading...'}
      </p>
      <button
        onClick={reset}
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
