CREATE TABLE run_batch_round_recoveries_next (
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
  PRIMARY KEY (batch_id, rule_id)
);

INSERT INTO run_batch_round_recoveries_next
  (batch_id, rule_id, after_round, next_round, jenkins_job_url, api_key_ciphertext,
   wait_minutes, status, source_build_number, rebuild_number, rebuild_url, available_at,
   lease_owner, lease_expires_at, error_message, created_at, updated_at)
SELECT batch_id, rule_id, after_round, next_round, jenkins_job_url, api_key_ciphertext,
       wait_minutes, status, source_build_number, rebuild_number, rebuild_url, available_at,
       lease_owner, lease_expires_at, error_message, created_at, updated_at
FROM run_batch_round_recoveries;

DROP TABLE run_batch_round_recoveries;
ALTER TABLE run_batch_round_recoveries_next RENAME TO run_batch_round_recoveries;

CREATE INDEX run_batch_round_recoveries_due_idx
  ON run_batch_round_recoveries(status, available_at, lease_expires_at);
CREATE INDEX run_batch_round_recoveries_barrier_idx
  ON run_batch_round_recoveries(batch_id, after_round, status);
