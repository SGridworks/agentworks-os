'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  listTenants,
  listCompanies,
  listCompanyAgents,
  listCompanyIssues,
  listCompanyRuns,
  listIssueComments,
  addIssueComment,
  wakeAgent,
  type ExecutionCompany,
  type ExecutionAgent,
  type ExecutionIssue,
  type ExecutionRun,
  type IssueComment,
} from '@/lib/api';
import { V2Shell } from '@/components/v2/shell';
import { StatusDot, StatusPill, relTime, fmtMoney, type StatusKind } from '@/components/v2/primitives';
import { useV2Nav } from '@/components/v2/nav';
import { ArrowLeft, Pause, Zap, Plus, Power, Edit } from 'lucide-react';

const POLL_MS = 5000;
const RECENT_DONE_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_STALE_MS = 5 * 60_000;

type Selection =
  | { kind: 'agent'; id: string }
  | { kind: 'issue'; id: string }
  | { kind: 'none' };

export default function CompanyDetailV2({ params }: { params: { companyId: string } }) {
  const router = useRouter();
  const navigate = useV2Nav();
  const [company, setCompany] = useState<ExecutionCompany | null>(null);
  const [agents, setAgents] = useState<ExecutionAgent[]>([]);
  const [issues, setIssues] = useState<ExecutionIssue[]>([]);
  const [runs, setRuns] = useState<ExecutionRun[]>([]);
  const [selected, setSelected] = useState<Selection>({ kind: 'none' });
  const [hoverAgentId, setHoverAgentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const tenants = await listTenants();
        const t = tenants[0];
        if (!t) {
          if (!cancelled) setError('No tenants registered.');
          return;
        }
        const companies = await listCompanies(t.id);
        const c = companies.find((x) => x.id === params.companyId) ?? null;
        if (!cancelled) setCompany(c);
        if (!c) return;
        const [a, i, r] = await Promise.all([
          listCompanyAgents(params.companyId),
          listCompanyIssues(params.companyId),
          listCompanyRuns(params.companyId).catch(() => [] as ExecutionRun[]),
        ]);
        if (!cancelled) {
          setAgents(a);
          setIssues(i);
          setRuns(r);
          setError(null);
          setSelected((prev) => {
            const nextAgent = a.find((agent) => agent.status !== 'retired');
            if (prev.kind === 'agent' && !a.some((agent) => agent.status !== 'retired' && agent.id === prev.id)) {
              return nextAgent ? { kind: 'agent', id: nextAgent.id } : { kind: 'none' };
            }
            return prev.kind === 'none' && nextAgent ? { kind: 'agent', id: nextAgent.id } : prev;
          });
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_MS);
      }
    }
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [params.companyId]);

  const triageCount = issues.filter((i) => i.status === 'triage').length;
  const operationalAgents = agents.filter((a) => a.status !== 'retired');
  const retiredAgentCount = agents.length - operationalAgents.length;
  const selectedAgent = selected.kind === 'agent' ? operationalAgents.find((a) => a.id === selected.id) ?? null : null;
  const selectedIssue = selected.kind === 'issue' ? issues.find((i) => i.id === selected.id) ?? null : null;
  const doneIssues = issues.filter((i) => i.status === 'done');
  const recentDoneIssues = doneIssues.filter(isRecentDoneIssue);
  const hiddenDoneCount = doneIssues.length - recentDoneIssues.length;
  const recentRuns = runs.filter(isRecentRun);
  const hiddenRunCount = runs.length - recentRuns.length;

  return (
    <V2Shell
      active="mission-control"
      onNav={navigate}
      tenant={{ mark: company ? company.name.slice(0, 2).toUpperCase() : '··', name: company?.name ?? 'Loading…' }}
      triageCount={triageCount}
    >
      <div className="poll-bar" />

      <div className="pageheader" style={{ paddingBottom: 14, borderBottom: '1px solid var(--rule)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button
            className="icon-btn"
            onClick={() => router.push('/mission-control')}
            aria-label="Back"
            style={{ border: '1px solid var(--rule-2)' }}
          >
            <ArrowLeft size={14} strokeWidth={1.6} />
          </button>
          <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>
              MISSION CONTROL · co/{company?.slug ?? '…'}
            </div>
            <h1 className="pageheader-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <StatusDot kind={agents.some((a) => a.status === 'active' || a.status === 'running') ? 'success' : 'muted'} pulse size={8} />
              {company?.name ?? 'Loading…'}
            </h1>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '.06em', alignSelf: 'center', marginRight: 8 }}>
            POLLING · 5s
          </span>
          <button
            className="btn"
            disabled
            title="Bulk pause not yet wired — pause individual agents from the roster"
          >
            <Pause size={13} strokeWidth={1.6} />Pause company
          </button>
          <CompanyWakeAllButton agents={agents} />
        </div>
      </div>

      {error && (
        <div style={{ margin: '12px 28px' }}>
          <StatusPill kind="error">{error}</StatusPill>
        </div>
      )}

      {/* 3-col grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr 340px', gap: 0, flex: 1, overflow: 'hidden', minHeight: 0 }}>
        {/* LEFT — agent roster */}
        <div style={{ borderRight: '1px solid var(--rule)', overflowY: 'auto', background: 'var(--bg-card)' }}>
          <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div className="eyebrow">AGENT ROSTER · {operationalAgents.length}</div>
            <button className="icon-btn"><Plus size={13} strokeWidth={1.6} /></button>
          </div>
          {retiredAgentCount > 0 && (
            <div className="mono" style={{ padding: '8px 16px', borderBottom: '1px solid var(--rule)', color: 'var(--ink-4)', fontSize: 10 }}>
              {retiredAgentCount} retired duplicate{retiredAgentCount === 1 ? '' : 's'} hidden
            </div>
          )}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {operationalAgents.map((a) => {
              const isActive = selected.kind === 'agent' && selected.id === a.id;
              const isHover = hoverAgentId === a.id;
              const k = agentStatusKind(a.status);
              const readiness = agentReadiness(a);
              return (
                <li
                  key={a.id}
                  onMouseEnter={() => setHoverAgentId(a.id)}
                  onMouseLeave={() => setHoverAgentId(null)}
                  onClick={() => setSelected({ kind: 'agent', id: a.id })}
                  style={{
                    padding: '10px 14px',
                    borderBottom: '1px solid var(--rule)',
                    cursor: 'pointer',
                    background: isActive ? 'var(--bg-2)' : 'transparent',
                    borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <StatusDot kind={k} pulse={a.status === 'running'} />
                    <span className="mono" style={{ fontSize: 12, color: 'var(--ink)', fontWeight: 500 }}>{a.name}</span>
                    <StatusPill kind={readiness.kind}>
                      {readiness.label}
                    </StatusPill>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginTop: 4,
                      fontSize: 11,
                      color: 'var(--ink-3)',
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    <span>{a.title ?? a.role}</span>
                    <span className="tabular">{relTime(a.lastHeartbeatAt)}</span>
                  </div>
                  {(isHover || isActive) && (
                    <div
                      style={{
                        marginTop: 8,
                        padding: '8px 10px',
                        background: 'var(--bg-2)',
                        border: '1px solid var(--rule)',
                        borderRadius: 2,
                        fontSize: 11,
                        fontFamily: "'JetBrains Mono', monospace",
                        color: 'var(--ink-2)',
                        display: 'grid',
                        gap: 3,
                      }}
                    >
                      <KvRow k="model"   v={a.model ?? '—'} />
                      <KvRow k="adapter" v={a.adapterType ?? '—'} />
                      <KvRow k="spend"   v={`${fmtMoney(a.spentMonthlyCents)} / ${fmtMoney(a.budgetMonthlyCents)}`} />
                      {a.pauseReason && <KvRow k="paused" v={a.pauseReason} err />}
                    </div>
                  )}
                </li>
              );
            })}
            {operationalAgents.length === 0 && (
              <li style={{ padding: 16, color: 'var(--ink-3)', fontSize: 12 }}>No agents registered.</li>
            )}
          </ul>
        </div>

        {/* CENTER — issue board + run history */}
        <div style={{ overflowY: 'auto' }}>
          <div style={{ padding: '16px 20px 10px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <div className="eyebrow">ISSUE BOARD</div>
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
              {issues.filter((i) => i.status !== 'done' && i.status !== 'closed').length} open
            </span>
          </div>
          <div style={{ padding: '0 20px', display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 10, minHeight: 240 }}>
            {(['triage', 'inbox', 'in_progress', 'blocked', 'done'] as const).map((col) => {
              // 'inbox' lane absorbs newly created 'todo' issues so the default
              // status from POST /api/companies/:id/issues isn't invisible.
              const laneStatuses: string[] =
                col === 'inbox' ? ['inbox', 'todo'] : [col];
              const laneIssues = issues.filter((i) => laneStatuses.includes(i.status));
              const visibleIssues = col === 'done' ? recentDoneIssues : laneIssues;
              return (
                <Lane
                  key={col}
                  label={col}
                  issues={visibleIssues}
                  hiddenCount={col === 'done' ? hiddenDoneCount : 0}
                  selectedId={selected.kind === 'issue' ? selected.id : null}
                  onPick={(i) => setSelected({ kind: 'issue', id: i.id })}
                  onOpenActivity={(i) => {
                    if (i.status === 'in_progress') {
                      router.push(`/mission-control/${params.companyId}/issues/${i.id}/activity`);
                    }
                  }}
                />
              );
            })}
          </div>

          <div style={{ padding: '24px 20px 20px' }}>
            <div className="eyebrow" style={{ marginBottom: 10 }}>
              RUN HISTORY · LAST {Math.min(recentRuns.length, 12)}
            </div>
            {hiddenRunCount > 0 && (
              <div className="mono" style={{ marginBottom: 8, fontSize: 10, color: 'var(--ink-4)' }}>
                {hiddenRunCount} historical run{hiddenRunCount === 1 ? '' : 's'} hidden
              </div>
            )}
            <div className="card" style={{ padding: 0 }}>
              {recentRuns.slice(0, 12).map((r, i) => {
                const agent = agents.find((a) => a.id === r.agentId);
                const issue = r.contextSnapshot?.issueId ? issues.find((x) => x.id === r.contextSnapshot?.issueId) : null;
                return (
                  <div
                    key={r.id}
                    className="mono"
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '110px 80px 1fr 1fr 1.4fr',
                      gap: 14,
                      padding: '8px 14px',
                      borderTop: i ? '1px solid var(--rule)' : 'none',
                      fontSize: 12,
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ color: 'var(--ink-4)' }}>{relTime(r.startedAt ?? r.createdAt)}</span>
                    <RunStatusTag status={r.status} />
                    <span style={{ color: 'var(--ink)' }}>{agent?.name ?? r.agentId.slice(0, 8)}</span>
                    <span style={{ color: 'var(--ink-2)' }}>{issue?.identifier ?? '—'}</span>
                    <span style={{ color: 'var(--ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {issue?.title ?? r.id.slice(0, 12)}
                    </span>
                  </div>
                );
              })}
              {recentRuns.length === 0 && (
                <div className="mono" style={{ padding: 14, fontSize: 12, color: 'var(--ink-4)' }}>No recent runs.</div>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT — detail panel */}
        <div style={{ borderLeft: '1px solid var(--rule)', overflowY: 'auto', background: 'var(--bg-card)' }}>
          {selectedAgent && <AgentDetail agent={selectedAgent} />}
          {selectedIssue && <IssueDetail issue={selectedIssue} agents={agents} />}
          {!selectedAgent && !selectedIssue && (
            <div style={{ padding: '24px 20px', color: 'var(--ink-3)', fontSize: 12 }}>
              Select an agent or issue to inspect.
            </div>
          )}
        </div>
      </div>
    </V2Shell>
  );
}

/* ============================================================
   Subcomponents
   ============================================================ */

function CompanyWakeAllButton({ agents }: { agents: ExecutionAgent[] }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const idle = agents.filter((a) => {
    if (a.status === 'retired') return false;
    if (a.status !== 'active' && a.status !== 'running') return false;
    if (!a.lastHeartbeatAt) return true;
    return Date.now() - new Date(a.lastHeartbeatAt).getTime() > HEARTBEAT_STALE_MS;
  });

  async function onClick() {
    if (idle.length === 0) {
      setResult('No idle agents.');
      return;
    }
    const sample = idle.slice(0, 5).map((a) => a.name).join(', ');
    const more = idle.length > 5 ? ` and ${idle.length - 5} more` : '';
    if (!window.confirm(`Wake ${idle.length} idle agent(s): ${sample}${more}?`)) return;
    setBusy(true);
    setResult(null);
    let ok = 0;
    let fail = 0;
    for (const a of idle) {
      try {
        await wakeAgent(a.id, { source: 'company-detail:wake-all-idle' });
        ok++;
      } catch {
        fail++;
      }
    }
    setBusy(false);
    setResult(`Woke ${ok}${fail ? ` · ${fail} failed` : ''}`);
  }

  return (
    <button
      className="btn btn-primary"
      onClick={onClick}
      disabled={busy || idle.length === 0}
      title={idle.length === 0 ? 'No idle agents' : `${idle.length} idle`}
    >
      <Zap size={13} strokeWidth={1.6} />
      {busy ? 'Waking…' : `Wake all idle${idle.length ? ` · ${idle.length}` : ''}`}
      {result && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--ink-3)' }}>{result}</span>}
    </button>
  );
}

function agentStatusKind(s: string): StatusKind {
  if (s === 'active' || s === 'running') return 'success';
  if (s === 'error') return 'error';
  return 'muted';
}

function isRecentDoneIssue(issue: ExecutionIssue): boolean {
  const terminalAt = issue.completedAt ?? issue.updatedAt;
  const terminalTime = new Date(terminalAt).getTime();
  if (!Number.isFinite(terminalTime)) return false;
  return Date.now() - terminalTime <= RECENT_DONE_WINDOW_MS;
}

function isRecentRun(run: ExecutionRun): boolean {
  const runAt = run.startedAt ?? run.createdAt;
  const runTime = new Date(runAt).getTime();
  if (!Number.isFinite(runTime)) return false;
  return Date.now() - runTime <= RECENT_RUN_WINDOW_MS;
}

function agentReadiness(agent: ExecutionAgent): { kind: StatusKind; label: string; detail: string } {
  if (agent.status === 'paused') return { kind: 'muted', label: 'Paused', detail: 'paused' };
  if (agent.status === 'error') return { kind: 'error', label: 'Error', detail: 'errored' };
  if (agent.status === 'running') return { kind: 'info', label: 'Running', detail: 'running' };

  if (!agent.lastHeartbeatAt) {
    const mode = agent.wakeOnDemand || !agent.heartbeatIntervalSec ? 'on demand' : 'cron only';
    return { kind: 'muted', label: 'Idle', detail: mode };
  }

  const heartbeatAge = Date.now() - new Date(agent.lastHeartbeatAt).getTime();
  if (!Number.isFinite(heartbeatAge)) return { kind: 'muted', label: 'Idle', detail: 'heartbeat unknown' };
  if (heartbeatAge > HEARTBEAT_STALE_MS && agent.heartbeatIntervalSec) {
    return { kind: 'warn', label: 'Late', detail: 'heartbeat late' };
  }
  return { kind: 'success', label: 'Ready', detail: 'recent heartbeat' };
}

function KvRow({ k, v, err = false }: { k: string; v: string; err?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: 'var(--ink-3)', letterSpacing: '.04em', textTransform: 'uppercase', fontSize: 10 }}>{k}</span>
      <span
        style={{
          color: err ? 'var(--err)' : 'var(--ink-2)',
          textAlign: 'right',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: '70%',
        }}
      >
        {v}
      </span>
    </div>
  );
}

const LANE_TITLES: Record<string, string> = {
  triage: 'TRIAGE', inbox: 'INBOX', in_progress: 'IN PROGRESS', blocked: 'BLOCKED', done: 'DONE',
};

function Lane({
  label, issues, hiddenCount = 0, selectedId, onPick, onOpenActivity,
}: {
  label: 'triage' | 'inbox' | 'in_progress' | 'blocked' | 'done';
  issues: ExecutionIssue[];
  hiddenCount?: number;
  selectedId: string | null;
  onPick: (i: ExecutionIssue) => void;
  onOpenActivity: (i: ExecutionIssue) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 2px', borderBottom: '1px solid var(--rule)' }}>
        <span className="mono" style={{ fontSize: 10, letterSpacing: '.12em', color: 'var(--ink-3)' }}>{LANE_TITLES[label]}</span>
        <span className="mono tabular" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{issues.length}</span>
      </div>
      {label === 'done' && hiddenCount > 0 && (
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-4)', lineHeight: 1.35, padding: '0 2px' }}>
          {hiddenCount} older done hidden
        </div>
      )}
      {issues.length === 0 ? (
        <div style={{ height: 32, fontSize: 11, color: 'var(--ink-4)', display: 'grid', placeItems: 'center', border: '1px dashed var(--rule)' }}>—</div>
      ) : (
        issues.map((i) => (
          <IssueCard
            key={i.id}
            i={i}
            onClick={() => onPick(i)}
            onDoubleClick={() => onOpenActivity(i)}
            active={selectedId === i.id}
          />
        ))
      )}
    </div>
  );
}

function IssueCard({
  i,
  onClick,
  onDoubleClick,
  active,
}: {
  i: ExecutionIssue;
  onClick: () => void;
  onDoubleClick: () => void;
  active: boolean;
}) {
  const pri = i.priority || 'low';
  const priColor =
    pri === 'critical' ? 'var(--err)'
    : pri === 'high' ? 'var(--warn)'
    : pri === 'medium' ? 'var(--info)'
    : 'var(--ink-4)';
  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className="card"
      title={i.status === 'in_progress' ? 'Double-click to view live agent activity' : undefined}
      style={{
        padding: '8px 10px',
        cursor: 'pointer',
        borderLeft: `2px solid ${priColor}`,
        background: active ? 'var(--bg-2)' : 'var(--bg-card)',
        borderColor: active ? 'var(--ink-3)' : 'var(--rule)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
        <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '.06em' }}>{i.identifier}</span>
        <span className="mono" style={{ fontSize: 9, color: priColor, letterSpacing: '.1em', textTransform: 'uppercase' }}>{pri}</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--ink)', marginTop: 4, lineHeight: 1.35 }}>{i.title}</div>
    </div>
  );
}

