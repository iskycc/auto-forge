CREATE TABLE case_suite_round_recovery_credentials (
  suite_id TEXT NOT NULL REFERENCES case_suites(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  api_key_ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (suite_id, rule_id)
);

CREATE TABLE run_batch_round_recoveries (
  batch_id TEXT NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  after_round INTEGER NOT NULL,
  next_round INTEGER NOT NULL,
  jenkins_job_url TEXT NOT NULL,
  api_key_ciphertext TEXT NOT NULL,
  wait_minutes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle','pending','polling','waiting','succeeded','failed','cancelled')),
  source_build_number INTEGER,
  rebuild_number INTEGER,
  rebuild_url TEXT,
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (batch_id, rule_id),
  UNIQUE (batch_id, after_round)
);

CREATE INDEX run_batch_round_recoveries_due_idx
  ON run_batch_round_recoveries(status, available_at, lease_expires_at);

CREATE TABLE scheduling_events_next (
  id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  runner_id TEXT REFERENCES runners(id),
  execution_run_id TEXT REFERENCES execution_runs(id),
  attempt_id TEXT REFERENCES run_attempts(id),
  event_type TEXT NOT NULL CHECK (event_type IN
    ('batch_scheduled', 'run_assigned', 'attempt_claimed',
     'attempt_completed', 'run_held_for_round', 'runner_metrics',
     'runner_fault_rescheduled', 'round_recovery')),
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
