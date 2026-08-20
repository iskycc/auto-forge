-- SQLite cannot alter a CHECK constraint in place. Rebuild the diagnostic table while preserving
-- existing events, then extend the allowed event types with Runner fault rescheduling.
CREATE TABLE scheduling_events_next (
  id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  runner_id TEXT REFERENCES runners(id),
  execution_run_id TEXT REFERENCES execution_runs(id),
  attempt_id TEXT REFERENCES run_attempts(id),
  event_type TEXT NOT NULL CHECK (event_type IN
    ('batch_scheduled', 'run_assigned', 'attempt_claimed',
     'attempt_completed', 'run_held_for_round', 'runner_metrics',
     'runner_fault_rescheduled')),
  message TEXT NOT NULL,
  payload_json TEXT,
  recorded_at TEXT NOT NULL
);

INSERT INTO scheduling_events_next
  (id, batch_id, runner_id, execution_run_id, attempt_id, event_type, message, payload_json, recorded_at)
SELECT id, batch_id, runner_id, execution_run_id, attempt_id, event_type, message, payload_json, recorded_at
FROM scheduling_events;

DROP TABLE scheduling_events;
ALTER TABLE scheduling_events_next RENAME TO scheduling_events;

CREATE INDEX scheduling_events_batch_idx
  ON scheduling_events (batch_id, recorded_at, id);
CREATE INDEX scheduling_events_runner_idx
  ON scheduling_events (runner_id, recorded_at, id);
