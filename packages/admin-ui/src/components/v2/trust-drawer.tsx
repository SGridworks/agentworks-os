'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  X,
  CircleCheck,
  CircleAlert,
  CircleX,
  RefreshCw,
  Database,
  FolderOpen,
  Server,
  Shield,
  Users,
  Activity,
  Clock,
  HardDrive,
  Eye,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { getTrustStatus, type TrustStatus, type TrustProvider, type TrustCompany } from '@/lib/api';

interface TrustDrawerProps {
  open: boolean;
  onClose: () => void;
  tenantId: string;
}

// ---------------------------------------------------------------------------
// Warning severity classification
// ---------------------------------------------------------------------------

const CRITICAL_CODES = new Set([
  'zero-byte-db',
  'db-identity-mismatch',
  'missing-expected-company',
  'inspector-exposed',
]);

const WARNING_CODES = new Set([
  'profile-db-path-mismatch',
  'missing-vault-root',
  'no-active-agents',
  'stale-dispatch',
  'duplicate-queued-wakeup',
  'vault-manifest-stale',
]);

type WarningSeverity = 'critical' | 'warning' | 'none';

function warningSeverity(code: string): WarningSeverity {
  if (CRITICAL_CODES.has(code)) return 'critical';
  if (WARNING_CODES.has(code)) return 'warning';
  return 'warning';
}

function worstSeverity(warnings: string[]): WarningSeverity {
  if (warnings.some((w) => CRITICAL_CODES.has(w))) return 'critical';
  if (warnings.length > 0) return 'warning';
  return 'none';
}

function warningLabel(code: string): string {
  const labels: Record<string, string> = {
    'zero-byte-db': 'Database is empty (zero bytes)',
    'db-identity-mismatch': 'Database path identity does not match daemon lock',
    'profile-db-path-mismatch': 'Profile DB path does not match live DB path',
    'missing-expected-company': 'One or more expected companies are missing',
    'inspector-exposed': 'Node inspector is listening — port 9229 is exposed',
    'missing-vault-root': 'Vault root directory is missing',
    'no-active-agents': 'No active agents found',
    'stale-dispatch': 'Stale items in dispatch queue',
    'duplicate-queued-wakeup': 'Duplicate queued wakeup entries detected',
    'vault-manifest-stale': 'Vault manifest has not been updated recently',
  };
  return labels[code] ?? code;
}

// ---------------------------------------------------------------------------
// Provider constants (existing)
// ---------------------------------------------------------------------------

const PROVIDER_KINDS = ['model_host', 'vector_store', 'object_store', 'sidecar', 'rule_pack'];

const KIND_LABELS: Record<string, string> = {
  model_host: 'Model Hosts',
  vector_store: 'Vector Stores',
  object_store: 'Object Stores',
  sidecar: 'Sidecars',
  rule_pack: 'Rule Packs',
};

const STATUS_COLORS = {
  healthy: 'var(--ok)',
  degraded: 'var(--warn)',
  down: 'var(--err)',
};

const STATUS_ICONS = {
  healthy: CircleCheck,
  degraded: CircleAlert,
  down: CircleX,
};

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  const diff = Date.now() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatLatency(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function providerKind(provider: TrustProvider): string {
  if (provider.kind) return provider.kind;
  if (provider.category === 'llm') return 'model_host';
  if (provider.category === 'storage') return 'object_store';
  if (provider.category === 'rules') return 'rule_pack';
  return provider.category ?? 'sidecar';
}

function providerDisplayName(provider: TrustProvider): string {
  return provider.display_name ?? provider.displayName ?? provider.id;
}

function providerLatency(provider: TrustProvider): number | null {
  return provider.latency_ms ?? provider.latencyMs ?? null;
}

function providerNote(provider: TrustProvider): string | null {
  return provider.note ?? provider.error ?? null;
}

function groupProvidersByKind(providers: TrustProvider[]): Record<string, TrustProvider[]> {
  return providers.reduce<Record<string, TrustProvider[]>>((groups, provider) => {
    const kind = providerKind(provider);
    if (!groups[kind]) groups[kind] = [];
    groups[kind]!.push(provider);
    return groups;
  }, {});
}

// ---------------------------------------------------------------------------
// Health band primitives
// ---------------------------------------------------------------------------

function HealthBand({
  severity,
  children,
}: {
  severity: 'ok' | 'warn' | 'err';
  children: React.ReactNode;
}) {
  const styles: Record<string, React.CSSProperties> = {
    ok: {
      background: 'var(--ok-soft)',
      borderLeft: '3px solid var(--ok)',
      color: 'var(--ok)',
    },
    warn: {
      background: 'var(--warn-soft)',
      borderLeft: '3px solid var(--warn)',
      color: 'var(--warn)',
    },
    err: {
      background: 'var(--err-soft)',
      borderLeft: '3px solid var(--err)',
      color: 'var(--err)',
    },
  };
  return (
    <div
      style={{
        ...styles[severity],
        padding: '6px 10px',
        borderRadius: '0 2px 2px 0',
        fontSize: 11,
        fontFamily: "'JetBrains Mono', monospace",
        letterSpacing: '.03em',
        marginTop: 4,
      }}
    >
      {children}
    </div>
  );
}

function SectionHeader({ icon: Icon, label }: { icon: React.ElementType; label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        marginBottom: 6,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '.1em',
        textTransform: 'uppercase',
        color: 'var(--ink-3)',
      }}
    >
      <Icon size={12} />
      {label}
    </div>
  );
}

