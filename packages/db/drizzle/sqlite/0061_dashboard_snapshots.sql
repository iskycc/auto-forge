CREATE TABLE dashboard_snapshots (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_version_id TEXT NOT NULL REFERENCES project_versions(id) ON DELETE CASCADE,
  time_zone TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, project_version_id)
);

CREATE INDEX dashboard_snapshots_refresh_idx ON dashboard_snapshots (refreshed_at);
