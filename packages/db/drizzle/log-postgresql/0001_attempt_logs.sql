CREATE TABLE log_storage_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  database_id TEXT NOT NULL,
  platform_id TEXT NOT NULL
);
CREATE TABLE log_batches (
  batch_id TEXT PRIMARY KEY NOT NULL,
  stored_bytes BIGINT NOT NULL DEFAULT 0 CHECK(stored_bytes >= 0)
);
CREATE TABLE log_streams (
  batch_id TEXT NOT NULL REFERENCES log_batches(batch_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL,
  stream TEXT NOT NULL CHECK(stream IN ('stdout','stderr','agent')),
  acknowledged_sequence BIGINT NOT NULL DEFAULT -1,
  PRIMARY KEY(batch_id, attempt_id, stream)
);
CREATE TABLE log_chunks (
  batch_id TEXT NOT NULL REFERENCES log_batches(batch_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL,
  stream TEXT NOT NULL CHECK(stream IN ('stdout','stderr','agent')),
  sequence BIGINT NOT NULL CHECK(sequence >= 0),
  content BYTEA NOT NULL,
  content_sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  recorded_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY(batch_id, attempt_id, stream, sequence)
);