function FieldRow({ label, value, mono = true }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        padding: '3px 0',
        gap: 8,
      }}
    >
      <span style={{ fontSize: 11, color: 'var(--ink-3)', flexShrink: 0 }}>{label}</span>
      <span
        style={{
          fontSize: 11,
          color: 'var(--ink)',
          fontFamily: mono ? "'JetBrains Mono', monospace" : undefined,
          textAlign: 'right',
          wordBreak: 'break-all',
        }}
      >
        {value}
      </span>
    </div>
  );
}

function BoolPill({ value, trueLabel = 'yes', falseLabel = 'no', trueOk = true }: {
  value: boolean;
  trueLabel?: string;
  falseLabel?: string;
  trueOk?: boolean;
}) {
  const isOk = trueOk ? value : !value;
  return (
    <span
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: '.06em',
        textTransform: 'uppercase',
        padding: '2px 6px',
        borderRadius: 2,
        border: '1px solid',
        background: isOk ? 'var(--ok-soft)' : 'var(--err-soft)',
        color: isOk ? 'var(--ok)' : 'var(--err)',
        borderColor: isOk ? 'var(--ok)' : 'var(--err)',
      }}
    >
      {value ? trueLabel : falseLabel}
    </span>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--bg-2)',
        border: '1px solid var(--rule)',
        borderRadius: 2,
        padding: '10px 12px',
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Issue Cleanup Preview sub-panel
// ---------------------------------------------------------------------------

interface IssuePreviewCounts {
  keep: number;
  candidate: number;
}

interface IssueCandidate {
  id: string;
  reason: string;
}

interface IssuePreviewResponse {
  keep: unknown[];
  candidates: IssueCandidate[];
  counts: IssuePreviewCounts;
}

