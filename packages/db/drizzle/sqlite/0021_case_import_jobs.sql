CREATE TABLE case_import_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL,
  progress_percent INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error_code TEXT,
  error_summary TEXT,
  requested_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
CREATE UNIQUE INDEX case_import_jobs_idempotency_uq
  ON case_import_jobs(project_id, idempotency_key);
CREATE INDEX case_import_jobs_status_idx ON case_import_jobs(status, updated_at);