function RunStatusTag({ status }: { status: string }) {
  const c =
    status === 'completed' || status === 'success' || status === 'succeeded' ? 'var(--ok)'
    : status === 'failed' || status === 'error' ? 'var(--err)'
    : status === 'running' ? 'var(--info)'
    : 'var(--ink-3)';
  return (
    <span style={{ color: c, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', fontSize: 11 }}>
      {status}
    </span>
  );
}

function AgentDetail({ agent }: { agent: ExecutionAgent }) {
  const k = agentStatusKind(agent.status);
  const readiness = agentReadiness(agent);
  const pct = agent.budgetMonthlyCents > 0
    ? Math.round((agent.spentMonthlyCents / agent.budgetMonthlyCents) * 100)
    : 0;
  return (
    <div>
      <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--rule)' }}>
        <div className="eyebrow">AGENT</div>
        <div className="mono" style={{ fontSize: 16, marginTop: 6, color: 'var(--ink)' }}>{agent.name}</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <StatusPill kind={k}>{agent.status}</StatusPill>
          <StatusPill kind="muted">{agent.role}</StatusPill>
          {agent.adapterType && <StatusPill kind="muted">{agent.adapterType}</StatusPill>}
        </div>
      </div>
      <div style={{ padding: '14px 20px' }}>
        <div className="eyebrow" style={{ marginBottom: 8 }}>RUNTIME</div>
        <StatusPill kind={readiness.kind}>{readiness.label}</StatusPill>
        <div className="mono tabular" style={{ fontSize: 13, color: 'var(--ink)' }}>{relTime(agent.lastHeartbeatAt)}</div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>
          {agent.heartbeatIntervalSec ? `interval ${agent.heartbeatIntervalSec}s` : 'no heartbeat interval'} · {readiness.detail}
        </div>
      </div>
      <div style={{ padding: '14px 20px', borderTop: '1px solid var(--rule)' }}>
        <div className="eyebrow" style={{ marginBottom: 8 }}>BUDGET · MONTHLY</div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div className="serif tabular" style={{ fontSize: 24 }}>{fmtMoney(agent.spentMonthlyCents)}</div>
          <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>of {fmtMoney(agent.budgetMonthlyCents)}</span>
        </div>
        <div style={{ height: 4, background: 'var(--rule)', marginTop: 8, position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: pct + '%', background: pct > 85 ? 'var(--err)' : pct > 60 ? 'var(--warn)' : 'var(--ok)' }} />
        </div>
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', marginTop: 6, letterSpacing: '.06em' }}>
          {pct}% used
        </div>
      </div>
      {agent.model && (
        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--rule)' }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>MODEL</div>
          <div className="mono" style={{ fontSize: 12, color: 'var(--ink)' }}>{agent.model}</div>
          {agent.adapterType && (
            <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>via {agent.adapterType}</div>
          )}
        </div>
      )}
      {agent.pauseReason && (
        <div style={{ margin: '14px 20px', padding: '10px 12px', background: agent.status === 'retired' ? 'var(--bg-2)' : 'var(--err-soft)', border: `1px solid ${agent.status === 'retired' ? 'var(--rule-2)' : 'var(--err)'}`, borderRadius: 2 }}>
          <div className="mono" style={{ fontSize: 10, color: agent.status === 'retired' ? 'var(--ink-3)' : 'var(--err)', letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: 4 }}>
            {agent.status === 'retired' ? 'RETIREMENT NOTE' : 'LAST ERROR'}
          </div>
          <div className="mono" style={{ fontSize: 11, color: agent.status === 'retired' ? 'var(--ink-2)' : 'var(--err)' }}>{agent.pauseReason}</div>
        </div>
      )}
      <div style={{ padding: '14px 20px', borderTop: '1px solid var(--rule)', display: 'flex', gap: 8 }}>
        <button className="btn btn-secondary btn-sm" style={{ flex: 1 }}><Power size={12} strokeWidth={1.6} />Wake</button>
        <button className="btn btn-secondary btn-sm" style={{ flex: 1 }}><Pause size={12} strokeWidth={1.6} />Pause</button>
        <button className="btn btn-ghost btn-sm" aria-label="Edit"><Edit size={12} strokeWidth={1.6} /></button>
      </div>
    </div>
  );
}

