CREATE TABLE project_version_copies (
  id TEXT PRIMARY KEY NOT NULL,
  source_project_id TEXT NOT NULL,
  source_version_id TEXT NOT NULL,
  source_version_name TEXT NOT NULL,
  target_project_id TEXT NOT NULL,
  target_version_id TEXT NOT NULL,
  target_version_name TEXT NOT NULL,
  target_mode TEXT NOT NULL DEFAULT 'new' CHECK (target_mode IN ('new','existing')),
  request_key TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'snapshot',
  total_rows INTEGER NOT NULL DEFAULT 0,
  copied_rows INTEGER NOT NULL DEFAULT 0,
  total_objects INTEGER NOT NULL DEFAULT 0,
  copied_objects INTEGER NOT NULL DEFAULT 0,
  total_attempts INTEGER NOT NULL DEFAULT 0,
  copied_attempts INTEGER NOT NULL DEFAULT 0,
  progress_percent INTEGER NOT NULL DEFAULT 0,
  snapshot_json TEXT,
  cursor INTEGER NOT NULL DEFAULT -1,
  collection_index INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_expires_at TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(requested_by, request_key)
);
CREATE UNIQUE INDEX project_version_copies_one_active ON project_version_copies ((1))
  WHERE status IN ('queued','running','cancelling');
CREATE INDEX project_version_copies_source_page ON project_version_copies (source_project_id,created_at,id);
CREATE INDEX project_version_copies_target_page ON project_version_copies (target_project_id,created_at,id);
CREATE UNIQUE INDEX project_version_copies_reserved_target ON project_version_copies (target_version_id) WHERE status NOT IN ('completed','cancelled');
CREATE INDEX case_suites_version_copy_scope ON case_suites (project_id, ((policy_json::jsonb ->> 'projectVersionId')));
CREATE INDEX run_batches_version_copy_scope ON run_batches (project_id, ((policy_json::jsonb ->> 'projectVersionId')));
