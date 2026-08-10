CREATE TABLE attempt_log_chunks (
  attempt_id TEXT NOT NULL REFERENCES run_attempts(id) ON DELETE CASCADE,
  stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'agent')),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  content TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  recorded_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, stream, sequence)
);

CREATE INDEX attempt_log_chunks_read_idx
  ON attempt_log_chunks (attempt_id, stream, sequence);
