'use client';

import { useEffect, useMemo, useState } from 'react';
import { V2Shell } from '@/components/v2/shell';
import { useV2Nav } from '@/components/v2/nav';
import {
  listTenants,
  getVaultLint,
  getVaultLintDiff,
  getHotCache,
  rebuildHotCache,
  ALL_VAULT_LINT_KINDS,
  type Tenant,
  type VaultLintDiff,
  type VaultLintReport,
  type VaultLintFinding,
  type VaultLintKind,
  type VaultLintSeverity,
  type HotCacheRead,
} from '@/lib/api';
import { RefreshCw, FileText, AlertTriangle, Info, CheckCircle2 } from 'lucide-react';

const KIND_LABEL: Record<VaultLintKind, string> = {
  orphan_page: 'Orphan',
  dead_link: 'Dead link',
  frontmatter_gap: 'Frontmatter gap',
  empty_section: 'Empty section',
  kebab_case_violation: 'Filename',
  source_drift: 'Source drift',
  contradiction_flagged: 'Contradiction',
  confidence_low: 'Low confidence',
  page_oversize: 'Oversize',
  tag_audit: 'Tag audit',
  log_rotation_due: 'Log rotation',
};

const KIND_ORDER = [
  'dead_link',
  'frontmatter_gap',
  'kebab_case_violation',
  'source_drift',
  'contradiction_flagged',
  'confidence_low',
  'page_oversize',
  'tag_audit',
  'log_rotation_due',
  'orphan_page',
  'empty_section',
] satisfies VaultLintKind[];

const SEVERITY_ORDER: VaultLintSeverity[] = ['error', 'warn', 'info'];

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '—';
  const dt = (Date.now() - t) / 1000;
  if (dt < 60) return `${Math.floor(dt)}s ago`;
  if (dt < 3600) return `${Math.floor(dt / 60)}m ago`;
  if (dt < 86400) return `${Math.floor(dt / 3600)}h ago`;
  return `${Math.floor(dt / 86400)}d ago`;
}

export default function VaultHealthPage() {
  const navigate = useV2Nav();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [lint, setLint] = useState<VaultLintReport | null>(null);
  const [diff, setDiff] = useState<VaultLintDiff | null>(null);
  const [hot, setHot] = useState<HotCacheRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<VaultLintKind | 'all'>('all');

  useEffect(() => {
    listTenants()
      .then((ts) => setTenant(ts[0] ?? null))
      .catch((e) => setError(String(e)));
  }, []);

  async function refreshAll(t: Tenant) {
    setBusy(true);
    setError(null);
    try {
      const [d, h] = await Promise.all([getVaultLintDiff(t.id), getHotCache(t.id)]);
      const r = await getVaultLint(t.id);
      setDiff(d);
      setLint(r);
      setHot(h);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (tenant) refreshAll(tenant);
  }, [tenant]);

  async function handleRebuild() {
    if (!tenant) return;
    setBusy(true);
    setError(null);
    try {
      await rebuildHotCache(tenant.id);
      const h = await getHotCache(tenant.id);
      setHot(h);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const filteredFindings = useMemo(() => {
    if (!lint) return [];
    if (filter === 'all') return lint.findings;
    return lint.findings.filter((f) => f.kind === filter);
  }, [lint, filter]);

  return (
    <V2Shell active="vault-health" onNav={navigate}>
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflow: 'auto' }}>
        <Header
          tenantName={tenant?.name ?? '—'}
          ranAt={lint?.ranAt ?? null}
          busy={busy}
          onRefresh={() => tenant && refreshAll(tenant)}
        />

        {error && (
          <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--err)', border: '1px solid var(--err)', borderRadius: 6 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
          <HotCacheCard hot={hot} busy={busy} onRebuild={handleRebuild} />
          <LintSummaryCard lint={lint} diff={diff} filter={filter} setFilter={setFilter} />
        </div>

        <FindingsTable findings={filteredFindings} pageCount={lint?.pageCount ?? 0} filter={filter} />
      </div>
    </V2Shell>
  );
}

function Header({
  tenantName,
  ranAt,
  busy,
  onRefresh,
}: {
  tenantName: string;
  ranAt: string | null;
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
      <div>
        <div style={{ fontSize: 20, fontWeight: 600 }}>Vault Health</div>
        <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
          {tenantName} · {ranAt ? `last ran ${relTime(ranAt)}` : 'never run'}
        </div>
      </div>
      <button
        onClick={onRefresh}
        disabled={busy}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 12px',
          borderRadius: 6,
          border: '1px solid var(--rule)',
          background: 'var(--bg-1)',
          fontSize: 13,
          cursor: busy ? 'wait' : 'pointer',
        }}
      >
        <RefreshCw size={14} className={busy ? 'spin' : ''} />
        {busy ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  );
}

