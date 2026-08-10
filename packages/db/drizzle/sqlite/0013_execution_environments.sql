CREATE TABLE execution_environments (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  current_version INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX execution_environments_project_name_uq
  ON execution_environments (project_id, normalized_name);
CREATE INDEX execution_environments_project_status_idx
  ON execution_environments (project_id, status);

CREATE TABLE execution_environment_versions (
  id TEXT PRIMARY KEY NOT NULL,
  environment_id TEXT NOT NULL REFERENCES execution_environments(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  variables_json TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX execution_environment_versions_number_uq
  ON execution_environment_versions (environment_id, version);

ALTER TABLE run_batches ADD COLUMN environment_id TEXT
  REFERENCES execution_environments(id) ON DELETE RESTRICT;
ALTER TABLE run_batches ADD COLUMN environment_version_id TEXT
  REFERENCES execution_environment_versions(id) ON DELETE RESTRICT;
