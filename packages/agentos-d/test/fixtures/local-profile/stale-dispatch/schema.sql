-- Minimal dispatch_queue mirroring the live schema. Single row with
-- dispatched_at set to one hour before the fixture was generated, so the
-- stale-dispatch warning fires regardless of when the test runs against it.
CREATE TABLE dispatch_queue (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  task_kind TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  policy_decision_id TEXT,
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  completed_at TEXT,
  error TEXT
);

-- Stale-by-construction: dispatched_at = 2026-05-16T00:00:00Z, status still
-- 'dispatched'. Trust aggregator flags dispatches in this state >5 min old.
INSERT INTO dispatch_queue (id, tenant_id, task_kind, target_agent_id, input, status, created_at, dispatched_at)
VALUES (
  'stale-1',
  '00000000-0000-4000-8000-000000000001',
  'wakeup',
  'agent-stale',
  '{"issueId":"AGE-STALE"}',
  'dispatched',
  '2026-05-16T00:00:00Z',
  '2026-05-16T00:00:00Z'
);
