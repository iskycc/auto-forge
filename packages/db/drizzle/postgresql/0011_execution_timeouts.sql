ALTER TABLE run_batches ADD COLUMN queue_timeout_ms INTEGER NOT NULL DEFAULT 86400000;
ALTER TABLE run_batches ADD COLUMN claim_timeout_ms INTEGER NOT NULL DEFAULT 300000;
ALTER TABLE run_batches ADD COLUMN execution_timeout_ms INTEGER NOT NULL DEFAULT 3600000;
ALTER TABLE run_batches ADD COLUMN upload_timeout_ms INTEGER NOT NULL DEFAULT 600000;

ALTER TABLE execution_runs ADD COLUMN terminal_reason_code TEXT;
ALTER TABLE execution_runs ADD COLUMN upload_timeout_ms INTEGER NOT NULL DEFAULT 600000;
ALTER TABLE run_attempts ADD COLUMN upload_started_at TEXT;

UPDATE execution_runs r
SET queue_deadline_at = r.created_at::timestamptz
  + b.queue_timeout_ms * interval '1 millisecond'
FROM run_batches b
WHERE b.id = r.batch_id AND r.queue_deadline_at IS NULL AND r.status = 'queued';
