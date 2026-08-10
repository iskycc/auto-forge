CREATE TABLE queue_jobs (
  message_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  schema_version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  deduplication_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available', 'leased', 'completed', 'dead_letter')),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  maximum_deliveries INTEGER NOT NULL DEFAULT 8 CHECK (maximum_deliveries > 0),
  last_error_code TEXT,
  last_error_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE UNIQUE INDEX queue_jobs_deduplication_uq ON queue_jobs (deduplication_key);
CREATE INDEX queue_jobs_claim_idx
  ON queue_jobs (status, available_at, priority DESC, created_at, message_id);
CREATE INDEX queue_jobs_lease_idx ON queue_jobs (status, lease_expires_at);
