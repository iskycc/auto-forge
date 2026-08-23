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

ALTER TABLE scheduling_events
  DROP CONSTRAINT scheduling_events_event_type_check;

ALTER TABLE scheduling_events
  ADD CONSTRAINT scheduling_events_event_type_check CHECK (event_type IN
    ('batch_scheduled', 'run_assigned', 'attempt_claimed',
     'attempt_completed', 'run_held_for_round', 'runner_metrics',
     'runner_fault_rescheduled', 'round_recovery'));
