ALTER TABLE run_batches ADD COLUMN batch_kind TEXT NOT NULL DEFAULT 'standard'
  CHECK (batch_kind IN ('standard', 'final_failure_rerun', 'case_log_rerun'));
ALTER TABLE run_batches ADD COLUMN parent_batch_id TEXT;
ALTER TABLE run_batches ADD COLUMN source_execution_run_id TEXT;
ALTER TABLE run_batches ADD COLUMN requested_by_username TEXT;
ALTER TABLE run_batches ADD COLUMN requested_by_source TEXT
  CHECK (requested_by_source IS NULL OR requested_by_source IN ('local', 'ldap'));

CREATE INDEX run_batches_kind_created_at_idx
  ON run_batches(batch_kind, created_at, id);
CREATE INDEX run_batches_case_log_family_idx
  ON run_batches(parent_batch_id, source_execution_run_id, created_at, id)
  WHERE batch_kind = 'case_log_rerun';

CREATE TABLE scheduling_events_next (
  id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  runner_id TEXT REFERENCES runners(id),
  execution_run_id TEXT REFERENCES execution_runs(id),
  attempt_id TEXT REFERENCES run_attempts(id),
  event_type TEXT NOT NULL CHECK (event_type IN
    ('batch_scheduled', 'run_assigned', 'attempt_claimed',
     'attempt_completed', 'run_held_for_round', 'runner_metrics',
     'runner_fault_rescheduled', 'round_recovery', 'retry_concurrency_changed')),
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

CREATE TABLE run_batch_round_concurrencies (
  batch_id TEXT NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  execution_round INTEGER NOT NULL CHECK (execution_round >= 1),
  concurrency INTEGER NOT NULL CHECK (concurrency >= 1),
  source TEXT NOT NULL CHECK (source IN ('base', 'inherited_rule', 'rule_transition')),
  rule_id TEXT,
  previous_concurrency INTEGER CHECK (previous_concurrency IS NULL OR previous_concurrency >= 1),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (batch_id, execution_round)
);

INSERT INTO run_batch_round_concurrencies
  (batch_id, execution_round, concurrency, source, recorded_at)
SELECT id, 1,
       COALESCE(CAST(json_extract(policy_json, '$.concurrency') AS INTEGER), 4),
       'base', created_at
FROM run_batches;
