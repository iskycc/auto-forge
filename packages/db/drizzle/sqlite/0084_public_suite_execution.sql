CREATE TABLE public_suite_execution_links (
  suite_id TEXT NOT NULL REFERENCES case_suites(id) ON DELETE CASCADE,
  publisher_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (suite_id, publisher_id)
);
ALTER TABLE run_batches ADD COLUMN public_execution_json TEXT;
ALTER TABLE run_batches ADD COLUMN public_request_key TEXT;
ALTER TABLE run_batches ADD COLUMN terminated_by_json TEXT;
CREATE UNIQUE INDEX run_batches_public_request_uq ON run_batches(public_request_key);
CREATE INDEX run_batches_suite_status_created_idx ON run_batches(suite_id, status, created_at, id);
CREATE INDEX run_batches_public_recent_idx ON run_batches(suite_id, created_at DESC, id DESC) WHERE public_execution_json IS NOT NULL;
