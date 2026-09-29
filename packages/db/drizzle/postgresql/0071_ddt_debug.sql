-- Personal debugging never changes the shared case identity or formal execution mapping.
ALTER TABLE ddt_import_jobs ADD COLUMN debug_owner_id TEXT;
CREATE TABLE ddt_debug_workspaces (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_version_id TEXT NOT NULL REFERENCES project_versions(id) ON DELETE CASCADE,
  test_stage_id TEXT NOT NULL REFERENCES test_stages(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_key TEXT NOT NULL,
  PRIMARY KEY(project_id, project_version_id, test_stage_id, owner_user_id)
);
CREATE TABLE ddt_debug_cases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_version_id TEXT NOT NULL REFERENCES project_versions(id) ON DELETE CASCADE,
  test_stage_id TEXT NOT NULL REFERENCES test_stages(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL,
  case_id_normalized TEXT NOT NULL,
  data_json TEXT NOT NULL,
  source_name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, project_version_id, test_stage_id, owner_user_id, case_id_normalized)
);
CREATE TABLE ddt_debug_import_rows (
  row_key TEXT PRIMARY KEY,
  outcome TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES ddt_import_jobs(id) ON DELETE CASCADE
);
