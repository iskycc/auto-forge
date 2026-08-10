CREATE TABLE transactional_outbox (
  message_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  schema_version INTEGER NOT NULL,
  subject TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  deduplication_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  available_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  publish_attempts INTEGER NOT NULL DEFAULT 0,
  maximum_publish_attempts INTEGER NOT NULL DEFAULT 16,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error_summary TEXT
);

CREATE INDEX transactional_outbox_unpublished_idx
  ON transactional_outbox (available_at, created_at, message_id)
  WHERE published_at IS NULL AND failed_at IS NULL;
