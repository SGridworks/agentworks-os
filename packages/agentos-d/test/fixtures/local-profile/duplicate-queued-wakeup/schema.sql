-- Two queued wakeup rows for the same issueId. wake-on-assign daemon
-- de-duplicates on $.payload.issueId OR $.issueId; this fixture exercises
-- the bare $.issueId path. Trust aggregator surfaces duplicate-queued-wakeup
-- when more than one queued row exists for a single issueId.
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

INSERT INTO dispatch_queue (id, tenant_id, task_kind, target_agent_id, input, status, created_at)
VALUES
  ('dup-1','00000000-0000-4000-8000-000000000001','wakeup','agent-a','{"issueId":"AGE-DUP"}','queued','2026-05-16T00:00:00Z'),
  ('dup-2','00000000-0000-4000-8000-000000000001','wakeup','agent-a','{"issueId":"AGE-DUP"}','queued','2026-05-16T00:00:01Z');
