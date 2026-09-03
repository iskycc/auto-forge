ALTER TABLE execution_runs
  ADD COLUMN execution_round INTEGER NOT NULL DEFAULT 1 CHECK (execution_round >= 1);

ALTER TABLE run_attempts
  ADD COLUMN execution_round INTEGER NOT NULL DEFAULT 1 CHECK (execution_round >= 1);

-- 历史 attempt 的物理序号曾被直接当作整轮编号。Runner 基础设施异常不消耗
-- 用例重跑额度，因此按此前已经发生的普通失败数重建逻辑轮次。
WITH derived_attempt_rounds AS (
  SELECT attempt.id,
         CASE WHEN batch.retry_mode = 'round' THEN
           1 + COALESCE(
             SUM(CASE
               WHEN attempt.status IN ('failed', 'timed_out')
                AND COALESCE(attempt.result_code, '') NOT IN (
                  'AGENT_RESTARTED_DURING_EXECUTION',
                  'ARTIFACT_ID_FAILED',
                  'ARTIFACT_SPOOL_QUOTA_EXCEEDED',
                  'ARTIFACT_SPOOL_WRITE_FAILED',
                  'ASSIGNMENT_CLAIM_TIMEOUT',
                  'EXECUTION_SECRET_ACQUISITION_FAILED',
                  'LEASE_EXPIRED',
                  'LOG_SPOOL_QUOTA_EXCEEDED',
                  'LOG_SPOOL_WRITE_FAILED',
                  'LOG_UPLOAD_FAILED',
                  'PROCESS_START_FAILED',
                  'REQUIRED_ARTIFACT_UPLOAD_FAILED',
                  'RESOURCE_ISOLATION_UNAVAILABLE',
                  'RESOURCE_MONITOR_FAILED',
                  'RESULT_SPOOL_WRITE_FAILED',
                  'UPLOAD_TIMEOUT',
                  'WORKSPACE_DISK_INSUFFICIENT'
                ) THEN 1 ELSE 0 END
             ) OVER (
               PARTITION BY attempt.execution_run_id
               ORDER BY attempt.attempt_number
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
             ),
             0
           )
         ELSE attempt.attempt_number END AS execution_round
  FROM run_attempts attempt
  JOIN execution_runs run ON run.id = attempt.execution_run_id
  JOIN run_batches batch ON batch.id = run.batch_id
)
UPDATE run_attempts
SET execution_round = (
  SELECT derived.execution_round
  FROM derived_attempt_rounds derived
  WHERE derived.id = run_attempts.id
);

-- queued run 已经代表下一次调度资格：普通失败进入下一逻辑轮次，Runner 异常
-- 留在当前轮；其他状态保留最后一个 attempt 的逻辑轮次。
UPDATE execution_runs AS run
SET execution_round = CASE
  WHEN (SELECT batch.retry_mode FROM run_batches batch WHERE batch.id = run.batch_id) = 'immediate'
    THEN CASE WHEN run.status = 'queued' AND run.attempt_count > 0
              THEN run.attempt_count + 1 ELSE MAX(1, run.attempt_count) END
  ELSE MIN(
    (SELECT batch.retry_limit + 1 FROM run_batches batch WHERE batch.id = run.batch_id),
    COALESCE(
      (
        SELECT latest.execution_round + CASE
          WHEN run.status = 'queued'
           AND latest.status IN ('failed', 'timed_out')
           AND COALESCE(latest.result_code, '') NOT IN (
             'AGENT_RESTARTED_DURING_EXECUTION',
             'ARTIFACT_ID_FAILED',
             'ARTIFACT_SPOOL_QUOTA_EXCEEDED',
             'ARTIFACT_SPOOL_WRITE_FAILED',
             'ASSIGNMENT_CLAIM_TIMEOUT',
             'EXECUTION_SECRET_ACQUISITION_FAILED',
             'LEASE_EXPIRED',
             'LOG_SPOOL_QUOTA_EXCEEDED',
             'LOG_SPOOL_WRITE_FAILED',
             'LOG_UPLOAD_FAILED',
             'PROCESS_START_FAILED',
             'REQUIRED_ARTIFACT_UPLOAD_FAILED',
             'RESOURCE_ISOLATION_UNAVAILABLE',
             'RESOURCE_MONITOR_FAILED',
             'RESULT_SPOOL_WRITE_FAILED',
             'UPLOAD_TIMEOUT',
             'WORKSPACE_DISK_INSUFFICIENT'
           ) THEN 1 ELSE 0 END
        FROM run_attempts latest
        WHERE latest.execution_run_id = run.id
        ORDER BY latest.attempt_number DESC
        LIMIT 1
      ),
      1
    )
  )
END;

UPDATE execution_runs
SET held_round = execution_round
WHERE held_round > 0;

-- 修复历史批次超过 retry_limit + 1 的 current_round。优先采用已经释放的 run，
-- 仅剩 held run 时仍停留在其目标轮次的前一轮。
UPDATE run_batches AS batch
SET current_round = MIN(
  batch.retry_limit + 1,
  COALESCE(
    (
      SELECT MAX(run.execution_round)
      FROM execution_runs run
      WHERE run.batch_id = batch.id
        AND (run.status IN ('assigned', 'running')
             OR (run.status = 'queued' AND run.held_round = 0))
    ),
    (
      SELECT MAX(1, MIN(run.execution_round) - 1)
      FROM execution_runs run
      WHERE run.batch_id = batch.id AND run.status = 'queued' AND run.held_round > 0
    ),
    (SELECT MAX(run.execution_round) FROM execution_runs run WHERE run.batch_id = batch.id),
    1
  )
)
WHERE batch.retry_mode = 'round';

CREATE INDEX execution_runs_batch_round_status_idx
  ON execution_runs (batch_id, execution_round, status);
CREATE INDEX run_attempts_run_round_number_idx
  ON run_attempts (execution_run_id, execution_round, attempt_number);
