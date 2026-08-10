CREATE TABLE execution_secrets (
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

CREATE UNIQUE INDEX execution_secrets_project_name_uq
  ON execution_secrets (project_id, normalized_name);
CREATE INDEX execution_secrets_project_status_idx
  ON execution_secrets (project_id, status);

CREATE TABLE execution_secret_versions (
  id TEXT PRIMARY KEY NOT NULL,
  secret_id TEXT NOT NULL REFERENCES execution_secrets(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  value_encrypted TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX execution_secret_versions_number_uq
  ON execution_secret_versions (secret_id, version);

ALTER TABLE execution_environment_versions
  ADD COLUMN secret_bindings_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE run_batches
  ADD COLUMN secret_bindings_json TEXT NOT NULL DEFAULT '[]';
