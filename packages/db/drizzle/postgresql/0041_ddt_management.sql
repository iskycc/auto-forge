CREATE TABLE ddt_import_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_version_id TEXT NOT NULL REFERENCES project_versions(id) ON DELETE CASCADE,
  test_stage_id TEXT NOT NULL REFERENCES test_stages(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN (
    'previewed', 'queued', 'running', 'cancel_requested',
    'succeeded', 'partially_succeeded', 'failed', 'cancelled'
  )),
  conflict_strategy TEXT CHECK (conflict_strategy IN ('overwrite', 'skip', 'error')),
  uploads_json TEXT NOT NULL DEFAULT '[]',
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  total_files INTEGER NOT NULL DEFAULT 0,
  valid_files INTEGER NOT NULL DEFAULT 0,
  total_rows INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  failed_files INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_summary TEXT,
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX ddt_import_jobs_scope_created_idx
  ON ddt_import_jobs(project_id, project_version_id, test_stage_id, created_at DESC, id);
CREATE INDEX ddt_import_jobs_status_idx ON ddt_import_jobs(status, updated_at);

CREATE TABLE ddt_import_files (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES ddt_import_jobs(id) ON DELETE CASCADE,
  upload_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  archive_entry_name TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'valid', 'excluded', 'pending', 'importing', 'succeeded', 'failed', 'cancelled'
  )),
  row_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX ddt_import_files_job_idx ON ddt_import_files(job_id, created_at, id);

CREATE TABLE ddt_cases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_version_id TEXT NOT NULL REFERENCES project_versions(id) ON DELETE CASCADE,
  test_stage_id TEXT NOT NULL REFERENCES test_stages(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL,
  case_id_normalized TEXT NOT NULL,
  sr_num TEXT NOT NULL,
  sr_num_normalized TEXT NOT NULL,
  case_kind TEXT NOT NULL CHECK (case_kind IN ('standard', 'journey')),
  data_json TEXT NOT NULL,
  source_file_id TEXT REFERENCES ddt_import_files(id) ON DELETE SET NULL,
  source_name TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX ddt_cases_scope_case_id_uq
  ON ddt_cases(project_id, project_version_id, test_stage_id, case_id_normalized);
CREATE INDEX ddt_cases_scope_sr_num_idx
  ON ddt_cases(project_id, project_version_id, test_stage_id, sr_num_normalized, case_id_normalized);
CREATE INDEX ddt_cases_scope_updated_idx
  ON ddt_cases(project_id, project_version_id, test_stage_id, updated_at DESC, id);
CREATE INDEX ddt_cases_source_idx ON ddt_cases(source_file_id);

CREATE TABLE ddt_case_history (
  id TEXT PRIMARY KEY,
  ddt_case_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN (
    'edit', 'bulk_edit', 'import_overwrite', 'restore'
  )),
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  source_name TEXT NOT NULL DEFAULT '',
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX ddt_case_history_case_idx ON ddt_case_history(ddt_case_id, created_at DESC, id);

CREATE TABLE ddt_deleted_cases (
  id TEXT PRIMARY KEY,
  ddt_case_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_version_id TEXT NOT NULL REFERENCES project_versions(id) ON DELETE CASCADE,
  test_stage_id TEXT NOT NULL REFERENCES test_stages(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL,
  case_id_normalized TEXT NOT NULL,
  sr_num TEXT NOT NULL,
  sr_num_normalized TEXT NOT NULL,
  case_kind TEXT NOT NULL CHECK (case_kind IN ('standard', 'journey')),
  data_json TEXT NOT NULL,
  source_file_id TEXT,
  source_name TEXT NOT NULL DEFAULT '',
  case_created_at TEXT NOT NULL,
  case_updated_at TEXT NOT NULL,
  deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TEXT NOT NULL
);

CREATE INDEX ddt_deleted_cases_scope_idx
  ON ddt_deleted_cases(project_id, project_version_id, test_stage_id, deleted_at DESC, id);
CREATE INDEX ddt_deleted_cases_case_id_idx
  ON ddt_deleted_cases(project_id, project_version_id, test_stage_id, case_id_normalized);

CREATE TABLE ddt_case_templates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_version_id TEXT NOT NULL REFERENCES project_versions(id) ON DELETE CASCADE,
  test_stage_id TEXT NOT NULL REFERENCES test_stages(id) ON DELETE CASCADE,
  sr_num TEXT NOT NULL,
  sr_num_normalized TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rules_json TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX ddt_case_templates_scope_sr_num_uq
  ON ddt_case_templates(project_id, project_version_id, test_stage_id, sr_num_normalized);
CREATE INDEX ddt_case_templates_scope_updated_idx
  ON ddt_case_templates(project_id, project_version_id, test_stage_id, updated_at DESC, id);

CREATE TABLE ddt_import_case_ids (
  job_id TEXT NOT NULL REFERENCES ddt_import_jobs(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL,
  case_id_normalized TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('inserted', 'updated', 'unchanged', 'skipped')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(job_id, case_id_normalized)
);

CREATE INDEX ddt_import_case_ids_order_idx ON ddt_import_case_ids(job_id, case_id_normalized);
