CREATE TABLE log_databases (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  connection_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE log_database_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_database_id TEXT REFERENCES log_databases(id),
  revision INTEGER NOT NULL DEFAULT 1
);
INSERT INTO log_database_settings(id) VALUES(1);
-- Keep bindings after batch deletion until log cleanup succeeds.
CREATE TABLE run_batch_log_storage (
  batch_id TEXT PRIMARY KEY NOT NULL,
  database_id TEXT REFERENCES log_databases(id),
  stored_bytes BIGINT NOT NULL DEFAULT 0 CHECK (stored_bytes >= 0)
);
CREATE INDEX run_batch_log_storage_database_idx ON run_batch_log_storage(database_id, batch_id);
