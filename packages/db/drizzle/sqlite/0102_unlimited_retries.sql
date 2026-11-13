-- autoforge:rebuild-with-foreign-keys-disabled
-- Preserve batch IDs, children, indexes and historical snapshots; validate references before commit.
CREATE TABLE run_batches_retry_upgrade (
  id TEXT PRIMARY KEY NOT NULL,
  suite_id TEXT NOT NULL,
  suite_name TEXT NOT NULL,
  suite_version INTEGER NOT NULL CHECK (suite_version > 0),
  status TEXT NOT NULL CHECK (status IN ('queued', 'dispatching', 'scheduled', 'running', 'succeeded', 'failed', 'cancelled')),
  retry_limit INTEGER NOT NULL CHECK (retry_limit >= 0),
  environment_json TEXT NOT NULL,
  total_runs INTEGER NOT NULL CHECK (total_runs > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  project_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  cancel_requested_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  queue_timeout_ms INTEGER NOT NULL DEFAULT 86400000,
  claim_timeout_ms INTEGER NOT NULL DEFAULT 300000,
  execution_timeout_ms INTEGER NOT NULL DEFAULT 3600000,
  upload_timeout_ms INTEGER NOT NULL DEFAULT 600000,
  environment_id TEXT REFERENCES execution_environments(id) ON DELETE RESTRICT,
  environment_version_id TEXT REFERENCES execution_environment_versions(id) ON DELETE RESTRICT,
  secret_bindings_json TEXT NOT NULL DEFAULT '[]',
  policy_json TEXT,
  adapter_runtime_json TEXT,
  retry_mode TEXT NOT NULL DEFAULT 'immediate' CHECK (retry_mode IN ('immediate', 'round')),
  current_round INTEGER NOT NULL DEFAULT 1,
  attempt_logs_path TEXT,
  sequence_number INTEGER NOT NULL DEFAULT 0,
  scheduled_for TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
  batch_kind TEXT NOT NULL DEFAULT 'standard' CHECK (batch_kind IN ('standard', 'final_failure_rerun', 'case_log_rerun')),
  parent_batch_id TEXT,
  source_execution_run_id TEXT,
  requested_by_username TEXT,
  requested_by_source TEXT CHECK (requested_by_source IS NULL OR requested_by_source IN ('local', 'ldap')),
  public_execution_json TEXT,
  public_request_key TEXT,
  terminated_by_json TEXT,
  pause_requested_at TEXT,
  queue_resumed_at TEXT
);
INSERT INTO run_batches_retry_upgrade
SELECT * FROM run_batches;
DROP TABLE run_batches;
ALTER TABLE run_batches_retry_upgrade RENAME TO run_batches;
CREATE INDEX run_batches_status_created_at_idx ON run_batches (status, created_at);
CREATE INDEX run_batches_suite_id_idx ON run_batches (suite_id);
CREATE INDEX run_batches_project_created_id_idx
ON run_batches(project_id, created_at, id);
CREATE INDEX run_batches_status_scheduled_for_idx
  ON run_batches(status, scheduled_for);
CREATE INDEX run_batches_kind_created_at_idx
  ON run_batches(batch_kind, created_at, id);
CREATE INDEX run_batches_case_log_family_idx
  ON run_batches(parent_batch_id, source_execution_run_id, created_at, id)
  WHERE batch_kind = 'case_log_rerun';
CREATE INDEX run_batches_version_copy_scope ON run_batches (project_id, (json_extract(policy_json, '$.projectVersionId')));
CREATE UNIQUE INDEX run_batches_public_request_uq ON run_batches(public_request_key);
CREATE INDEX run_batches_suite_status_created_idx ON run_batches(suite_id, status, created_at, id);
CREATE INDEX run_batches_public_recent_idx ON run_batches(suite_id, created_at DESC, id DESC) WHERE public_execution_json IS NOT NULL;
CREATE INDEX run_batches_log_archive_month_idx ON run_batches(status,updated_at,id);
CREATE INDEX run_batches_ai_terminal_idx ON run_batches(status, updated_at, id);

ALTER TABLE run_batch_round_recoveries ADD COLUMN credential_rule_id TEXT;
