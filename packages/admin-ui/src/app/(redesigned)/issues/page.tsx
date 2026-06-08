'use client';

import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { V2Shell } from '@/components/v2/shell';
import { useV2Nav } from '@/components/v2/nav';
import { relTime } from '@/components/v2/primitives';
import {
  createIssue,
  listCompanies,
  listCompanyAgents,
  listCompanyIssues,
  listCompanyProjects,
  listTenants,
  patchIssue,
  type ExecutionAgent,
  type ExecutionCompany,
  type ExecutionIssue,
  type ExecutionProject,
  type Tenant,
} from '@/lib/api';
import { ClipboardList, Plus, RefreshCw, Save, Search } from 'lucide-react';

const STATUS_OPTIONS = ['todo', 'in_progress', 'blocked', 'review', 'done', 'closed'] as const;
const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'critical'] as const;

type IssueStatus = (typeof STATUS_OPTIONS)[number];
type IssuePriority = (typeof PRIORITY_OPTIONS)[number];

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

interface IssueFormState {
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string;
}

interface CreateFormState {
  projectId: string;
  title: string;
  description: string;
  priority: IssuePriority;
  assigneeAgentId: string;
}

const emptyCreateForm: CreateFormState = {
  projectId: '',
  title: '',
  description: '',
  priority: 'medium',
  assigneeAgentId: '',
};

function normalizeStatus(status: string): IssueStatus {
  return STATUS_OPTIONS.includes(status as IssueStatus) ? (status as IssueStatus) : 'todo';
}

function normalizePriority(priority: string | null): IssuePriority {
  return PRIORITY_OPTIONS.includes(priority as IssuePriority) ? (priority as IssuePriority) : 'medium';
}

function priorityColor(priority: string | null): string {
  if (priority === 'critical') return 'var(--err)';
  if (priority === 'high') return 'var(--warn)';
  if (priority === 'medium') return 'var(--accent)';
  return 'var(--ink-3)';
}

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

function issueToForm(issue: ExecutionIssue): IssueFormState {
  return {
    title: issue.title,
    description: issue.description ?? '',
    status: normalizeStatus(issue.status),
    priority: normalizePriority(issue.priority),
    assigneeAgentId: issue.assigneeAgentId ?? '',
  };
}

