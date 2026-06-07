'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { V2Shell } from '@/components/v2/shell';
import { useV2Nav } from '@/components/v2/nav';
import { relTime } from '@/components/v2/primitives';
import {
  listCompanies,
  listCompanyAgents,
  listCompanyIssues,
  listTenants,
  patchIssue,
  type ExecutionAgent,
  type ExecutionCompany,
  type ExecutionIssue,
  type Tenant,
} from '@/lib/api';
import { CheckCircle2, ExternalLink, RefreshCw, RotateCcw, Search } from 'lucide-react';

const CURRENT_PLAN_KEY = 'awos-local-next-pass-2026-05-15';
const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function priorityClass(priority: string | null): string {
  if (priority === 'critical') return 'pill-error';
  if (priority === 'high') return 'pill-warn';
  if (priority === 'medium') return 'pill-accent';
  return 'pill-muted';
}

function planKey(issue: ExecutionIssue): string {
  const value = issue.metadata?.planKey;
  return typeof value === 'string' ? value : '';
}

function draftKey(issue: ExecutionIssue): string {
  const value = issue.metadata?.draftKey;
  return typeof value === 'string' ? value : '';
}

function issueScope(issue: ExecutionIssue): string {
  const value = issue.metadata?.scope;
  return typeof value === 'string' ? value : '';
}

function isCurrentNextPass(issue: ExecutionIssue): boolean {
  return planKey(issue) === CURRENT_PLAN_KEY || issueScope(issue) === 'awos-local-only';
}

function reviewWarnings(issue: ExecutionIssue): string[] {
  const warnings: string[] = [];
  if (!issue.assigneeAgentId) warnings.push('unassigned');
  if (!issue.latestCommentAt) warnings.push('no review comment');
  if (!issue.description?.trim()) warnings.push('missing acceptance criteria');
  if (issue.blockedOn.length > 0) warnings.push('has blockers');
  return warnings;
}

