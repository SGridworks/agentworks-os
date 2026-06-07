-- Minimal schema mirroring relevant columns of the live execution_companies
-- table. Only the fields the trust aggregator inspects are present.
CREATE TABLE execution_companies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Tenant baseline matches docs/local-profile-example.json. Alphabetically
-- first company ("AgentWorks") intentionally omitted so the missing-expected-
-- company warning fires.
INSERT INTO execution_companies VALUES
  ('c2','00000000-0000-4000-8000-000000000001','E2E-Test-Company','active','2026-05-16T00:00:00Z','2026-05-16T00:00:00Z');