function CleanupPreviewPanel({
  tenantId,
  onClose,
}: {
  tenantId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<IssuePreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/admin/issue-preview?tenantId=${encodeURIComponent(tenantId)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json() as Promise<IssuePreviewResponse>;
      })
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load preview');
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [tenantId]);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'var(--bg-card)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 24px',
          borderBottom: '1px solid var(--rule)',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: "'Fraunces', serif",
            fontSize: 16,
            fontWeight: 700,
            color: 'var(--ink)',
          }}
        >
          Cleanup Preview
        </span>
        <button className="icon-btn" onClick={onClose} aria-label="Close cleanup preview">
          <X size={18} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--ink-3)', padding: '24px 0' }}>
            <RefreshCw size={16} className="trust-loading-spinner" />
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>Loading preview...</span>
          </div>
        )}
        {error && (
          <div style={{ color: 'var(--err)', fontFamily: "'JetBrains Mono', monospace", fontSize: 12, padding: '24px 0' }}>
            {error}
          </div>
        )}
        {data && (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 8,
                marginBottom: 16,
              }}
            >
              <div style={{ background: 'var(--ok-soft)', border: '1px solid var(--ok)', borderRadius: 2, padding: '10px 12px', textAlign: 'center' }}>
                <div style={{ fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 700, color: 'var(--ok)' }}>
                  {data.counts.keep}
                </div>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--ok)', marginTop: 2 }}>
                  Keep
                </div>
              </div>
              <div style={{ background: 'var(--warn-soft)', border: '1px solid var(--warn)', borderRadius: 2, padding: '10px 12px', textAlign: 'center' }}>
                <div style={{ fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 700, color: 'var(--warn)' }}>
                  {data.counts.candidate}
                </div>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--warn)', marginTop: 2 }}>
                  Candidates
                </div>
              </div>
            </div>

            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '.1em',
                textTransform: 'uppercase',
                color: 'var(--ink-3)',
                marginBottom: 6,
              }}
            >
              Top candidates (first 10)
            </div>

            {data.candidates.slice(0, 10).map((c) => (
              <div
                key={c.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '5px 8px',
                  background: 'var(--bg-2)',
                  border: '1px solid var(--rule)',
                  borderRadius: 2,
                  marginBottom: 3,
                  gap: 8,
                }}
              >
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--ink)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.id}
                </span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: 'var(--ink-3)', flexShrink: 0 }}>
                  {c.reason}
                </span>
              </div>
            ))}

            <div
              style={{
                marginTop: 12,
                padding: '8px 10px',
                background: 'var(--bg-2)',
                border: '1px solid var(--rule)',
                borderRadius: 2,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                color: 'var(--ink-3)',
                letterSpacing: '.03em',
              }}
            >
              Read-only preview. No changes will be made.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider row + group (unchanged from original)
// ---------------------------------------------------------------------------

