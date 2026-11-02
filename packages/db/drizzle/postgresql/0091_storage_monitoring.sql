-- Full infrastructure monitoring is shared by all Web nodes; Lite reads its local disk directly.
CREATE TABLE storage_monitoring_settings (
  target_id TEXT PRIMARY KEY,
  source_json TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL
);