function IssueDetail({ issue, agents }: { issue: ExecutionIssue; agents: ExecutionAgent[] }) {
  const assignee = agents.find((a) => a.id === issue.assigneeAgentId);
  const k: StatusKind =
    issue.priority === 'critical' ? 'error'
    : issue.priority === 'high' ? 'warn'
    : issue.priority === 'medium' ? 'info'
    : 'muted';

  const [comments, setComments] = useState<IssueComment[]>([]);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [commentsErr, setCommentsErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setComments([]);
    setCommentsErr(null);
    listIssueComments(issue.id, 25)
      .then((items) => {
        if (!cancelled) setComments(items);
      })
      .catch((err) => {
        if (!cancelled) setCommentsErr(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [issue.id, issue.latestCommentAt]);

  async function handleSubmit() {
    const body = draft.trim();
    if (!body || submitting) return;
    setSubmitting(true);
    try {
      await addIssueComment(issue.id, body);
      setDraft('');
      const fresh = await listIssueComments(issue.id, 25);
      setComments(fresh);
    } catch (err) {
      setCommentsErr(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--rule)' }}>
        <div className="eyebrow">ISSUE · {issue.identifier}</div>
        <div className="serif" style={{ fontSize: 18, marginTop: 6, color: 'var(--ink)', letterSpacing: '-0.01em', lineHeight: 1.3 }}>
          {issue.title}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
          {issue.priority && <StatusPill kind={k}>{issue.priority}</StatusPill>}
          <StatusPill kind="muted">{issue.status.replace('_', ' ')}</StatusPill>
        </div>
      </div>
      <div style={{ padding: '14px 20px' }}>
        <div className="eyebrow" style={{ marginBottom: 8 }}>ASSIGNEE</div>
        {assignee ? (
          <div className="mono" style={{ fontSize: 12, color: 'var(--ink)' }}>{assignee.name}</div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--ink-3)', fontStyle: 'italic' }}>Unassigned · in triage</div>
        )}
      </div>
      {issue.description && (
        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--rule)' }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>DESCRIPTION</div>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>{issue.description}</p>
        </div>
      )}
      <div style={{ padding: '14px 20px', borderTop: '1px solid var(--rule)' }}>
        <div className="eyebrow" style={{ marginBottom: 8 }}>
          COMMENTS · {comments.length}
        </div>
        {commentsErr && (
          <div style={{ fontSize: 11, color: 'var(--err)', marginBottom: 8 }}>{commentsErr}</div>
        )}
        {comments.length === 0 && !commentsErr && (
          <div style={{ fontSize: 12, color: 'var(--ink-3)', fontStyle: 'italic', marginBottom: 8 }}>
            No comments yet.
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 240, overflowY: 'auto' }}>
          {comments.map((c) => (
            <div
              key={c.id}
              style={{
                padding: '8px 10px',
                background: 'var(--bg-2)',
                border: '1px solid var(--rule)',
                borderRadius: 2,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 10,
                  letterSpacing: '.06em',
                  color: 'var(--ink-3)',
                  marginBottom: 4,
                  textTransform: 'uppercase',
                }}
                className="mono"
              >
                <span>{c.authorLabel}</span>
                <span className="tabular">{relTime(c.createdAt)}</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                {c.body}
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a comment…"
            rows={3}
            style={{
              width: '100%',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              padding: 8,
              border: '1px solid var(--rule)',
              background: 'var(--bg-card)',
              color: 'var(--ink)',
              resize: 'vertical',
            }}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={handleSubmit}
            disabled={!draft.trim() || submitting}
            style={{ alignSelf: 'flex-end' }}
          >
            {submitting ? 'Posting…' : 'Post comment'}
          </button>
        </div>
      </div>
      <div style={{ padding: '14px 20px', borderTop: '1px solid var(--rule)', display: 'flex', gap: 8 }}>
        <button className="btn btn-secondary btn-sm" style={{ flex: 1 }}>Reassign</button>
        <button className="btn btn-primary btn-sm" style={{ flex: 1 }}>Open in board</button>
      </div>
    </div>
  );
}
