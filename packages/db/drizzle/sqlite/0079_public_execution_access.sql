CREATE TABLE public_batch_access (
  batch_id TEXT PRIMARY KEY NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE public_attempt_access (
  attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES run_attempts(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
