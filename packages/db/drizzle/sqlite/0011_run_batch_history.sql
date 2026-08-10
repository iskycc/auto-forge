ALTER TABLE run_batches ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE run_batch_status_events (
  id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  batch_version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX run_batch_status_events_batch_idx
  ON run_batch_status_events (batch_id, recorded_at, id);

INSERT INTO run_batch_status_events
  (id, batch_id, from_status, to_status, batch_version, reason, recorded_at)
SELECT 'migration:' || id, id, NULL, status, version, 'history.baseline', created_at
FROM run_batches;
