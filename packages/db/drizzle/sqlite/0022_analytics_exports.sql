CREATE TABLE analytics_export_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  requested_by TEXT NOT NULL,
  project_ids_json TEXT,
  filter_json TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('csv', 'json')),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancel_requested', 'cancelled')),
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  row_count INTEGER,
  size_bytes INTEGER,
  sha256 TEXT,
  object_key TEXT,
  file_name TEXT,
  error_code TEXT,
  error_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE(requested_by, idempotency_key)
);

CREATE INDEX analytics_export_jobs_owner_idx
  ON analytics_export_jobs(requested_by, created_at DESC, id);

CREATE INDEX analytics_export_jobs_status_idx
  ON analytics_export_jobs(status, updated_at, id);
