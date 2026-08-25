CREATE TABLE run_batch_round_recoveries_next (
  batch_id TEXT NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  after_round INTEGER NOT NULL,
  next_round INTEGER NOT NULL,
  jenkins_job_url TEXT NOT NULL,
  api_key_ciphertext TEXT NOT NULL,
  wait_minutes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle','pending','polling','waiting','releasing','succeeded','failed','cancelled')),
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

-- 旧版本可能已释放 held run 并提前写入 succeeded，却在调度调用前退出。
-- 每个受影响批次只恢复一个交接步骤；调度自身幂等，不会重新触发 Jenkins。
UPDATE run_batch_round_recoveries AS recovery
SET status = 'releasing', available_at = recovery.updated_at,
    lease_owner = NULL, lease_expires_at = NULL
WHERE recovery.status = 'succeeded'
  AND recovery.next_round = (
    SELECT batch.current_round FROM run_batches AS batch WHERE batch.id = recovery.batch_id
  )
  AND EXISTS (
    SELECT 1 FROM run_batches AS batch
    WHERE batch.id = recovery.batch_id
      AND batch.status IN ('queued','dispatching','scheduled','running')
      AND batch.cancel_requested_at IS NULL
  )
  AND EXISTS (
    SELECT 1 FROM execution_runs AS run
    WHERE run.batch_id = recovery.batch_id AND run.status = 'queued' AND run.held_round = 0
  )
  AND recovery.rule_id = (
    SELECT MAX(candidate.rule_id) FROM run_batch_round_recoveries AS candidate
    WHERE candidate.batch_id = recovery.batch_id
      AND candidate.next_round = recovery.next_round
      AND candidate.status = 'succeeded'
  );