function sortReviewIssues(a: ExecutionIssue, b: ExecutionIssue): number {
  const currentDelta = Number(isCurrentNextPass(b)) - Number(isCurrentNextPass(a));
  if (currentDelta !== 0) return currentDelta;
  const priorityDelta = (PRIORITY_RANK[a.priority ?? ''] ?? 99) - (PRIORITY_RANK[b.priority ?? ''] ?? 99);
  if (priorityDelta !== 0) return priorityDelta;
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

export default function ReviewQueuePage() {
  const navigate = useV2Nav();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [companies, setCompanies] = useState<ExecutionCompany[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [agents, setAgents] = useState<ExecutionAgent[]>([]);
  const [issues, setIssues] = useState<ExecutionIssue[]>([]);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);

  const reviewIssues = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...issues]
      .filter((issue) => {
        if (!q) return true;
        return [
          issue.identifier,
          issue.title,
          issue.description ?? '',
          issue.priority ?? '',
          draftKey(issue),
          planKey(issue),
        ]
          .join(' ')
          .toLowerCase()
          .includes(q);
      })
      .sort(sortReviewIssues);
  }, [issues, search]);

  const currentIssues = reviewIssues.filter(isCurrentNextPass);
  const historicalIssues = reviewIssues.filter((issue) => !isCurrentNextPass(issue));
  const selectedIssue = reviewIssues.find((issue) => issue.id === selectedIssueId) ?? reviewIssues[0] ?? null;
  const selectedWarnings = selectedIssue ? reviewWarnings(selectedIssue) : [];

  async function loadBaseContext() {
    setLoading(true);
    setError(null);
    try {
      const tenants = await listTenants();
      const firstTenant = tenants[0] ?? null;
      setTenant(firstTenant);
      if (!firstTenant) {
        setCompanies([]);
        setCompanyId('');
        return;
      }
      const companyRows = await listCompanies(firstTenant.id);
      setCompanies(companyRows);
      setCompanyId((current) => (companyRows.some((company) => company.id === current) ? current : companyRows[0]?.id ?? ''));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load review context');
    } finally {
      setLoading(false);
    }
  }

  async function loadCompanyReviewQueue(nextCompanyId = companyId) {
    if (!nextCompanyId) return;
    setBusy(true);
    setError(null);
    try {
      const [agentRows, issueRows] = await Promise.all([
        listCompanyAgents(nextCompanyId),
        listCompanyIssues(nextCompanyId, { status: 'review', limit: 500 }),
      ]);
      setAgents(agentRows);
      setIssues(issueRows);
      setSelectedIssueId((current) => {
        if (current && issueRows.some((issue) => issue.id === current)) return current;
        return issueRows.sort(sortReviewIssues)[0]?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load review issues');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void loadBaseContext();
  }, []);

  useEffect(() => {
    if (companyId) void loadCompanyReviewQueue(companyId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  async function updateReviewStatus(issue: ExecutionIssue, status: 'done' | 'blocked') {
    const action = status === 'done' ? 'Approved' : 'Returned';
    const body = comment.trim()
      || (status === 'done'
        ? 'Approved from Review Queue after coordinator review.'
        : 'Returned from Review Queue for follow-up before approval.');
    setBusy(true);
    setError(null);
    try {
      const updated = await patchIssue(issue.id, {
        status,
        comment: `${action} from Review Queue. ${body}`,
      });
      setIssues((rows) => rows.filter((row) => row.id !== updated.id));
      setComment('');
      setSelectedIssueId((current) => (current === updated.id ? null : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action.toLowerCase()} issue`);
    } finally {
      setBusy(false);
    }
  }

  function agentLabel(agentId: string | null): string {
    if (!agentId) return 'unassigned';
    const agent = agentById.get(agentId);
    return agent ? `${agent.name} · ${agent.role}` : 'unknown agent';
  }

  return (
    <V2Shell active="review-queue" onNav={navigate}>
      <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div className="eyebrow">OPERATE · REVIEW</div>
            <div className="serif" style={{ fontSize: 30, marginTop: 4 }}>Review queue</div>
            <div style={{ color: 'var(--ink-3)', fontSize: 13, maxWidth: '76ch', marginTop: 6 }}>
              Verify completed local work before it leaves review. Current AWOS-local next-pass items are separated from historical review backlog.
            </div>
          </div>
          <button className="btn btn-sm" onClick={() => void loadCompanyReviewQueue()} disabled={busy || !companyId}>
            <RefreshCw size={13} strokeWidth={1.6} />Refresh
          </button>
        </div>

        {error && <div style={{ color: 'var(--err)', fontSize: 12 }}>{error}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
          <Metric label="Review total" value={reviewIssues.length} />
          <Metric label="Current plan" value={currentIssues.length} />
          <Metric label="Historical" value={historicalIssues.length} />
          <Metric label="Needs attention" value={reviewIssues.filter((issue) => reviewWarnings(issue).length > 0).length} tone="warn" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(420px, 0.95fr) minmax(460px, 1.05fr)', gap: 14, alignItems: 'start' }}>
          <section className="card" style={{ minHeight: 620, overflow: 'hidden' }}>
            <div style={{ padding: 14, borderBottom: '1px solid var(--rule)', display: 'grid', gap: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px', gap: 8 }}>
                <label>
                  <span className="eyebrow" style={{ marginBottom: 4 }}>Company</span>
                  <select className="form-select" value={companyId} onChange={(event) => setCompanyId(event.target.value)}>
                    {companies.map((company) => (
                      <option key={company.id} value={company.id}>{company.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="eyebrow" style={{ marginBottom: 4 }}>Status</span>
                  <input className="form-input" value="review" readOnly />
                </label>
              </div>
              <label style={{ position: 'relative', display: 'block' }}>
                <Search size={14} strokeWidth={1.6} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--ink-4)' }} />
	                <input
	                  className="form-input"
	                  data-testid="review-queue-search"
	                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search review queue"
                  style={{ paddingLeft: 30 }}
                />
              </label>
            </div>

            <IssueGroup
              title="Current AWOS-local plan"
              issues={currentIssues}
              selectedIssueId={selectedIssue?.id ?? null}
              agentLabel={agentLabel}
              onSelect={setSelectedIssueId}
            />
            <IssueGroup
              title="Historical review backlog"
              issues={historicalIssues}
              selectedIssueId={selectedIssue?.id ?? null}
              agentLabel={agentLabel}
              onSelect={setSelectedIssueId}
            />

            {!loading && reviewIssues.length === 0 && (
	              <div data-testid="review-queue-empty" style={{ padding: 36, textAlign: 'center', color: 'var(--ink-4)', fontStyle: 'italic' }}>
                No issues are waiting for review.
              </div>
            )}
          </section>

          <section className="card" style={{ minHeight: 620, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div className="eyebrow" style={{ margin: 0 }}>
                {selectedIssue ? `REVIEW · ${selectedIssue.identifier ?? selectedIssue.id.slice(0, 8)}` : 'REVIEW'}
              </div>
              {selectedIssue && (
                <Link href={`/mission-control/${selectedIssue.companyId}/issues/${selectedIssue.id}/activity`} className="btn btn-sm">
                  <ExternalLink size={13} strokeWidth={1.6} />Activity
                </Link>
              )}
            </div>

            {selectedIssue ? (
              <div style={{ padding: 16, display: 'grid', gap: 14 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span className={`pill ${priorityClass(selectedIssue.priority)}`}>{selectedIssue.priority ?? 'medium'}</span>
                    {isCurrentNextPass(selectedIssue) && <span className="pill pill-info">current plan</span>}
                    {draftKey(selectedIssue) && <span className="pill pill-muted">{draftKey(selectedIssue)}</span>}
                  </div>
                  <h2 style={{ margin: '12px 0 0', fontSize: 22, lineHeight: 1.25 }}>{selectedIssue.title}</h2>
                  <div style={{ marginTop: 8, color: 'var(--ink-3)', fontSize: 12, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <span>{agentLabel(selectedIssue.assigneeAgentId)}</span>
                    <span>Updated {relTime(selectedIssue.updatedAt)}</span>
                    {selectedIssue.latestCommentAt && <span>Comment {relTime(selectedIssue.latestCommentAt)}</span>}
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <Meta label="Plan" value={planKey(selectedIssue) || 'unclassified'} />
                  <Meta label="Scope" value={issueScope(selectedIssue) || 'unclassified'} />
                </div>

                {selectedWarnings.length > 0 && (
                  <div style={{ border: '1px solid var(--warn)', background: 'var(--warn-soft)', color: 'var(--warn)', padding: 12, fontSize: 12, lineHeight: 1.45 }}>
                    Check before approval: {selectedWarnings.join(', ')}.
                  </div>
                )}

                <section style={{ border: '1px solid var(--rule)', padding: 12, maxHeight: 260, overflowY: 'auto' }}>
                  <div className="eyebrow" style={{ marginBottom: 8 }}>Acceptance context</div>
                  <div style={{ whiteSpace: 'pre-wrap', color: 'var(--ink-2)', fontSize: 13, lineHeight: 1.5 }}>
                    {selectedIssue.description?.trim() || 'No description was provided.'}
                  </div>
                </section>

                <label style={{ display: 'grid', gap: 5 }}>
                  <span className="eyebrow" style={{ margin: 0 }}>Reviewer comment</span>
                  <textarea
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                    placeholder="Evidence checked, blocker found, or reason for approval"
                    style={{
                      width: '100%',
                      minHeight: 112,
                      resize: 'vertical',
                      padding: 10,
                      background: 'var(--bg-card)',
                      color: 'var(--ink)',
                      border: '1px solid var(--rule-2)',
                      borderRadius: 2,
                      font: 'inherit',
                      lineHeight: 1.45,
                    }}
                  />
                </label>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button className="btn btn-danger" onClick={() => void updateReviewStatus(selectedIssue, 'blocked')} disabled={busy}>
                    <RotateCcw size={14} strokeWidth={1.6} />Return blocked
                  </button>
                  <button className="btn btn-success" onClick={() => void updateReviewStatus(selectedIssue, 'done')} disabled={busy || selectedWarnings.includes('has blockers')}>
                    <CheckCircle2 size={14} strokeWidth={1.6} />Approve done
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ padding: 36, color: 'var(--ink-4)', fontStyle: 'italic' }}>
                Select a review item.
              </div>
            )}
          </section>
        </div>
      </div>
    </V2Shell>
  );
}

function IssueGroup({
  title,
  issues,
  selectedIssueId,
  agentLabel,
  onSelect,
}: {
  title: string;
  issues: ExecutionIssue[];
  selectedIssueId: string | null;
  agentLabel: (agentId: string | null) => string;
  onSelect: (issueId: string) => void;
}) {
  return (
    <div>
      <div className="eyebrow" style={{ padding: '12px 14px 8px', margin: 0, borderBottom: issues.length ? '1px solid var(--rule)' : 0 }}>
        {title} · {issues.length}
      </div>
      {issues.map((issue) => {
        const selected = issue.id === selectedIssueId;
        const warnings = reviewWarnings(issue);
        return (
	          <button
	            key={issue.id}
	            type="button"
	            data-testid="review-queue-item"
	            onClick={() => onSelect(issue.id)}
            style={{
              width: '100%',
              textAlign: 'left',
              padding: '12px 14px',
              border: 0,
              borderBottom: '1px solid var(--rule)',
              background: selected ? 'var(--bg-hover)' : 'transparent',
              color: 'var(--ink)',
              cursor: 'pointer',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <span className="mono" style={{ color: 'var(--ink-3)', fontSize: 11 }}>{issue.identifier ?? issue.id.slice(0, 8)}</span>
              <span className={`pill ${priorityClass(issue.priority)}`}>{issue.priority ?? 'medium'}</span>
            </div>
            <div style={{ marginTop: 7, fontWeight: 600, lineHeight: 1.35 }}>{issue.title}</div>
            <div style={{ marginTop: 7, display: 'flex', gap: 10, color: 'var(--ink-3)', fontSize: 12, flexWrap: 'wrap' }}>
              <span>{agentLabel(issue.assigneeAgentId)}</span>
              <span>{relTime(issue.updatedAt)}</span>
              {draftKey(issue) && <span>{draftKey(issue)}</span>}
              {warnings.length > 0 && <span style={{ color: 'var(--warn)' }}>{warnings.length} check{warnings.length === 1 ? '' : 's'}</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function Metric({ label, value, tone = 'normal' }: { label: string; value: number; tone?: 'normal' | 'warn' }) {
  return (
    <section className="card" style={{ padding: 16 }}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>{label}</div>
      <div className="serif" style={{ fontSize: 30, color: tone === 'warn' && value > 0 ? 'var(--warn)' : 'var(--ink)' }}>{value}</div>
    </section>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: '1px solid var(--rule)', padding: '8px 10px' }}>
      <div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>
      <div className="mono" style={{ color: 'var(--ink-2)', fontSize: 12, overflowWrap: 'anywhere' }}>{value}</div>
    </div>
  );
}
