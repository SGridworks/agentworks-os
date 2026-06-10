/**
 * AgentWorks OS API client.
 * All calls go to the local agentos-d daemon.
 */
export function getApiBase(hasWindow = typeof window !== 'undefined') {
  return hasWindow ? '' : process.env.AGENTOS_API_URL ?? '';
}

const BASE = getApiBase();

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} — ${body}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface Health {
  status: string;
  version: string;
  awcp: string;
  startedAt: string;
  now: string;
}

export function getHealth() {
  return request<Health>('/api/health');
}

export interface AutomationTemplate {
  id: string;
  name: string;
  trigger: string;
  /** For event-triggered templates, the event kind they subscribe to (e.g. "scanner.finding"). */
  event_kind?: string | null;
  status: string;
  description: string;
  definition: AutomationDefinition;
  source?: string;
}

export interface AutomationStep {
  id: string;
  name: string;
  type:
    | 'schedule.cron'
    | 'schedule.interval'
    | 'issue.created'
    | 'issue.updated'
    | 'approval.decided'
    | 'agent.completed'
    | 'dispatch.failed'
    | 'vault.changed'
    | 'webhook.response'
    | 'policy.check'
    | 'approval.enqueue'
    | 'approval.wait'
    | 'vault.read'
    | 'vault.write'
    | 'issue.create'
    | 'issue.update'
    | 'dispatch'
    | 'handoff.contract'
    | 'scanner.finding'
    | 'webhook.intake'
    | 'condition.if'
    | 'branch.switch'
    | 'loop.each'
    | 'merge.join'
    | 'delay.wait'
    | 'error.catch'
    | 'data.set'
    | 'data.transform'
    | 'data.filter'
    | 'data.dedupe'
    | 'data.extract'
    | 'json.parse'
    | 'http.request'
    | 'email.send'
    | 'message.send'
    | 'adapter.call'
    | 'rss.read'
    | 'file.read'
    | 'file.write'
    | 'ai.classify'
    | 'ai.summarize'
    | 'ai.extract'
    | 'ai.route'
    | 'ai.generate'
    | 'ai.review'
    | 'operator.brief'
    | 'friction.detect'
    | 'evidence.pack'
    | 'agent.panel'
    | 'workflow.self_heal';
  params: Record<string, unknown>;
}

export interface AutomationDefinition {
  trigger: 'manual' | 'webhook' | 'event';
  steps: AutomationStep[];
}

export type AutomationRunStatus =
  | 'running'
  | 'waiting_approval'
  | 'waiting_dispatch'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface AutomationRunStep {
  id: string;
  name: string;
  type: string;
  stepIndex?: number;
  status: string;
  input?: Record<string, unknown>;
  startedAt: string;
  finishedAt: string | null;
  output: Record<string, unknown>;
  context?: Record<string, unknown>;
  retryCount?: number;
  maxRetries?: number;
  error: string | null;
}

export interface AutomationRun {
  id: string;
  workflowId?: string;
  workflowName?: string;
  workflowVersionId?: string | null;
  status: AutomationRunStatus | string;
  startedAt: string;
  finishedAt?: string | null;
  terminalReason?: string | null;
  currentStepIndex?: number;
  replayOfRunId?: string | null;
  replayFromStepIndex?: number | null;
  waitingForApprovalId?: string | null;
  waitingForDispatchId?: string | null;
  dryRun?: boolean;
  steps?: AutomationRunStep[];
  error?: string | null;
}

