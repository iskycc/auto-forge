CREATE TABLE read_model_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  query_json TEXT NOT NULL,
  payload_json TEXT,
  generation TEXT,
  generated_at TEXT,
  accessed_at TEXT NOT NULL,
  refresh_after TEXT NOT NULL,
  requested_revision INTEGER NOT NULL DEFAULT 0,
  generated_revision INTEGER NOT NULL DEFAULT -1,
  lease_token TEXT,
  lease_expires_at TEXT,
  failed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX read_model_refresh_idx ON read_model_snapshots(refresh_after, accessed_at);
CREATE INDEX read_model_project_idx ON read_model_snapshots(project_id);
CREATE TABLE read_model_snapshot_parts (
  snapshot_id TEXT NOT NULL REFERENCES read_model_snapshots(id) ON DELETE CASCADE,
  generation TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, generation, ordinal)
);

CREATE INDEX case_definitions_snapshot_page_idx
  ON case_definitions(project_id, project_version_id, test_stage_id, id);