function ProviderRow({ provider }: { provider: TrustProvider }) {
  const Icon = STATUS_ICONS[provider.status];
  const color = STATUS_COLORS[provider.status];
  const latency = providerLatency(provider);
  const note = providerNote(provider);
  const errorsLast24h = provider.errors_last_24h ?? 0;

  return (
    <div className="trust-provider-row" data-testid="provider-health-row" data-provider-id={provider.id}>
      <div className="trust-provider-icon">
        <Icon size={16} color={color} />
      </div>
      <div className="trust-provider-name">
        {providerDisplayName(provider)}
        {provider.endpoint && (
          <span className="trust-provider-endpoint">
            {provider.endpoint.replace(/^https?:\/\//, '')}
          </span>
        )}
      </div>
      <div className="trust-provider-status">
        <span className={`trust-status-badge trust-status-${provider.status}`}>
          {provider.status}
        </span>
      </div>
      <div className="trust-provider-metrics">
        {latency !== null && (
          <span className="trust-metric">{formatLatency(latency)}</span>
        )}
        {errorsLast24h > 0 && (
          <span className="trust-metric trust-metric-error">
            {errorsLast24h} errors
          </span>
        )}
      </div>
      {note && (
        <div className="trust-provider-note">{note}</div>
      )}
    </div>
  );
}

function ProviderGroup({ kind, providers }: { kind: string; providers: TrustProvider[] }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="trust-provider-group">
      <button
        className="trust-group-header"
        onClick={() => setCollapsed(!collapsed)}
        aria-expanded={!collapsed}
      >
        <span className="trust-group-title">{KIND_LABELS[kind] ?? kind}</span>
        <span className="trust-group-count">{providers.length}</span>
        <span className={`trust-group-chevron ${collapsed ? 'collapsed' : ''}`}>›</span>
      </button>
      {!collapsed && (
        <div className="trust-group-content">
          {providers.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Companies table
// ---------------------------------------------------------------------------

function CompaniesSection({ companies }: { companies: TrustCompany[] }) {
  const missing = companies.filter((c) => c.expected && !c.present);
  return (
    <>
      {missing.length > 0 && (
        <HealthBand severity="err">
          {missing.length} expected {missing.length === 1 ? 'company' : 'companies'} missing
        </HealthBand>
      )}
      <div style={{ marginTop: 6 }}>
        {companies.map((c) => (
          <div
            key={c.name}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '3px 0',
              gap: 8,
            }}
          >
            <span style={{ fontSize: 11, color: c.expected && !c.present ? 'var(--err)' : 'var(--ink)', fontFamily: "'JetBrains Mono', monospace" }}>
              {c.name}
            </span>
            <span
              style={{
                fontSize: 9,
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 600,
                letterSpacing: '.06em',
                textTransform: 'uppercase',
                padding: '2px 6px',
                borderRadius: 2,
                border: '1px solid',
                background: c.present ? 'var(--ok-soft)' : 'var(--err-soft)',
                color: c.present ? 'var(--ok)' : 'var(--err)',
                borderColor: c.present ? 'var(--ok)' : 'var(--err)',
                flexShrink: 0,
              }}
            >
              {c.present ? 'present' : 'missing'}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Collapsible section wrapper
// ---------------------------------------------------------------------------

function CollapsibleSection({
  icon: Icon,
  label,
  defaultOpen = true,
  children,
}: {
  icon: React.ElementType;
  label: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Section>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          marginBottom: open ? 6 : 0,
        }}
        aria-expanded={open}
      >
        <Icon size={12} color="var(--ink-3)" />
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '.1em',
            textTransform: 'uppercase',
            color: 'var(--ink-3)',
            flex: 1,
            textAlign: 'left',
          }}
        >
          {label}
        </span>
        {open ? <ChevronDown size={12} color="var(--ink-4)" /> : <ChevronRight size={12} color="var(--ink-4)" />}
      </button>
      {open && children}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Main drawer
// ---------------------------------------------------------------------------

export function TrustDrawer({ open, onClose, tenantId }: TrustDrawerProps) {
  const [trustData, setTrustData] = useState<TrustStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now());
  const [showCleanup, setShowCleanup] = useState(false);

  const fetchTrustData = useCallback(
    async (fresh = false) => {
      if (!tenantId) return;
      setLoading(true);
      setError(null);
      try {
        const data = await getTrustStatus(tenantId, fresh);
        setTrustData(data);
        setLastRefresh(Date.now());
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch trust status');
      } finally {
        setLoading(false);
      }
    },
    [tenantId],
  );

  useEffect(() => {
    if (open) {
      fetchTrustData();
    }
  }, [open, tenantId, fetchTrustData]);

  useEffect(() => {
    if (!open) return;
    const interval = setInterval(() => { fetchTrustData(); }, 30000);
    return () => clearInterval(interval);
  }, [open, tenantId, fetchTrustData]);

  if (!open) return null;

  const groupedProviders = trustData ? groupProvidersByKind(trustData.providers) : {};
  const warnings = trustData?.warnings ?? [];
  const severity = worstSeverity(warnings);

  const overallLabel =
    severity === 'none'
      ? 'Healthy'
      : severity === 'critical'
      ? 'Critical issues detected'
      : 'Issues detected';
  const summaryCls =
    severity === 'none'
      ? 'trust-summary-healthy'
      : severity === 'critical'
      ? 'trust-summary-down'
      : 'trust-summary-degraded';

  const t = trustData;
  const hasEnriched = !!(t?.daemon || t?.db || t?.vault || t?.profile || t?.companies || t?.agents || t?.dispatch || t?.backup || t?.inspector);

  return (
	    <div className="trust-drawer-backdrop" data-testid="trust-drawer-backdrop" onClick={onClose} role="presentation">
	      <div className="trust-drawer" data-testid="trust-drawer" style={{ position: 'relative', width: 440 }} onClick={(e) => e.stopPropagation()}>

        {/* Cleanup preview panel (overlay) */}
        {showCleanup && (
          <CleanupPreviewPanel
            tenantId={tenantId}
            onClose={() => setShowCleanup(false)}
          />
        )}

        <div className="trust-drawer-header">
          <div className="trust-drawer-title">
            <h3>Trust / Health</h3>
            {trustData && (
              <span className="trust-last-check">
                Refreshed {formatRelativeTime(new Date(lastRefresh).toISOString())}
              </span>
            )}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <div className="trust-drawer-content">
          {loading && !trustData && (
            <div className="trust-loading">
              <RefreshCw size={24} className="trust-loading-spinner" />
              <span>Loading trust status...</span>
            </div>
          )}

          {error && (
            <div className="trust-error">
              <CircleX size={24} color="var(--err)" />
              <span>{error}</span>
              <button className="btn btn-sm" onClick={() => fetchTrustData()}>
                Retry
              </button>
            </div>
          )}

          {trustData && (
            <>
              {/* 1. Overall health */}
              <div className="trust-summary">
                <div className={`trust-summary-status ${summaryCls}`}>
                  {overallLabel}
                </div>
              </div>

              {/* 2. Daemon */}
              {t?.daemon && (
                <CollapsibleSection icon={Server} label="Daemon">
                  <FieldRow label="PID" value={String(t.daemon.pid)} />
                  <FieldRow label="Version" value={t.daemon.version} />
                  <FieldRow label="Started" value={formatRelativeTime(t.daemon.startedAt)} />
                  <FieldRow label="Uptime" value={formatUptime(t.daemon.uptimeS)} />
                </CollapsibleSection>
              )}

              {/* 3. Database */}
              {t?.db && (
                <CollapsibleSection icon={Database} label="Database">
                  {t.db.sizeBytes === 0 && (
                    <HealthBand severity="err">Database is empty (zero bytes)</HealthBand>
                  )}
                  <FieldRow label="Path" value={t.db.path} />
                  <FieldRow label="Size" value={formatBytes(t.db.sizeBytes)} />
                  <FieldRow
                    label="Profile"
                    value={<BoolPill value={t.db.usingProfile} trueLabel="aligned" falseLabel="mismatch" trueOk />}
                    mono={false}
                  />
                  <FieldRow
                    label="Writable"
                    value={<BoolPill value={t.db.writable} trueLabel="yes" falseLabel="read-only" trueOk />}
                    mono={false}
                  />
                  {t.db.identity && (
                    <>
                      <FieldRow
                        label="Identity"
                        value={
                          <BoolPill
                            value={t.db.identity.matchesDaemonLock !== false}
                            trueLabel={t.db.identity.matchesDaemonLock === null ? 'unlocked' : 'matched'}
                            falseLabel="mismatch"
                            trueOk
                          />
                        }
                        mono={false}
                      />
                      {t.db.identity.current && <FieldRow label="Current ID" value={t.db.identity.current} />}
                      {t.db.identity.daemonLock && <FieldRow label="Lock ID" value={t.db.identity.daemonLock} />}
                    </>
                  )}
                </CollapsibleSection>
              )}

              {/* 4. Profile */}
              {t?.profile && (
                <CollapsibleSection icon={Shield} label="Profile">
                  <FieldRow
                    label="Loaded"
                    value={<BoolPill value={t.profile.loaded} trueLabel="yes" falseLabel="no" trueOk />}
                    mono={false}
                  />
                  {t.profile.path && <FieldRow label="Path" value={t.profile.path} />}
                  {t.profile.version !== null && <FieldRow label="Version" value={String(t.profile.version)} />}
                  {t.profile.drift.length > 0 && (
                    <HealthBand severity="warn">
                      Profile drift: {t.profile.drift.join(', ')}
                    </HealthBand>
                  )}
                </CollapsibleSection>
              )}

              {/* 5. Companies */}
              {t?.companies && t.companies.length > 0 && (
                <CollapsibleSection icon={Users} label={`Companies (${t.companies.length})`}>
                  <CompaniesSection companies={t.companies} />
                </CollapsibleSection>
              )}

              {/* 6. Agents */}
              {t?.agents && (
                <CollapsibleSection icon={Activity} label="Agents">
                  {t.agents.active === 0 && (
                    <HealthBand severity="warn">No active agents</HealthBand>
                  )}
                  <FieldRow label="Active" value={String(t.agents.active)} />
                  <FieldRow label="Paused" value={String(t.agents.paused)} />
                  <FieldRow label="Retired" value={String(t.agents.retired)} />
                </CollapsibleSection>
              )}

              {/* 7. Dispatch */}
              {t?.dispatch && (
                <CollapsibleSection icon={Clock} label="Dispatch Queue">
                  {(t.dispatch.stale > 0 || t.dispatch.duplicateWakeups > 0) && (
                    <HealthBand severity="warn">
                      {t.dispatch.stale > 0 && `${t.dispatch.stale} stale`}
                      {t.dispatch.stale > 0 && t.dispatch.duplicateWakeups > 0 && ' · '}
                      {t.dispatch.duplicateWakeups > 0 && `${t.dispatch.duplicateWakeups} duplicate wakeups`}
                    </HealthBand>
                  )}
                  <FieldRow label="Queued" value={String(t.dispatch.queued)} />
                  <FieldRow label="Dispatched" value={String(t.dispatch.dispatched)} />
                  <FieldRow label="Stale" value={String(t.dispatch.stale)} />
                  <FieldRow label="Duplicate wakeups" value={String(t.dispatch.duplicateWakeups)} />
                </CollapsibleSection>
              )}

              {/* 8. Backup */}
              {t?.backup && (
                <CollapsibleSection icon={HardDrive} label="Backup">
                  <FieldRow label="Backup dir" value={t.backup.backupDir} />
                  <FieldRow
                    label="Latest snapshot"
                    value={t.backup.latestSnapshot ? formatRelativeTime(t.backup.latestSnapshot) : '—'}
                  />
                  <FieldRow
                    label="Verified at"
                    value={t.backup.latestVerifiedAt ? formatRelativeTime(t.backup.latestVerifiedAt) : '—'}
                  />
                </CollapsibleSection>
              )}

              {/* 9. Inspector */}
              {t?.inspector !== undefined && (
                <CollapsibleSection icon={Eye} label="Inspector">
                  {t.inspector.listening ? (
                    <HealthBand severity="err">
                      EXPOSED — Node inspector listening on 127.0.0.1:9229
                    </HealthBand>
                  ) : (
                    <HealthBand severity="ok">Closed — inspector not listening</HealthBand>
                  )}
                </CollapsibleSection>
              )}

              {/* 10. Vault */}
              {t?.vault && (
                <CollapsibleSection icon={FolderOpen} label="Vault">
                  {warnings.includes('vault-manifest-stale') && (
                    <HealthBand severity="warn">Vault manifest has not been updated recently</HealthBand>
                  )}
                  <FieldRow label="Path" value={t.vault.path} />
                  <FieldRow label="Files" value={String(t.vault.fileCount)} />
                  <FieldRow
                    label="Manifest updated"
                    value={formatRelativeTime(t.vault.manifestUpdatedAt)}
                  />
                </CollapsibleSection>
              )}

              {/* 11. Providers (existing, unchanged rendering) */}
              {trustData.providers.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <SectionHeader icon={Server} label="Providers" />
                  <div className="trust-providers">
                    {PROVIDER_KINDS.map((kind) => {
                      const providers = groupedProviders[kind] ?? [];
                      if (providers.length === 0) return null;
                      return <ProviderGroup key={kind} kind={kind} providers={providers} />;
                    })}
                  </div>
                </div>
              )}

              {/* Fallback summary for non-enriched response */}
              {!hasEnriched && (
                <div className="trust-summary">
                  <div className={`trust-summary-status trust-summary-${trustData.summary}`}>
                    {trustData.summary === 'healthy'
                      ? 'All systems operational'
                      : trustData.summary === 'degraded'
                      ? 'Degraded performance'
                      : 'Service disruption'}
                  </div>
                </div>
              )}

              {/* 12. Warnings */}
              {warnings.length > 0 && (
                <Section>
                  <SectionHeader icon={AlertTriangle} label={`Warnings (${warnings.length})`} />
                  <ul style={{ margin: 0, padding: '0 0 0 16px', listStyle: 'disc' }}>
                    {warnings.map((code) => {
                      const sev = warningSeverity(code);
                      return (
                        <li
                          key={code}
                          style={{
                            fontSize: 11,
                            fontFamily: "'JetBrains Mono', monospace",
                            color: sev === 'critical' ? 'var(--err)' : 'var(--warn)',
                            padding: '2px 0',
                          }}
                        >
                          {warningLabel(code)}
                        </li>
                      );
                    })}
                  </ul>
                </Section>
              )}
            </>
          )}
        </div>

        {/* 13. Footer buttons */}
        <div className="trust-drawer-footer" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => fetchTrustData(true)}
            disabled={loading}
            title="Force-refresh, bypassing the 5s cache"
          >
            <RefreshCw size={14} className={loading ? 'trust-loading-spinner' : ''} />
            Refresh
          </button>

          {/* Export Snapshot: disabled — use CLI */}
          <button
            className="btn btn-sm btn-ghost"
            disabled
            title="Run `awos-snapshot` from your terminal"
            style={{ opacity: 0.5, cursor: 'not-allowed' }}
          >
            <HardDrive size={14} />
            Export Snapshot
          </button>

          <button
            className="btn btn-sm btn-ghost"
            onClick={() => setShowCleanup(true)}
            disabled={!tenantId || loading}
          >
            <Eye size={14} />
            Show Cleanup Preview
          </button>
        </div>
      </div>
    </div>
  );
}
