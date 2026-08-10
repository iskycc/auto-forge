ALTER TABLE run_batches ADD COLUMN queue_timeout_ms INTEGER NOT NULL DEFAULT 86400000;
ALTER TABLE run_batches ADD COLUMN claim_timeout_ms INTEGER NOT NULL DEFAULT 300000;
ALTER TABLE run_batches ADD COLUMN execution_timeout_ms INTEGER NOT NULL DEFAULT 3600000;
ALTER TABLE run_batches ADD COLUMN upload_timeout_ms INTEGER NOT NULL DEFAULT 600000;

ALTER TABLE execution_runs ADD COLUMN terminal_reason_code TEXT;
ALTER TABLE execution_runs ADD COLUMN upload_timeout_ms INTEGER NOT NULL DEFAULT 600000;
ALTER TABLE run_attempts ADD COLUMN upload_started_at TEXT;

UPDATE execution_runs
SET queue_deadline_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+' || (
  SELECT queue_timeout_ms / 1000.0 FROM run_batches WHERE run_batches.id = execution_runs.batch_id
) || ' seconds')
WHERE queue_deadline_at IS NULL AND status = 'queued';
