ALTER TABLE run_batch_round_recoveries
  DROP CONSTRAINT run_batch_round_recoveries_status_check;

ALTER TABLE run_batch_round_recoveries
  ADD CONSTRAINT run_batch_round_recoveries_status_check CHECK (status IN
    ('idle','pending','polling','waiting','releasing','succeeded','failed','cancelled'));

-- 旧版本可能已释放 held run 并提前写入 succeeded，却在调度调用前退出。
-- 每个受影响批次只恢复一个交接步骤；调度自身幂等，不会重新触发 Jenkins。
UPDATE run_batch_round_recoveries AS recovery
SET status = 'releasing', available_at = recovery.updated_at,
    lease_owner = NULL, lease_expires_at = NULL
FROM run_batches AS batch
WHERE recovery.batch_id = batch.id
  AND recovery.status = 'succeeded'
  AND recovery.next_round = batch.current_round
  AND batch.status IN ('queued','dispatching','scheduled','running')
  AND batch.cancel_requested_at IS NULL
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
