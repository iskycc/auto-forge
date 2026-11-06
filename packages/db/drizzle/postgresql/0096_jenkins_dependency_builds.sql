CREATE TABLE version_jenkins_dependencies (
  version_id TEXT PRIMARY KEY NOT NULL REFERENCES project_versions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL DEFAULT 1,
  connection_ciphertext TEXT NOT NULL,
  build_revision INTEGER NOT NULL DEFAULT 0,
  build_status TEXT,
  build_json TEXT,
  updated_at TEXT NOT NULL,
  CHECK (revision > 0 AND build_revision >= 0),
  CHECK (build_status IS NULL OR build_status IN ('submitting','queued','running','succeeded','failed','cancelled','unknown','closed'))
);
CREATE INDEX version_jenkins_dependencies_project_idx ON version_jenkins_dependencies(project_id,version_id);