export default function IssuesPage() {
  const navigate = useV2Nav();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [companies, setCompanies] = useState<ExecutionCompany[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [projects, setProjects] = useState<ExecutionProject[]>([]);
  const [agents, setAgents] = useState<ExecutionAgent[]>([]);
  const [issues, setIssues] = useState<ExecutionIssue[]>([]);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | IssueStatus>('all');
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'edit' | 'create'>('edit');
  const [editor, setEditor] = useState<IssueFormState | null>(null);
  const [createForm, setCreateForm] = useState<CreateFormState>(emptyCreateForm);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectedIssue = useMemo(
    () => issues.find((issue) => issue.id === selectedIssueId) ?? null,
    [issues, selectedIssueId],
  );

  const agentById = useMemo(() => {
    return new Map(agents.map((agent) => [agent.id, agent]));
  }, [agents]);

  const visibleIssues = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...issues]
      .filter((issue) => {
        if (!q) return true;
        return [issue.identifier, issue.title, issue.description ?? '', issue.status, issue.priority ?? '']
          .join(' ')
          .toLowerCase()
          .includes(q);
      })
      .sort((a, b) => {
        const priority = (PRIORITY_RANK[a.priority ?? ''] ?? 99) - (PRIORITY_RANK[b.priority ?? ''] ?? 99);
        if (priority !== 0) return priority;
        return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      });
  }, [issues, search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listTenants()
      .then(async (tenants) => {
        if (cancelled) return;
        const firstTenant = tenants[0] ?? null;
        setTenant(firstTenant);
        if (!firstTenant) return;
        const companyRows = await listCompanies(firstTenant.id);
        if (cancelled) return;
        setCompanies(companyRows);
        setCompanyId(companyRows[0]?.id ?? '');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load tenant context'))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!companyId) {
      setProjects([]);
      setAgents([]);
      setIssues([]);
      setSelectedIssueId(null);
      setEditor(null);
      return;
    }
    let cancelled = false;
    async function loadCompanyContext() {
      setLoading(true);
      setError(null);
      try {
        const [projectRows, agentRows] = await Promise.all([
          listCompanyProjects(companyId),
          listCompanyAgents(companyId),
        ]);
        if (cancelled) return;
        setProjects(projectRows);
        setAgents(agentRows);
        setCreateForm((current) => ({
          ...current,
          projectId: projectRows.some((project) => project.id === current.projectId)
            ? current.projectId
            : projectRows[0]?.id ?? '',
          assigneeAgentId: '',
        }));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load company context');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadCompanyContext();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  async function loadIssues() {
    if (!companyId) return;
    setBusy(true);
    setError(null);
    try {
      const rows = await listCompanyIssues(companyId, {
        status: statusFilter === 'all' ? undefined : statusFilter,
        limit: 500,
      });
      setIssues(rows);
      setSelectedIssueId((current) => {
        if (current && rows.some((issue) => issue.id === current)) return current;
        return rows[0]?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load issues');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void loadIssues();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, statusFilter]);

  useEffect(() => {
    if (selectedIssue && mode === 'edit') {
      setEditor(issueToForm(selectedIssue));
    } else if (!selectedIssue && mode === 'edit') {
      setEditor(null);
    }
  }, [selectedIssue, mode]);

  async function saveIssue() {
    if (!selectedIssue || !editor || !editor.title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await patchIssue(selectedIssue.id, {
        title: editor.title.trim(),
        description: editor.description.trim() || null,
        status: editor.status,
        priority: editor.priority,
        assigneeAgentId: editor.assigneeAgentId || null,
      });
      setIssues((rows) => rows.map((issue) => (issue.id === updated.id ? updated : issue)));
      setSelectedIssueId(updated.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save issue');
    } finally {
      setBusy(false);
    }
  }

  async function createNewIssue() {
    if (!tenant || !companyId || !createForm.projectId || !createForm.title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createIssue(companyId, {
        tenantId: tenant.id,
        projectId: createForm.projectId,
        title: createForm.title.trim(),
        description: createForm.description.trim() || undefined,
        priority: createForm.priority,
        assigneeAgentId: createForm.assigneeAgentId || null,
      });
      setCreateForm({ ...emptyCreateForm, projectId: projects[0]?.id ?? '' });
      setMode('edit');
      setIssues((rows) => [created, ...rows]);
      setSelectedIssueId(created.id);
      setEditor(issueToForm(created));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create issue');
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
    <V2Shell active="issues" onNav={navigate} triageCount={issues.filter((issue) => !issue.assigneeAgentId).length}>
      <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div className="eyebrow">OPERATE · ISSUES</div>
            <div className="serif" style={{ fontSize: 30, marginTop: 4 }}>Issue editor</div>
            <div style={{ color: 'var(--ink-3)', fontSize: 13, maxWidth: '68ch', marginTop: 6 }}>
              Create, route, and manage local AgentWorks OS work items across companies, projects, and agents.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm" onClick={() => void loadIssues()} disabled={busy || !companyId}>
              <RefreshCw size={13} strokeWidth={1.6} />Refresh
            </button>
            <button className="btn btn-sm btn-primary" onClick={() => setMode('create')}>
              <Plus size={13} strokeWidth={1.6} />New issue
            </button>
          </div>
        </div>

        {error && <div style={{ color: 'var(--err)', fontSize: 12 }}>{error}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(360px, 0.95fr) minmax(420px, 1.05fr)', gap: 14, alignItems: 'start' }}>
          <section className="card" style={{ minHeight: 620, overflow: 'hidden' }}>
            <div style={{ padding: 14, borderBottom: '1px solid var(--rule)', display: 'grid', gap: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 150px', gap: 8 }}>
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
                  <select className="form-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
                    <option value="all">all</option>
                    {STATUS_OPTIONS.map((status) => (
                      <option key={status} value={status}>{statusLabel(status)}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label style={{ position: 'relative', display: 'block' }}>
                <Search size={14} strokeWidth={1.6} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--ink-4)' }} />
                <input
                  className="form-input"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search issues"
                  style={{ paddingLeft: 30 }}
                />
              </label>
            </div>

            <div style={{ maxHeight: 530, overflowY: 'auto' }}>
              {visibleIssues.map((issue) => {
                const selected = issue.id === selectedIssueId && mode === 'edit';
                const color = priorityColor(issue.priority);
                return (
                  <button
                    key={issue.id}
                    type="button"
                    onClick={() => {
                      setMode('edit');
                      setSelectedIssueId(issue.id);
                    }}
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
                      <span className="mono" style={{ fontSize: 10, padding: '2px 6px', border: `1px solid ${color}`, color, textTransform: 'uppercase' }}>
                        {issue.priority ?? 'medium'}
                      </span>
                    </div>
                    <div style={{ marginTop: 7, fontWeight: 600, lineHeight: 1.35 }}>{issue.title}</div>
                    <div style={{ marginTop: 7, display: 'flex', gap: 10, color: 'var(--ink-3)', fontSize: 12 }}>
                      <span>{statusLabel(issue.status)}</span>
                      <span>{agentLabel(issue.assigneeAgentId)}</span>
                      <span>{relTime(issue.updatedAt)}</span>
                    </div>
                  </button>
                );
              })}
              {!loading && visibleIssues.length === 0 && (
                <div style={{ padding: 36, textAlign: 'center', color: 'var(--ink-4)', fontStyle: 'italic' }}>
                  No issues match this view.
                </div>
              )}
            </div>
          </section>

          <section className="card" style={{ minHeight: 620, padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div className="eyebrow" style={{ margin: 0 }}>
                {mode === 'create' ? 'CREATE ISSUE' : selectedIssue ? `EDIT · ${selectedIssue.identifier ?? selectedIssue.id.slice(0, 8)}` : 'ISSUE'}
              </div>
              <ClipboardList size={15} strokeWidth={1.6} color="var(--ink-3)" />
            </div>

            {mode === 'create' ? (
              <IssueCreateForm
                form={createForm}
                projects={projects}
                agents={agents}
                busy={busy}
                canCreate={Boolean(tenant && companyId && createForm.projectId && createForm.title.trim())}
                onChange={setCreateForm}
                onCancel={() => setMode('edit')}
                onCreate={createNewIssue}
              />
            ) : selectedIssue && editor ? (
              <IssueEditor
                issue={selectedIssue}
                form={editor}
                agents={agents}
                busy={busy}
                onChange={setEditor}
                onSave={saveIssue}
              />
            ) : (
              <div style={{ padding: 36, color: 'var(--ink-4)', fontStyle: 'italic' }}>
                Select an issue or create a new one.
              </div>
            )}
          </section>
        </div>
      </div>
    </V2Shell>
  );
}

function IssueEditor({
  issue,
  form,
  agents,
  busy,
  onChange,
  onSave,
}: {
  issue: ExecutionIssue;
  form: IssueFormState;
  agents: ExecutionAgent[];
  busy: boolean;
  onChange: (next: IssueFormState) => void;
  onSave: () => void;
}) {
  return (
    <div style={{ padding: 16, display: 'grid', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Meta label="Created" value={relTime(issue.createdAt)} />
        <Meta label="Updated" value={relTime(issue.updatedAt)} />
      </div>
      <Field label="Title">
        <input
          className="form-input"
          value={form.title}
          onChange={(event) => onChange({ ...form, title: event.target.value })}
        />
      </Field>
      <Field label="Description">
        <textarea
          value={form.description}
          onChange={(event) => onChange({ ...form, description: event.target.value })}
          style={textareaStyle}
        />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.2fr', gap: 10 }}>
        <Field label="Status">
          <select className="form-select" value={form.status} onChange={(event) => onChange({ ...form, status: event.target.value as IssueStatus })}>
            {STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>{statusLabel(status)}</option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select className="form-select" value={form.priority} onChange={(event) => onChange({ ...form, priority: event.target.value as IssuePriority })}>
            {PRIORITY_OPTIONS.map((priority) => (
              <option key={priority} value={priority}>{priority}</option>
            ))}
          </select>
        </Field>
        <Field label="Assignee">
          <select className="form-select" value={form.assigneeAgentId} onChange={(event) => onChange({ ...form, assigneeAgentId: event.target.value })}>
            <option value="">unassigned</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.name} · {agent.role}</option>
            ))}
          </select>
        </Field>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 8 }}>
        <button className="btn btn-primary" onClick={onSave} disabled={busy || !form.title.trim()}>
          <Save size={13} strokeWidth={1.6} />Save issue
        </button>
      </div>
    </div>
  );
}

function IssueCreateForm({
  form,
  projects,
  agents,
  busy,
  canCreate,
  onChange,
  onCancel,
  onCreate,
}: {
  form: CreateFormState;
  projects: ExecutionProject[];
  agents: ExecutionAgent[];
  busy: boolean;
  canCreate: boolean;
  onChange: (next: CreateFormState) => void;
  onCancel: () => void;
  onCreate: () => void;
}) {
  return (
    <div style={{ padding: 16, display: 'grid', gap: 14 }}>
      <Field label="Project">
        <select className="form-select" value={form.projectId} onChange={(event) => onChange({ ...form, projectId: event.target.value })}>
          {projects.length === 0 && <option value="">no projects</option>}
          {projects.map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </select>
      </Field>
      <Field label="Title">
        <input
          className="form-input"
          value={form.title}
          onChange={(event) => onChange({ ...form, title: event.target.value })}
          placeholder="Short, action-oriented title"
        />
      </Field>
      <Field label="Description">
        <textarea
          value={form.description}
          onChange={(event) => onChange({ ...form, description: event.target.value })}
          placeholder="Context, acceptance criteria, or production test notes"
          style={textareaStyle}
        />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 10 }}>
        <Field label="Priority">
          <select className="form-select" value={form.priority} onChange={(event) => onChange({ ...form, priority: event.target.value as IssuePriority })}>
            {PRIORITY_OPTIONS.map((priority) => (
              <option key={priority} value={priority}>{priority}</option>
            ))}
          </select>
        </Field>
        <Field label="Assignee">
          <select className="form-select" value={form.assigneeAgentId} onChange={(event) => onChange({ ...form, assigneeAgentId: event.target.value })}>
            <option value="">unassigned</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.name} · {agent.role}</option>
            ))}
          </select>
        </Field>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 8 }}>
        <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={onCreate} disabled={busy || !canCreate}>
          <Plus size={13} strokeWidth={1.6} />Create issue
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 5 }}>
      <span className="eyebrow" style={{ margin: 0 }}>{label}</span>
      {children}
    </label>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: '1px solid var(--rule)', padding: '8px 10px' }}>
      <div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>
      <div className="mono" style={{ color: 'var(--ink-2)', fontSize: 12 }}>{value}</div>
    </div>
  );
}

const textareaStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 180,
  resize: 'vertical',
  padding: 10,
  background: 'var(--bg-card)',
  color: 'var(--ink)',
  border: '1px solid var(--rule-2)',
  borderRadius: 2,
  font: 'inherit',
  lineHeight: 1.45,
};
