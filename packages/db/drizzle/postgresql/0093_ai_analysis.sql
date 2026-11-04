CREATE TABLE ai_model_configuration (
  id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL,
  configuration_json TEXT NOT NULL,
  encrypted_key TEXT
);
CREATE TABLE ai_analysis_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  attempt_id TEXT,
  requested_by TEXT NOT NULL,
  request_key TEXT NOT NULL,
  status TEXT NOT NULL,
  cursor TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  prepared INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  groups_planned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(batch_id, request_key)
);
CREATE INDEX ai_analysis_jobs_batch_created_idx ON ai_analysis_jobs(batch_id, created_at, id);
CREATE INDEX ai_analysis_jobs_work_idx ON ai_analysis_jobs(status, lease_expires_at, created_at);
CREATE TABLE ai_analysis_items (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES ai_analysis_jobs(id) ON DELETE CASCADE,
  execution_run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence_key TEXT,
  signature TEXT,
  conclusion TEXT,
  drafts_json TEXT NOT NULL DEFAULT '[]',
  part_cursor INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, execution_run_id)
);
CREATE INDEX ai_analysis_items_work_idx ON ai_analysis_items(status, available_at, lease_expires_at, id);
CREATE INDEX ai_analysis_items_job_signature_idx ON ai_analysis_items(job_id, signature, id);
CREATE INDEX ai_analysis_items_attempt_updated_idx ON ai_analysis_items(attempt_id, updated_at, id);
CREATE INDEX ai_analysis_items_run_fk_idx ON ai_analysis_items(execution_run_id, id);
CREATE TABLE ai_analysis_conclusions (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL REFERENCES ai_analysis_items(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  conclusion TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ai_analysis_conclusions_export_idx ON ai_analysis_conclusions(batch_id, attempt_id, created_at, id);
CREATE INDEX ai_analysis_conclusions_item_fk_idx ON ai_analysis_conclusions(item_id);
CREATE TABLE ai_analysis_groups (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES ai_analysis_jobs(id) ON DELETE CASCADE,
  signature TEXT NOT NULL,
  member_count INTEGER NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  cursor TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  conclusion TEXT,
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id,signature)
);
CREATE INDEX ai_analysis_groups_work_idx ON ai_analysis_groups(status,available_at,lease_expires_at);
CREATE TABLE ai_model_admission (
  id TEXT PRIMARY KEY NOT NULL,
  window_expires_at TEXT NOT NULL,
  cooling_until TEXT NOT NULL,
  last_token TEXT,
  requests INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0
);
INSERT INTO ai_model_admission(id, window_expires_at, cooling_until) VALUES ('default', '', '');
CREATE TABLE ai_model_leases (
  token TEXT PRIMARY KEY NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX ai_model_leases_expiry_idx ON ai_model_leases(expires_at);
CREATE INDEX run_batches_ai_terminal_idx ON run_batches(status, updated_at, id);
