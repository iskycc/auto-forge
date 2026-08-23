ALTER TABLE run_batches ADD COLUMN scheduled_for TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

UPDATE run_batches SET scheduled_for = created_at;

CREATE INDEX run_batches_status_scheduled_for_idx
  ON run_batches(status, scheduled_for);
