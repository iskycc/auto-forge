-- Metadata is compatible with Full; Lite keeps its existing local log store.
CREATE TABLE platform_nodes (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  internal_base_url TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE run_batch_log_locations (
  batch_id TEXT PRIMARY KEY NOT NULL,
  node_id TEXT NOT NULL REFERENCES platform_nodes(id),
  stored_bytes INTEGER NOT NULL DEFAULT 0 CHECK (stored_bytes >= 0)
);
CREATE INDEX run_batch_log_locations_node_idx ON run_batch_log_locations(node_id, batch_id);