function HotCacheCard({
  hot,
  busy,
  onRebuild,
}: {
  hot: HotCacheRead | null;
  busy: boolean;
  onRebuild: () => void;
}) {
  return (
    <div style={cardStyle}>
      <div style={cardHeaderStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <FileText size={14} />
          <strong>Hot Cache</strong>
        </div>
        <button
          onClick={onRebuild}
          disabled={busy}
          style={smallBtnStyle(busy)}
        >
          {busy ? 'Rebuilding…' : 'Rebuild'}
        </button>
      </div>
      <KV k="Status" v={hot?.existed ? 'present' : 'missing'} />
      <KV k="Words" v={String(hot?.words ?? 0)} />
      <KV k="Updated" v={relTime(hot?.updatedAt ?? null)} />
      <div style={{ marginTop: 12, fontSize: 11, color: 'var(--ink-3)' }}>Preview</div>
      <pre
        style={{
          marginTop: 4,
          padding: 8,
          maxHeight: 220,
          overflow: 'auto',
          fontSize: 11,
          fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
          background: 'var(--bg-1)',
          border: '1px solid var(--rule)',
          borderRadius: 4,
          whiteSpace: 'pre-wrap',
          margin: 0,
        }}
      >
        {hot?.body || '(empty)'}
      </pre>
    </div>
  );
}

function LintSummaryCard({
  lint,
  diff,
  filter,
  setFilter,
}: {
  lint: VaultLintReport | null;
  diff: VaultLintDiff | null;
  filter: VaultLintKind | 'all';
  setFilter: (k: VaultLintKind | 'all') => void;
}) {
  const totals = lint?.totals;
  const total = lint ? lint.findings.length : 0;
  const severityTotals = useMemo(() => {
    const counts: Record<VaultLintSeverity, number> = { error: 0, warn: 0, info: 0 };
    for (const finding of lint?.findings ?? []) counts[finding.severity] += 1;
    return counts;
  }, [lint]);
  const executed = lint?.executed ?? [];
  return (
    <div style={cardStyle}>
      <div style={cardHeaderStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <AlertTriangle size={14} />
          <strong>Lint Summary</strong>
        </div>
        <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{lint?.pageCount ?? 0} pages</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginBottom: 10 }}>
        <KV k="Run" v={lint?.runId ?? '—'} />
        <KV k="Executed" v={`${executed.length}/11`} />
        <KV k="Baseline" v={diff?.previousRunId ? diff.previousRunId : diff?.baselineReason ?? '—'} />
        <KV
          k="Diff"
          v={diff?.summary ? `+${diff.summary.added} / -${diff.summary.removed} / ${diff.summary.unchanged}` : '—'}
        />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {SEVERITY_ORDER.map((severity) => (
          <span key={severity} style={severityBadgeStyle(severity)}>
            {severity}: {severityTotals[severity]}
          </span>
        ))}
      </div>
      <Chip
        active={filter === 'all'}
        onClick={() => setFilter('all')}
        label={`All (${total})`}
      />
      {KIND_ORDER.map((k) => (
        <Chip
          key={k}
          active={filter === k}
          onClick={() => setFilter(k)}
          label={`${KIND_LABEL[k]} (${totals?.[k] ?? 0})`}
        />
      ))}
      {total === 0 && lint && (
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ok)', fontSize: 12 }}>
          <CheckCircle2 size={14} />
          Vault is clean.
        </div>
      )}
    </div>
  );
}

