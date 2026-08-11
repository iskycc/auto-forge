ALTER TABLE roles ADD COLUMN active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE projects ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT;

UPDATE projects
SET owner_user_id = (
  SELECT user_id FROM user_system_roles
  WHERE role_id = '00000000-0000-7000-8100-000000000001'
  ORDER BY assigned_at ASC LIMIT 1
)
WHERE owner_user_id IS NULL;

ALTER TABLE runners ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE runners ADD COLUMN credential_revoked_at TEXT;
ALTER TABLE runners ADD COLUMN deregistered_at TEXT;

ALTER TABLE case_sources ADD COLUMN project_id TEXT NOT NULL DEFAULT '00000000-0000-7000-8000-000000000001';
ALTER TABLE case_sources ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active'
  CHECK (lifecycle_status IN ('active', 'archived', 'deleting'));
ALTER TABLE case_sources ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE case_sources ADD COLUMN imported_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE case_sources ADD COLUMN updated_at TEXT;
UPDATE case_sources SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE case_sources ALTER COLUMN updated_at SET NOT NULL;

DROP INDEX case_sources_sha256_uq;
DROP INDEX case_sources_one_authoritative_uq;
CREATE UNIQUE INDEX case_sources_project_sha256_uq ON case_sources(project_id, sha256);
CREATE UNIQUE INDEX case_sources_project_authoritative_uq
  ON case_sources(project_id, authoritative) WHERE authoritative = TRUE;
CREATE INDEX case_sources_project_created_idx ON case_sources(project_id, created_at);

ALTER TABLE case_definitions ADD COLUMN project_id TEXT NOT NULL DEFAULT '00000000-0000-7000-8000-000000000001';
ALTER TABLE case_definitions ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE case_definitions ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE case_definitions ADD COLUMN parameters_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE case_definitions ADD COLUMN archived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE case_definitions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE case_definitions ADD COLUMN updated_by TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX case_definitions_project_class_idx ON case_definitions(project_id, class_name);

ALTER TABLE case_versions ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE case_versions ADD COLUMN change_reason TEXT NOT NULL DEFAULT 'source.import';

ALTER TABLE case_suites ADD COLUMN project_id TEXT NOT NULL DEFAULT '00000000-0000-7000-8000-000000000001';
ALTER TABLE case_suites ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'archived'));
ALTER TABLE case_suites ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE case_suites ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE case_suites ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE case_suites ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE case_suites ADD COLUMN updated_by TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX case_suites_project_updated_idx ON case_suites(project_id, updated_at);

ALTER TABLE execution_runs ADD COLUMN parameters_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE case_source_comparisons (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  current_source_id TEXT REFERENCES case_sources(id) ON DELETE SET NULL,
  candidate_source_id TEXT NOT NULL REFERENCES case_sources(id) ON DELETE CASCADE,
  added_json TEXT NOT NULL,
  changed_json TEXT NOT NULL,
  removed_json TEXT NOT NULL,
  conflicts_json TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX case_source_comparisons_project_created_idx
  ON case_source_comparisons(project_id, created_at);

CREATE TABLE case_suite_versions (
  id TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL REFERENCES case_suites(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  change_reason TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(suite_id, version)
);

CREATE TABLE case_suite_schedules (
  id TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL REFERENCES case_suites(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cron_expression TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  missed_run_policy TEXT NOT NULL CHECK (missed_run_policy IN ('skip', 'run-once')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  next_trigger_at TEXT NOT NULL,
  last_trigger_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE scheduled_trigger_receipts (
  schedule_id TEXT NOT NULL REFERENCES case_suite_schedules(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  batch_id TEXT REFERENCES run_batches(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('created', 'skipped', 'failed')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(schedule_id, scheduled_for)
);

CREATE TABLE ldap_sync_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual', 'scheduled')),
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  processed_users INTEGER NOT NULL DEFAULT 0,
  disabled_users INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_summary TEXT,
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  scheduled_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ldap_sync_jobs_status_scheduled_idx ON ldap_sync_jobs(status, scheduled_at);

CREATE TABLE service_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  system_permissions_json TEXT NOT NULL DEFAULT '[]',
  project_permissions_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  replaced_by_token_id TEXT REFERENCES api_tokens(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX api_tokens_account_active_idx
  ON api_tokens(service_account_id, revoked_at, expires_at);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX notifications_user_unread_idx ON notifications(user_id, read_at, created_at);

CREATE TABLE retention_policies (
  category TEXT PRIMARY KEY,
  retention_days INTEGER NOT NULL,
  minimum_days INTEGER NOT NULL,
  maximum_days INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE cleanup_jobs (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  object_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'succeeded', 'failed', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  error_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(category, resource_type, resource_id)
);
CREATE INDEX cleanup_jobs_claim_idx ON cleanup_jobs(status, available_at, lease_expires_at);

CREATE TABLE analytics_facts (
  attempt_id TEXT PRIMARY KEY REFERENCES run_attempts(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
  suite_id TEXT NOT NULL,
  case_definition_id TEXT NOT NULL,
  case_version INTEGER NOT NULL,
  runner_id TEXT NOT NULL REFERENCES runners(id) ON DELETE RESTRICT,
  environment_version_id TEXT,
  outcome TEXT NOT NULL,
  result_code TEXT,
  failure_signature TEXT,
  duration_ms BIGINT,
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX analytics_facts_dimensions_idx
  ON analytics_facts(project_id, completed_at, suite_id, case_definition_id, runner_id);

CREATE TABLE analytics_exports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  format TEXT NOT NULL CHECK (format IN ('csv', 'json')),
  filters_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  row_count INTEGER,
  size_bytes BIGINT,
  object_key TEXT,
  error_summary TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE system_settings (
  setting_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);