export interface AutomationWorkflowVersion {
  id: string;
  workflowId: string;
  tenantId: string;
  companyId: string;
  version: number;
  definitionHash: string;
  definition: AutomationDefinition;
  changeSummary: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface AutomationEvidencePack {
  id: string;
  runId: string;
  status: string;
  summary: Record<string, unknown>;
  markdown: string;
  createdAt: string;
}

export interface AutomationSimulationResult {
  workflowId: string;
  runId: string;
  dryRun: true;
  status: string;
  wouldRun: Array<{ stepId: string; stepType: string; name: string }>;
  wouldSkip: Array<{ stepId: string; name: string; reason: string }>;
  sideEffectsSuppressed: string[];
  unresolvedRisks: string[];
  run: AutomationRun;
}

export interface AutomationStatus {
  engine: {
    name: string;
    state: 'online' | 'offline';
    checkedAt: string;
    latencyMs: number | null;
    error: string | null;
    privateBackend: boolean;
  };
  runtime: {
    mode: string;
    localOnly: boolean;
    dataDir: string;
    stateEntries: number;
    customExtensions: string;
  };
  bridge?: {
    state: 'online' | 'offline';
    baseUrl: string;
    latencyMs: number | null;
    error: string | null;
    warnings: string[];
  };
  warnings?: string[];
  suggestions?: Array<{
    id: string;
    title: string;
    description: string;
    status: string;
  }>;
  templates: AutomationTemplate[];
  workflows: Array<{
    id: string;
    name: string;
    active: boolean;
    status?: string;
    trigger?: string;
    /** For event-triggered workflows, the event kind they subscribe to (e.g. "scanner.finding"). */
    eventKind?: string | null;
    description?: string | null;
    definition: AutomationDefinition;
    updatedAt: string | null;
    currentVersion?: number | null;
    definitionHash?: string | null;
    sourceTemplateId?: string | null;
    externalEngine?: string | null;
    externalWorkflowId?: string | null;
    externalSyncStatus?: string | null;
    externalSyncedAt?: string | null;
    externalSyncError?: string | null;
  }>;
  recentRuns: AutomationRun[];
}

export function getAutomationStatus() {
  return request<AutomationStatus>('/api/admin/automations');
}

export function installAutomationTemplate(templateId: string, body: { tenantId?: string; companyId?: string } = {}) {
  return request(`/api/admin/automations/templates/${templateId}/install`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function createAutomationTemplate(body: {
  tenantId?: string;
  companyId?: string;
  name: string;
  trigger: 'manual' | 'webhook' | 'event';
  description: string;
  definition: AutomationDefinition;
}) {
  return request('/api/admin/automations/templates', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function createAutomationWorkflow(body: {
  tenantId?: string;
  companyId?: string;
  name: string;
  trigger: 'manual' | 'webhook' | 'event';
  description?: string;
  status?: 'active' | 'paused';
  definition: AutomationDefinition;
}) {
  return request('/api/admin/automations/workflows', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function runAutomationWorkflow(workflowId: string, input: Record<string, unknown> = {}) {
  return request<AutomationRun>(`/api/admin/automations/workflows/${workflowId}/run`, {
    method: 'POST',
    body: JSON.stringify({ input }),
  });
}

export function simulateAutomationWorkflow(workflowId: string, input: Record<string, unknown> = {}) {
  return request<AutomationSimulationResult>(`/api/admin/automations/workflows/${workflowId}/simulate`, {
    method: 'POST',
    body: JSON.stringify({ input }),
  });
}

export function setAutomationWorkflowStatus(workflowId: string, status: 'active' | 'paused') {
  return request(`/api/admin/automations/workflows/${workflowId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export function updateAutomationWorkflow(workflowId: string, body: {
  name?: string;
  description?: string | null;
  status?: 'active' | 'paused';
  definition?: AutomationDefinition;
}) {
  return request(`/api/admin/automations/workflows/${workflowId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function listAutomationWorkflowVersions(workflowId: string) {
  return request<{ items: AutomationWorkflowVersion[] }>(`/api/admin/automations/workflows/${workflowId}/versions`);
}

export function getAutomationWorkflowVersion(workflowId: string, version: number) {
  return request<{ item: AutomationWorkflowVersion; diff: Record<string, unknown> | null }>(
    `/api/admin/automations/workflows/${workflowId}/versions/${version}`,
  );
}

export function rollbackAutomationWorkflow(workflowId: string, version: number) {
  return request(`/api/admin/automations/workflows/${workflowId}/rollback`, {
    method: 'POST',
    body: JSON.stringify({ version }),
  });
}

export function selfHealAutomationWorkflow(workflowId: string) {
  return request<Record<string, unknown>>(`/api/admin/automations/workflows/${workflowId}/self-heal`, {
    method: 'POST',
  });
}

export function resumeAutomationRun(runId: string, input: Record<string, unknown> = {}) {
  return request<AutomationRun>(`/api/admin/automations/runs/${runId}/resume`, {
    method: 'POST',
    body: JSON.stringify({ input }),
  });
}

export function replayAutomationRun(runId: string, fromStepIndex = 0, inputOverride: Record<string, unknown> = {}) {
  return request<AutomationRun>(`/api/admin/automations/runs/${runId}/replay`, {
    method: 'POST',
    body: JSON.stringify({ fromStepIndex, inputOverride }),
  });
}

export function cancelAutomationRun(runId: string, reason = 'cancelled_by_operator') {
  return request<AutomationRun>(`/api/admin/automations/runs/${runId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function createAutomationRunEvidencePack(runId: string) {
  return request<AutomationEvidencePack>(`/api/admin/automations/runs/${runId}/evidence-pack`, {
    method: 'POST',
  });
}

export function getAutomationRunEvidencePack(runId: string) {
  return request<AutomationEvidencePack>(`/api/admin/automations/runs/${runId}/evidence-pack`);
}

export function draftAutomationTemplate(body: {
  tenantId?: string;
  companyId?: string;
  prompt: string;
  issueId?: string;
}) {
  return request('/api/admin/automations/ai/draft-template', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function syncAutomationWorkflowToN8n(workflowId: string) {
  return request(`/api/admin/automations/workflows/${workflowId}/n8n-sync`, {
    method: 'POST',
  });
}

export function exportAutomationWorkflowToN8n(workflowId: string) {
  return request<Record<string, unknown>>(`/api/admin/automations/workflows/${workflowId}/n8n-export`);
}

// ---------------------------------------------------------------------------
// Execution surface (companies / agents / issues / runs)
// ---------------------------------------------------------------------------

export interface ExecutionCompany {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionAgent {
  id: string;
  tenantId: string;
  companyId: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
  adapterType: string | null;
  model: string | null;
  instructionsPath: string | null;
  capabilities: string | null;
  heartbeatIntervalSec: number | null;
  wakeOnDemand: boolean | null;
  lastHeartbeatAt: string | null;
  pauseReason: string | null;
  pausedAt: string | null;
  reportsTo: string | null;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  budgetPeriodStart: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionAgentRuntimeState {
  agentId: string;
  sessionId: string | null;
  lastRunId: string | null;
  lastRunStatus: string | null;
  lastRunAt: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalCostCents: number;
  lastError: string | null;
  lastErrorAt: string | null;
  updatedAt: string;
}

export interface ExecutionAgentRevision {
  id: string;
  agentId: string;
  actorKind: string;
  actorId: string | null;
  source: string | null;
  changedKeys: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  createdAt: string;
}

export interface ExecutionAgentTaskSession {
  id: string;
  agentId: string;
  issueId: string | null;
  taskKey: string;
  adapterType: string | null;
  sessionDisplayId: string | null;
  status: string;
  lastRunId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionAgentWakeup {
  id: string;
  agentId: string;
  source: string | null;
  triggerDetail: string | null;
  reason: string | null;
  idempotencyKey: string | null;
  coalescedCount: number;
  createdAt: string;
}

export interface ExecutionIssue {
  id: string;
  tenantId: string;
  companyId: string;
  projectId: string;
  identifier: string;
  title: string;
  description: string | null;
  status: 'todo' | 'in_progress' | 'blocked' | 'review' | 'done' | 'closed' | string;
  priority: string | null;
  assigneeAgentId: string | null;
  parentIssueId: string | null;
  blockedOn: string[];
  metadata: Record<string, unknown>;
  executionRunId: string | null;
  latestCommentAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ExecutionRun {
  id: string;
  agentId: string;
  companyId: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  contextSnapshot: { issueId?: string } | null;
  createdAt: string;
}

export function listCompanies(tenantId: string) {
  return request<{ items: ExecutionCompany[] }>(`/api/companies?tenantId=${tenantId}`).then(r => r.items);
}

export function listCompanyAgents(companyId: string) {
  return request<{ items: ExecutionAgent[] }>(`/api/companies/${companyId}/agents`).then(r => r.items);
}

export interface ListAgentsParams {
  tenantId: string;
  companyId?: string;
  status?: 'active' | 'paused' | 'retired';
  limit?: number;
}

export function listAgents(params: ListAgentsParams) {
  const q = new URLSearchParams();
  q.set('tenantId', params.tenantId);
  if (params.companyId) q.set('companyId', params.companyId);
  if (params.status) q.set('status', params.status);
  if (params.limit) q.set('limit', String(params.limit));
  return request<{ items: ExecutionAgent[] }>(`/api/agents?${q.toString()}`).then((r) => r.items);
}

export function getActiveAgentsCount(tenantId: string) {
  return listAgents({ tenantId, status: 'active' }).then(agents => agents.length);
}

export function getAgent(agentId: string) {
  return request<ExecutionAgent>(`/api/agents/${agentId}`);
}

export interface CreateAgentBody {
  tenantId: string;
  companyId?: string;
  name: string;
  role?: string;
  status?: 'active' | 'paused' | 'retired';
  config?: Record<string, unknown>;
}

export function createAgent(body: CreateAgentBody) {
  return request<ExecutionAgent>(`/api/agents`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export interface ResumeAgentBody {
  clearLastError?: boolean;
  actorKind?: string;
  actorId?: string;
  source?: string;
}

export function resumeAgent(agentId: string, body: ResumeAgentBody = {}) {
  return request<ExecutionAgent>(`/api/agents/${agentId}/resume`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export interface ExecutionProject {
  id: string;
  tenantId: string;
  companyId: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export function listCompanyProjects(companyId: string) {
  return request<{ items: ExecutionProject[] }>(`/api/companies/${companyId}/projects`).then((r) => r.items);
}

export interface CreateIssueBody {
  tenantId: string;
  projectId: string;
  title: string;
  description?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  assigneeAgentId?: string | null;
}

export function createIssue(companyId: string, body: CreateIssueBody) {
  return request<ExecutionIssue>(`/api/companies/${companyId}/issues`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export interface ListCompanyIssuesParams {
  status?: 'todo' | 'in_progress' | 'blocked' | 'review' | 'done' | 'closed';
  limit?: number;
}

export function listCompanyIssues(companyId: string, params: ListCompanyIssuesParams = {}) {
  const search = new URLSearchParams();
  if (params.status) search.set('status', params.status);
  if (params.limit) search.set('limit', String(params.limit));
  const suffix = search.toString() ? `?${search.toString()}` : '';
  return request<{ items: ExecutionIssue[] }>(`/api/companies/${companyId}/issues${suffix}`).then(r => r.items);
}

export interface UpdateIssueBody {
  title?: string;
  description?: string | null;
  status?: 'todo' | 'in_progress' | 'blocked' | 'review' | 'done' | 'closed';
  priority?: 'critical' | 'high' | 'medium' | 'low';
  assigneeAgentId?: string | null;
  comment?: string;
}

export function patchIssue(issueId: string, body: UpdateIssueBody) {
  return request<ExecutionIssue>(`/api/issues/${issueId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function getIssue(issueId: string) {
  return request<ExecutionIssue>(`/api/issues/${issueId}`);
}

export function listCompanyRuns(companyId: string) {
  return request<{ items: ExecutionRun[] }>(`/api/companies/${companyId}/heartbeat-runs`).then(r => r.items);
}

export function wakeAgent(agentId: string, payload: Record<string, unknown> = {}) {
  return request<{ wakeupId: string; dispatchId: string; status: string }>(
    `/api/agents/${agentId}/wakeup`,
    { method: 'POST', body: JSON.stringify(payload) }
  );
}

export type DispatchStatus = 'queued' | 'dispatched' | 'completed' | 'failed' | string;

export interface DispatchQueueRow {
  id: string;
  tenantId: string;
  taskKind: string;
  targetAgentId: string;
  input: unknown;
  status: DispatchStatus;
  policyDecisionId: string | null;
  createdAt: string;
  dispatchedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface ListDispatchQueueParams {
  tenantId?: string;
  status?: DispatchStatus;
  targetAgentId?: string;
  limit?: number;
  offset?: number;
}

export function listDispatchQueue(params: ListDispatchQueueParams = {}) {
  const search = new URLSearchParams();
  if (params.tenantId) search.set('tenantId', params.tenantId);
  if (params.status) search.set('status', params.status);
  if (params.targetAgentId) search.set('targetAgentId', params.targetAgentId);
  if (params.limit) search.set('limit', String(params.limit));
  if (params.offset) search.set('offset', String(params.offset));
  const suffix = search.toString() ? `?${search.toString()}` : '';
  return request<{ items: DispatchQueueRow[]; total: number; limit: number; offset: number }>(
    `/api/dispatch${suffix}`
  );
}

export function patchAgent(
  agentId: string,
  patch: {
    name?: string;
    role?: string | null;
    status?: 'active' | 'paused' | 'retired';
    adapterType?: string | null;
    model?: string | null;
    instructionsPath?: string | null;
    capabilities?: string | null;
    heartbeatIntervalSec?: number | null;
    wakeOnDemand?: boolean | null;
    pauseReason?: string | null;
    reportsTo?: string | null;
    budgetMonthlyCents?: number;
    actorKind?: string;
    actorId?: string;
    source?: string;
  }
) {
  return request<ExecutionAgent>(`/api/agents/${agentId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export interface AgentInstructions {
  instructionsPath: string | null;
  content: string | null;
  exists: boolean;
}

export function getAgentInstructions(agentId: string) {
  return request<AgentInstructions>(`/api/agents/${agentId}/instructions`);
}

export function putAgentInstructions(agentId: string, content: string) {
  return request<{ instructionsPath: string; bytes: number }>(
    `/api/agents/${agentId}/instructions`,
    { method: 'PUT', body: JSON.stringify({ content }) }
  );
}

export function listAgentWakeups(agentId: string, limit = 50) {
  return request<{ items: ExecutionAgentWakeup[] }>(
    `/api/agents/${agentId}/wakeups?limit=${limit}`
  ).then((r) => r.items);
}

export function getAgentRuntimeState(agentId: string) {
  return request<ExecutionAgentRuntimeState | null>(`/api/agents/${agentId}/runtime-state`);
}

export function listAgentRevisions(agentId: string, limit = 50) {
  return request<{ items: ExecutionAgentRevision[] }>(
    `/api/agents/${agentId}/revisions?limit=${limit}`
  ).then((r) => r.items);
}

export function listAgentTaskSessions(agentId: string) {
  return request<{ items: ExecutionAgentTaskSession[] }>(
    `/api/agents/${agentId}/task-sessions`
  ).then((r) => r.items);
}

export interface InboxLiteIssue {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  unblockCount: number;
  createdAt: string;
  updatedAt: string;
}

export function getAgentInboxLite(agentId: string, companyId: string) {
  return request<{ items: InboxLiteIssue[] }>(
    `/api/agents/me/inbox-lite?agentId=${agentId}&companyId=${companyId}`
  ).then((r) => r.items);
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

export interface LaneRole {
  role: string;
  agentIdPrefix: string;
  allow: string[];
  description: string;
}

export interface LaneConfig {
  roles: LaneRole[];
  universalAllow: string[];
}

export function getLanes() {
  return request<LaneConfig>('/api/issues/lanes');
}

export interface LaneMatchResult {
  matched: boolean;
  ambiguous: boolean;
  triage: boolean;
  role: string | null;
  agentIdPrefix: string | null;
  reason: string;
}

export function previewLaneMatch(description: string) {
  return request<LaneMatchResult>(
    `/api/issues/lane-match-preview?description=${encodeURIComponent(description)}`
  );
}

// ---------------------------------------------------------------------------
// Demo seed
// ---------------------------------------------------------------------------

export interface SeedDemoResult {
  tenantId: string;
  companyId: string;
  workflowId: string;
  runId: string;
  approvalId: string;
  message: string;
}

export function seedDemo() {
  return request<SeedDemoResult>('/api/admin/demo/seed', { method: 'POST' });
}

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

export interface Tenant {
  id: string;
  name: string;
  description: string | null;
  industry: 'real_estate' | 'healthcare' | 'finance' | 'other' | null;
  vaultRoot: string;
  createdAt: string;
  updatedAt: string;
}

export function listTenants() {
  return request<Tenant[]>('/api/tenants');
}

export function createTenant(body: {
  name: string;
  description?: string;
  industry?: 'real_estate' | 'healthcare' | 'finance' | 'other';
}) {
  return request<Tenant>('/api/tenants', { method: 'POST', body: JSON.stringify(body) });
}

// ---------------------------------------------------------------------------
// Mission Map graph
// ---------------------------------------------------------------------------

export interface MapNode {
  id: string;
  tenantId: string;
  kind: 'company' | 'project' | 'issue' | 'agent' | 'run' | 'evidence' | 'memory';
  title: string;
  status?: string;
  meta?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  color?: string; // Server-computed color per mission-map-spec.md
}

export interface MapEdge {
  id: string;
  tenantId: string;
  fromNodeId: string;
  toNodeId: string;
  kind: 'owns' | 'blocks' | 'assigned' | 'generated' | 'references' | 'depends' | 'follows';
  meta?: Record<string, unknown>;
  createdAt: string;
}

export interface MapGraph {
  nodes: MapNode[];
  edges: MapEdge[];
}

export async function getMapGraph(tenantId: string, root?: string, depth?: number): Promise<MapGraph> {
  const params = new URLSearchParams();
  params.set('tenantId', tenantId);
  if (root) params.set('root', root);
  if (depth) params.set('depth', String(depth));

  return request<MapGraph>(`/api/admin/mission-map?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Memory vault graph
// ---------------------------------------------------------------------------

export interface VaultGraphNote {
  id: string;
  title: string;
  dir: string;
  kind: string;
  tags: string[];
  chars: number;
  edited: string;
  outgoing: number;
  backlinks: number;
}
export interface VaultGraphDir {
  dir: string;
  count: number;
  hue: number;
}
export interface VaultGraph {
  tenantId: string;
  notes: VaultGraphNote[];
  edges: [string, string][];
  dirs: VaultGraphDir[];
  generatedAt: string;
}

export async function getMemoryGraph(tenantId: string): Promise<VaultGraph> {
  const r = await request<{ ok: boolean; data: VaultGraph }>(`/api/memory/graph?tenantId=${tenantId}`);
  return r.data;
}

// ---------------------------------------------------------------------------
// Vault health: lint + hot cache
// ---------------------------------------------------------------------------

export type VaultLintKind =
  | 'orphan_page'
  | 'dead_link'
  | 'frontmatter_gap'
  | 'empty_section'
  | 'kebab_case_violation'
  | 'source_drift'
  | 'contradiction_flagged'
  | 'confidence_low'
  | 'page_oversize'
  | 'tag_audit'
  | 'log_rotation_due';

export const ALL_VAULT_LINT_KINDS: VaultLintKind[] = [
  'orphan_page',
  'dead_link',
  'frontmatter_gap',
  'empty_section',
  'kebab_case_violation',
  'source_drift',
  'contradiction_flagged',
  'confidence_low',
  'page_oversize',
  'tag_audit',
  'log_rotation_due',
];

export type VaultLintSeverity = 'info' | 'warn' | 'error';

export interface VaultLintFinding {
  kind: VaultLintKind;
  severity: VaultLintSeverity;
  path: string;
  message: string;
  detail?: string;
}

export interface VaultLintReport {
  tenantId: string;
  ranAt: string;
  runId: string;
  pageCount: number;
  findings: VaultLintFinding[];
  totals: Record<VaultLintKind, number>;
  executed: VaultLintKind[];
}

export async function getVaultLint(tenantId: string): Promise<VaultLintReport> {
  const r = await request<{ ok: boolean; data: VaultLintReport }>(`/api/memory/lint?tenantId=${tenantId}`);
  return r.data;
}

export interface VaultLintDiff {
  tenantId: string;
  currentRunId: string;
  currentRanAt: string;
  currentExecuted: VaultLintKind[];
  previousRunId: string | null;
  previousRanAt: string | null;
  previousExecuted: VaultLintKind[] | null;
  baselineReason: string | null;
  added: VaultLintFinding[];
  removed: VaultLintFinding[];
  summary: Record<string, number> | null;
}

export async function getVaultLintDiff(tenantId: string): Promise<VaultLintDiff> {
  const r = await request<{ ok: boolean; data: VaultLintDiff }>(`/api/memory/lint/diff?tenantId=${tenantId}`);
  return r.data;
}

export interface HotCacheRead {
  tenantId: string;
  key: string;
  existed: boolean;
  updatedAt: string | null;
  words: number;
  body: string;
}

export async function getHotCache(tenantId: string): Promise<HotCacheRead> {
  const r = await request<{ ok: boolean; data: HotCacheRead }>(`/api/memory/hot-cache?tenantId=${tenantId}`);
  return r.data;
}

export interface HotCacheRebuildResult {
  tenantId: string;
  words: number;
  path: string;
  rebuiltAt: string;
}

export async function rebuildHotCache(tenantId: string): Promise<HotCacheRebuildResult> {
  const r = await request<{ ok: boolean; data: HotCacheRebuildResult }>(
    '/api/memory/hot-cache/rebuild',
    { method: 'POST', body: JSON.stringify({ tenantId }) },
  );
  return r.data;
}

// ---------------------------------------------------------------------------
// Memory search
// ---------------------------------------------------------------------------

export interface SearchMemoryRequest {
  tenantId: string;
  query: string;
  limit?: number;
  offset?: number;
}

export interface SearchMemoryResult {
  path: string;
  title: string;
  excerpt: string;
  score: number;
  lastModified: string;
}

export interface SearchResponse {
  results: SearchMemoryResult[];
  total: number;
  query: string;
  tookMs: number;
}

export async function searchMemory(req: SearchMemoryRequest): Promise<SearchResponse> {
  const r = await request<{ ok: boolean; data: SearchResponse }>(
    '/api/memory/search',
    { method: 'POST', body: JSON.stringify(req) },
  );
  return r.data;
}

// ---------------------------------------------------------------------------
// Rule packs
// ---------------------------------------------------------------------------

export interface RulePackSummary {
  id: string;
  packId: string;
  packName: string | null;
  packVersion: string;
  tier: string;
  shadowMode: boolean;
  createdAt: string;
}

export interface PackMode {
  mode: 'shadow' | 'enforce';
  flippedAt: string | null;
  flippedBy: string | null;
  reason: string | null;
}

export function listRulePacks(tenantId?: string) {
  const q = tenantId ? `?tenantId=${tenantId}` : '';
  return request<{ items: RulePackSummary[] }>(`/api/policy/packs${q}`).then(r => r.items);
}

export interface RulePackStat {
  packId: string;
  packVersion: string;
  rulesCount: number;
  fires24h: number;
  lastFireAt: string | null;
}

export interface RulePackStatsResponse {
  generatedAt: string;
  windowHours: number;
  tenantId: string | null;
  totals: { rulesCount: number; fires24h: number };
  items: RulePackStat[];
}

export function getRulePackStats(tenantId?: string) {
  const q = tenantId ? `?tenantId=${tenantId}` : '';
  return request<RulePackStatsResponse>(`/api/policy/packs/stats${q}`);
}

export function getRulePack(id: string) {
  return request<RulePackSummary>(`/api/policy/packs/${id}`);
}

export function updateRulePack(id: string, body: object) {
  return request<RulePackSummary>(`/api/policy/packs/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export interface RulePackDraft {
  packId: string;
  yaml: string;
  savedBy: string | null;
  savedAt: string;
}

export function saveRulePackDraft(packId: string, yaml: string, savedBy?: string) {
  return request<{ packId: string; savedAt: string; savedBy: string | null }>(
    `/api/policy/packs/${packId}/draft`,
    {
      method: 'POST',
      body: JSON.stringify({ yaml, savedBy }),
    },
  );
}

export function getRulePackDraft(packId: string) {
  return request<RulePackDraft>(`/api/policy/packs/${packId}/draft`);
}

export function promoteRulePackDraft(packId: string) {
  return request<{ promoted: boolean; draft: RulePackDraft }>(
    `/api/policy/packs/${packId}/draft/promote`,
    { method: 'POST' },
  );
}

export function flipPackMode(
  packId: string,
  mode: 'shadow' | 'enforce',
  reviewerId: string,
  reason?: string,
): Promise<PackMode> {
  return request<PackMode>(`/api/policy/packs/${packId}/mode`, {
    method: 'PATCH',
    body: JSON.stringify({ mode, reviewerId, reason }),
  });
}

export function dryRunRulePack(id: string, body: object) {
  // POST /api/policy/evaluate — same evaluation engine used by policy check
  return request<{ decision: string; ruleId: string | null; reason: string }>(
    `/api/policy/evaluate`,
    { method: 'POST', body: JSON.stringify({ packId: id, ...body }) }
  );
}

export function uploadRulePack(body: FormData, tenantId?: string) {
  // POST /api/tenants/:id/rule-packs
  const id = tenantId ?? '00000000-0000-0000-0000-000000000001';
  return request<RulePackSummary>(`/api/tenants/${id}/rule-packs`, {
    method: 'POST',
    body,
  });
}

// ---------------------------------------------------------------------------
// Policy decisions / approval queue
// ---------------------------------------------------------------------------

export interface PolicyDecision {
  id: string;
  actionId: string;
  actorId: string;
  actorType: 'human' | 'agent' | 'system';
  actorLabel: string;
  tenantId: string;
  proposedActionKind: string;
  proposedActionSummary: string;
  decision: 'allow' | 'block' | 'route_to_review';
  decisionReason: string;
  shadowMode: boolean;
  reviewedAt: string | null;
  review: {
    reviewedBy: string | null;
    reviewedByLabel: string | null;
    reviewDecision: 'approve' | 'reject' | 'return_to_author' | null;
    reviewNote: string | null;
    reviewedAt: string | null;
  } | null;
  proposedAt: string;
  decidedAt: string;
}

export function listPendingApprovals(tenantId?: string) {
  const url = tenantId
    ? `/api/approval-queue?decision=route_to_review&reviewed=false&tenantId=${tenantId}`
    : '/api/approval-queue?decision=route_to_review&reviewed=false';
  return request<{ items: PolicyDecision[]; total: number }>(url).then(r => r.items);
}

export function reviewDecision(id: string, body: {
  decision: 'approve' | 'reject' | 'return_to_author';
  note?: string;
}) {
  return request<PolicyDecision>(`/api/approval-queue/${id}/review`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// Add a comment to an issue (used for approvals UI comment affordance)
export function addIssueComment(issueId: string, commentBody: string) {
  return request<any>(`/api/issues/${issueId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: commentBody }),
  });
}

export interface IssueComment {
  id: string;
  tenantId: string;
  issueId: string;
  authorId: string | null;
  authorLabel: string;
  body: string;
  createdAt: string;
}

export async function listIssueComments(issueId: string, limit = 25): Promise<IssueComment[]> {
  const res = await request<{ items: IssueComment[] }>(
    `/api/issues/${issueId}/comments?limit=${limit}`
  );
  return res.items;
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

export interface ActivityLogEntry {
  id: string;
  tenantId: string;
  actorId: string;
  actorLabel: string;
  actionKind: string;
  outcome: 'allow' | 'block' | 'route_to_review' | 'approved' | 'rejected';
  timestamp: string;
}

export interface ActivityLogParams {
  tenantId?: string;
  agentId?: string;
  actionKind?: string;
  decision?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export function getActivityLog(params: ActivityLogParams = {}) {
  const qs = new URLSearchParams();
  if (params.tenantId) qs.set('tenantId', params.tenantId);
  if (params.agentId) qs.set('agentId', params.agentId);
  if (params.actionKind) qs.set('actionKind', params.actionKind);
  if (params.decision) qs.set('decision', params.decision);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.offset) qs.set('offset', String(params.offset));
  const query = qs.toString();
  return request<ActivityLogEntry[]>(`/api/activity-log${query ? `?${query}` : ''}`);
}

// ---------------------------------------------------------------------------
// Scanner findings
// ---------------------------------------------------------------------------

export interface ScannerFinding {
  id: string;
  tenantId: string;
  agentId: string | null;
  agentLabel: string | null;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  ruleId: string;
  ruleName: string;
  description: string;
  filePath: string | null;
  createdAt: string;
  resolved: boolean;
  resolvedAt: string | null;
}

export function listScannerFindings(tenantId?: string) {
  const url = tenantId
    ? `/api/scanner/findings?tenantId=${tenantId}`
    : '/api/scanner/findings';
  return request<{ items: ScannerFinding[]; total: number }>(url).then(r => r.items);
}

export function resolveFinding(id: string) {
  return request<ScannerFinding>(`/api/scanner/findings/${id}/resolve`, {
    method: 'POST',
  });
}

// ---------------------------------------------------------------------------
// Compliance evidence report
// ---------------------------------------------------------------------------

export interface EvidenceReport {
  id: string;
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  summary: {
    totalDecisions: number;
    blocked: number;
    allowed: number;
    reviewed: number;
  };
}

export function getEvidenceReport(tenantId: string, periodStart: string, periodEnd: string) {
  return request<EvidenceReport>(
    `/api/compliance/evidence-report?tenantId=${tenantId}&periodStart=${periodStart}&periodEnd=${periodEnd}`
  );
}

// ---------------------------------------------------------------------------
// Persisted evidence report rows (AWO-189)
// ---------------------------------------------------------------------------

export interface EvidenceReportRow {
  id: string;
  reportId: string;
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  engineName: string;
  pdfByteLength: number;
  status: 'complete' | 'failed';
  pdfHash: string | null;
  hmac: string | null;
  signedAt: string | null;
}

export interface EvidenceReportListResponse {
  data: EvidenceReportRow[];
  pagination: { total: number; limit: number; offset: number };
}

export function listEvidenceReports(tenantId: string, limit = 25, offset = 0) {
  const url = `/api/evidence-reports?tenantId=${tenantId}&limit=${limit}&offset=${offset}`;
  return request<EvidenceReportListResponse>(url);
}

export function generateEvidenceReport(body: { tenantId: string; periodStart: string; periodEnd: string }) {
  return request<EvidenceReportRow & { pdfBase64?: string }>('/api/evidence-reports/generate', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Verify the SHA-256 of a base64-encoded PDF body matches the daemon's
 * recorded pdfHash. Pure client-side recomputation; no network call.
 */
export async function verifyEvidenceReportHash(pdfBase64: string, expectedPdfHash: string): Promise<boolean> {
  const bin = atob(pdfBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex === expectedPdfHash;
}

/**
 * Fetch the evidence report and return it as a Blob ready for download.
 *
 * Today the substrate serves a structured JSON digest. When the PDF
 * templating engine lands (AWO-74 et al), this helper switches to
 * Accept: application/pdf and returns the rendered PDF; callers don't change.
 */
export async function downloadEvidenceReport(
  tenantId: string,
  periodStart: string,
  periodEnd: string,
): Promise<Blob> {
  const url = `${BASE}/api/compliance/evidence-report?tenantId=${tenantId}&periodStart=${periodStart}&periodEnd=${periodEnd}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} — ${body}`);
  }
  const json = await res.json();
  const text = JSON.stringify(json, null, 2);
  return new Blob([text], { type: 'application/json' });
}

// ---------------------------------------------------------------------------
// Triage queue
// ---------------------------------------------------------------------------

export interface TriageIssue {
  id: string;
  identifier: string;
  title: string;
  priority: string;
  createdAt: string;
  matchedRole: string | null;
  triageReason: string | null;
  suggestedRoles: string[];
}

export interface TriageAgent {
  id: string;
  name: string;
  title: string;
}

export interface TriageQueueResponse {
  issues: TriageIssue[];
  agents: TriageAgent[];
  count: number;
}

export function getTriageQueue() {
  return request<TriageQueueResponse>('/api/admin/triage-queue');
}

export function assignTriageIssue(issueId: string, assigneeAgentId: string) {
  return request<{ success: boolean; issue: unknown }>('/api/admin/triage-queue/assign', {
    method: 'POST',
    body: JSON.stringify({ issueId, assigneeAgentId }),
  });
}

// ---------------------------------------------------------------------------
// Onboarding — editor pairing
// ---------------------------------------------------------------------------

export interface DetectedEditor {
  id: string;
  label: string;
  configPath: string;
  present: boolean;
}

export interface DetectEditorsResponse {
  editors: DetectedEditor[];
}

export interface WriteConfigResult {
  id: string;
  configPath: string;
  written: boolean;
  message: string;
}

export interface WriteConfigResponse {
  results: WriteConfigResult[];
}

export function detectEditors() {
  return request<DetectEditorsResponse>('/api/onboarding/detect-editors', {
    method: 'POST',
  });
}

export function writeEditorConfigs(reviewerId: string, editorIds: string[]) {
  return request<WriteConfigResponse>('/api/onboarding/write-config', {
    method: 'POST',
    body: JSON.stringify({ reviewerId, editorIds }),
  });
}

// ---------------------------------------------------------------------------
// Onboarding — tenant initialization (orchestrates step 1-3 in one call)
// ---------------------------------------------------------------------------

export interface InitializeOnboardingRequest {
  tenantName: string;
  tenantDescription?: string;
  industry?: 'real_estate' | 'healthcare' | 'finance' | 'other';
  selectedPack: 'minimal' | 'standard' | 'blank';
}

export interface InitializeOnboardingResponse {
  tenantId: string;
  vaultRoot: string;
}

export function initializeOnboarding(body: InitializeOnboardingRequest) {
  return request<InitializeOnboardingResponse>('/api/onboarding/initialize', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Autopilot
// ---------------------------------------------------------------------------

export interface AutopilotAction {
  id: string;
  actionId: string;
  policyDecisionId: string;
  tenantId: string;
  actorLabel: string;
  proposedActionKind: string;
  proposedActionSummary: string;
  decisionReason: string;
  status: string;
  autopilotDecision: 'allow' | 'needsApproval' | 'risky';
  riskScore: number;
  reasons: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PolicyDecisionDetail {
  id: string;
  actionId: string;
  actorId: string;
  actorType: 'human' | 'agent' | 'system';
  actorLabel: string;
  tenantId: string;
  proposedActionKind: string;
  proposedActionSummary: string;
  decision: 'allow' | 'block' | 'route_to_review';
  decisionReason: string;
  shadowMode: boolean;
  proposedAt: string;
  decidedAt: string;
  createdAt: string;
  updatedAt: string;
  overriddenBy: string | null;
  overriddenByLabel: string | null;
  originalDecision: string | null;
  overrideReason: string | null;
  overriddenAt: string | null;
  reviewedBy: string | null;
  reviewedByLabel: string | null;
  reviewDecision: 'approve' | 'reject' | 'return_to_author' | null;
  reviewNote: string | null;
  reviewedAt: string | null;
}

export interface AutopilotDispatchResponse {
  dispatched: number;
  skipped: number;
  failed: number;
  idempotent: boolean;
  results: Array<{
    actionId: string;
    decision: 'allow' | 'needsApproval' | 'risky';
    riskScore: number;
    reasons: string[];
    dispatched: boolean;
  }>;
}

interface RawApprovalQueueItem {
  id: string;
  policyDecisionId: string;
  tenantId: string;
  actorLabel: string;
  proposedActionKind: string;
  proposedActionSummary: string;
  decisionReason: string;
  status: string;
  autopilotDecision: 'allow' | 'needsApproval' | 'risky';
  riskScore: number | null;
  reasons: string | null;
  createdAt: string;
  updatedAt: string;
}

export function listAutopilotActions(tenantId?: string) {
  const params = new URLSearchParams();
  params.set('status', 'pending');
  if (tenantId) params.set('tenantId', tenantId);

  return request<{ items: RawApprovalQueueItem[]; total: number; limit: number; offset: number }>(`/api/approval-queue?${params.toString()}`)
    .then(r => r.items.map(item => ({
      ...item,
      actionId: item.policyDecisionId,
      riskScore: item.riskScore ?? 0,
      reasons: item.reasons ? (JSON.parse(item.reasons) as string[]) : [],
    })) as AutopilotAction[]);
}

export function getPolicyDecision(id: string) {
  return request<PolicyDecisionDetail>(`/api/policy/decisions/${id}`);
}

export function dispatchAutopilotActions(actionIds: string[], dryRun = false) {
  return request<AutopilotDispatchResponse>('/api/admin/autopilot/dispatch', {
    method: 'POST',
    body: JSON.stringify({ actionIds, dryRun }),
  });
}

export function getAutopilotSettings(tenantId: string) {
  return request<{ enabled: boolean; threshold: number }>(`/api/admin/autopilot/settings?tenantId=${tenantId}`);
}

export function updateAutopilotSettings(tenantId: string, enabled: boolean, threshold = 0.3) {
  return request<{ enabled: boolean; threshold: number }>(`/api/admin/autopilot/settings?tenantId=${tenantId}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled, threshold }),
  });
}

// ---------------------------------------------------------------------------
// Memory provenance
// ---------------------------------------------------------------------------

export interface ProvenanceMeta {
  path: string;
  authoringAgent: string | null;
  lastUpdatedBy: string | null;
  lastUpdatedAt: string | null;
  lastUsedBy: Array<{ agentId: string; usedAt: string }>;
  readCount: number;
  writeCount: number;
  readWindowDays: number;
}

export async function getMemoryProvenance(tenantId: string, path: string): Promise<ProvenanceMeta | null> {
  try {
    const r = await request<{ ok: boolean; data: ProvenanceMeta }>(`/api/memory/provenance?tenantId=${tenantId}&path=${encodeURIComponent(path)}`);
    return r.data;
  } catch (err) {
    // Return null if provenance doesn't exist (404) or any other error
    return null;
  }
}

// ---------------------------------------------------------------------------
// Morning Brief
// ---------------------------------------------------------------------------

export interface MorningBriefItem {
  id: string;
  kind: 'policy_review' | 'agent_blocked' | 'vault_anomaly';
  severity: 'block' | 'review' | 'info';
  title: string;
  body: string;
  call_to_action: {
    label: string;
    href: string;
  };
  evidence?: Record<string, unknown>;
}

export interface MorningBriefResponse {
  generated_at: string;
  dismissible_until: string;
  items: MorningBriefItem[];
}

export function getMorningBrief(tenantId: string) {
  return request<MorningBriefResponse | null>(`/api/tenant/${tenantId}/morning-brief`);
}

export function dismissMorningBrief(tenantId: string) {
  return request<void>(`/api/tenant/${tenantId}/morning-brief/dismiss`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

// ---------------------------------------------------------------------------
// Trust Layer
// ---------------------------------------------------------------------------

export interface TrustProvider {
  id: string;
  kind?: 'model_host' | 'vector_store' | 'object_store' | 'sidecar' | 'rule_pack';
  category?: 'llm' | 'sidecar' | 'storage' | 'rules';
  display_name?: string;
  displayName?: string;
  status: 'healthy' | 'degraded' | 'down';
  last_ok?: string;
  lastSeen?: string;
  latency_ms?: number | null;
  latencyMs?: number | null;
  errors_last_24h?: number;
  endpoint?: string | null;
  note?: string | null;
  error?: string | null;
}

export interface TrustCompany {
  name: string;
  expected: boolean;
  present: boolean;
  status: string | null;
}

export interface TrustStatus {
  summary: 'healthy' | 'degraded' | 'down';
  checked_at: string;
  providers: TrustProvider[];
  // Enriched fields from Agent 1 trust-aggregator
  daemon?: {
    pid: number;
    version: string;
    startedAt: string;
    uptimeS: number;
  };
  db?: {
    path: string;
    sizeBytes: number;
    usingProfile: boolean;
    writable: boolean;
    identity?: {
      current: string | null;
      daemonLock: string | null;
      matchesDaemonLock: boolean | null;
    };
  };
  vault?: {
    path: string;
    fileCount: number;
    manifestUpdatedAt: string | null;
  };
  profile?: {
    loaded: boolean;
    path: string | null;
    version: number | null;
    drift: string[];
  };
  companies?: TrustCompany[];
  agents?: {
    active: number;
    paused: number;
    retired: number;
  };
  dispatch?: {
    queued: number;
    dispatched: number;
    stale: number;
    duplicateWakeups: number;
  };
  backup?: {
    backupDir: string;
    latestSnapshot: string | null;
    latestVerifiedAt: string | null;
  };
  inspector?: {
    listening: boolean;
  };
  warnings?: string[];
}

export function getTrustStatus(tenantId: string, fresh = false) {
  const params = new URLSearchParams({ tenantId });
  if (fresh) params.set('fresh', '1');
  return request<TrustStatus>(`/api/admin/trust?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Flight Recorder Timeline
// ---------------------------------------------------------------------------

export type TimelineEventType = 'action' | 'policy' | 'file';

export type TimelineEventSeverity = 'allow' | 'route_to_review' | 'block' | 'info' | 'audit';

export interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  timestamp: string;
  actor: string;
  summary: string;
  severity?: TimelineEventSeverity;
  pack?: string;
  rule?: string;
  hitId?: string;
  action?: 'read' | 'write' | 'delete' | 'rename';
  filePath?: string;
  size?: number;
  sha256?: string;
  payload?: Record<string, unknown>;
}

export interface TimelineResponse {
  events: TimelineEvent[];
  nextCursor: string | null;
  prevCursor: string | null;
}

export interface PolicyHitDetail {
  id: string;
  ruleId: string;
  packName: string;
  packVersion: string;
  severity: 'allow' | 'route_to_review' | 'block';
  evidence: string;
  evidenceUrl: string;
}

export function getSessionTimeline(sessionId: string, pageSize = 50, before?: string, after?: string) {
  const params = new URLSearchParams();
  params.set('pageSize', String(pageSize));
  if (before) params.set('before', before);
  if (after) params.set('after', after);

  return request<TimelineResponse>(`/api/sessions/${sessionId}/timeline?${params.toString()}`);
}

export function getPolicyHitDetail(hitId: string) {
  return request<PolicyHitDetail>(`/api/policy-hits/${hitId}`);
}

export function downloadSessionTimelineCsv(sessionId: string) {
  return fetch(`${BASE}/api/sessions/${sessionId}/timeline.csv`)
    .then(res => {
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      return res.blob();
    });
}

// ---------------------------------------------------------------------------
// File access log
// ---------------------------------------------------------------------------

export interface FileAccessEntry {
  id: string;
  tenantId: string;
  agentId: string;
  runId: string | null;
  filePath: string;
  op: 'read' | 'write' | 'create' | 'delete';
  createdAt: string;
}

export interface FileAccessResponse {
  entries: FileAccessEntry[];
  total: number;
}

export function getSessionFileAccess(sessionId: string) {
  return request<FileAccessResponse>(`/api/sessions/${sessionId}/file-access`);
}

// ---------------------------------------------------------------------------
// Insights — phase 1b memory architecture
// ---------------------------------------------------------------------------

export type InsightFrameType =
  | 'preference'
  | 'fact'
  | 'plan'
  | 'constraint'
  | 'feedback'
  | 'error_pattern';

export type InsightSource =
  | 'agent_reflection'
  | 'user_correction'
  | 'task_outcome'
  | 'manual';

export interface Insight {
  id: string;
  frameType: InsightFrameType;
  subject: string | null;
  content: string;
  source: InsightSource;
  importance: number;
  validated: boolean;
  episodeId: string | null;
  createdAt: string;
}

export interface ListInsightsParams {
  tenantId: string;
  frameType?: InsightFrameType;
  subject?: string;
  lifecycle?: 'active' | 'archived' | 'invalidated';
  limit?: number;
}

export async function listInsights(params: ListInsightsParams): Promise<Insight[]> {
  const q = new URLSearchParams();
  q.set('tenantId', params.tenantId);
  if (params.frameType) q.set('frameType', params.frameType);
  if (params.subject) q.set('subject', params.subject);
  if (params.lifecycle) q.set('lifecycle', params.lifecycle);
  if (params.limit) q.set('limit', String(params.limit));
  const r = await request<{ ok: boolean; data: { count: number; items: Insight[] } }>(
    `/api/memory/insight?${q.toString()}`,
  );
  return r.data.items;
}

export interface UpdateInsightBody {
  tenantId: string;
  content?: string;
  validated?: boolean;
  importance?: number;
  subject?: string | null;
}

export async function updateInsight(id: string, body: UpdateInsightBody): Promise<Insight> {
  const r = await request<{ ok: boolean; data: Insight }>(
    `/api/memory/insight/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  return r.data;
}

export async function archiveInsight(id: string, tenantId: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/memory/insight/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify({ tenantId }),
  });
}
