CREATE TABLE dispatch_attempts (
  id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  task_kind TEXT,
  provider TEXT,
  model TEXT,
  credential_source TEXT,
  health_state TEXT,
  failure_class TEXT,
  fallback_reason TEXT,
  log_pointer TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (dispatch_id) REFERENCES dispatch_queue(id)
);