function FindingsTable({
  findings,
  pageCount,
  filter,
}: {
  findings: VaultLintFinding[];
  pageCount: number;
  filter: VaultLintKind | 'all';
}) {
  return (
    <div style={cardStyle}>
      <div style={cardHeaderStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Info size={14} />
          <strong>Findings</strong>
        </div>
        <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
          {findings.length} {filter === 'all' ? 'finding' : KIND_LABEL[filter] ?? filter}
          {findings.length === 1 ? '' : 's'} · {pageCount} pages scanned
        </span>
      </div>
      {findings.length === 0 ? (
        <div style={{ padding: '12px 0', fontSize: 12, color: 'var(--ink-3)' }}>No findings.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--ink-3)' }}>
              <th style={th}>Severity</th>
              <th style={th}>Kind</th>
              <th style={th}>Path</th>
              <th style={th}>Message</th>
            </tr>
          </thead>
          <tbody>
            {findings.map((f, i) => (
              <tr key={`${f.path}-${i}`} style={{ borderTop: '1px solid var(--rule)' }}>
                <td style={td}>
                  <span style={severityBadgeStyle(f.severity)}>
                    {f.severity}
                  </span>
                </td>
                <td style={td}>{KIND_LABEL[f.kind] ?? f.kind}</td>
                <td style={{ ...td, fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>{f.path}</td>
                <td style={td}>
                  {f.message}
                  {f.detail && (
                    <div style={{ marginTop: 2, color: 'var(--ink-3)', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>
                      {f.detail}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
      <span style={{ color: 'var(--ink-3)' }}>{k}</span>
      <span style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>{v}</span>
    </div>
  );
}

function Chip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        marginRight: 6,
        marginTop: 6,
        padding: '4px 10px',
        borderRadius: 999,
        border: `1px solid ${active ? 'var(--accent)' : 'var(--rule)'}`,
        background: active ? 'var(--accent)' : 'var(--bg-1)',
        color: active ? 'var(--bg-0)' : 'var(--ink-1)',
        fontSize: 11,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--rule)',
  borderRadius: 8,
  padding: 14,
  background: 'var(--bg-0)',
};

const cardHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 8,
  fontSize: 13,
};

const th: React.CSSProperties = { padding: '6px 8px', fontWeight: 500 };
const td: React.CSSProperties = { padding: '6px 8px', verticalAlign: 'top' };

function severityBadgeStyle(severity: VaultLintSeverity): React.CSSProperties {
  if (severity === 'error') {
    return {
      padding: '2px 6px',
      borderRadius: 3,
      fontSize: 10,
      textTransform: 'uppercase',
      background: 'var(--err-soft, #fee2e2)',
      color: 'var(--err, #b91c1c)',
    };
  }
  if (severity === 'warn') {
    return {
      padding: '2px 6px',
      borderRadius: 3,
      fontSize: 10,
      textTransform: 'uppercase',
      background: 'var(--warn-soft, #fff3cd)',
      color: 'var(--warn, #b58900)',
    };
  }
  return {
    padding: '2px 6px',
    borderRadius: 3,
    fontSize: 10,
    textTransform: 'uppercase',
    background: 'var(--bg-1)',
    color: 'var(--ink-3)',
  };
}

function smallBtnStyle(busy: boolean): React.CSSProperties {
  return {
    padding: '4px 10px',
    borderRadius: 4,
    border: '1px solid var(--rule)',
    background: 'var(--bg-1)',
    fontSize: 12,
    cursor: busy ? 'wait' : 'pointer',
  };
}
