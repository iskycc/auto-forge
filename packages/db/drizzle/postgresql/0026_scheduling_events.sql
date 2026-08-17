-- 调度事件日志：批次调度汇总、run 分配、attempt 领取/完成与 runner 资源快照。
-- runner_id 可空：batch_scheduled 等批次级事件不归属具体 runner。
-- 事件是诊断流水，batch 删除时级联清理；runner/attempt 删除时保留历史记录。
CREATE TABLE scheduling_events (
  id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  runner_id TEXT REFERENCES runners(id),
  execution_run_id TEXT REFERENCES execution_runs(id),
  attempt_id TEXT REFERENCES run_attempts(id),
  event_type TEXT NOT NULL CHECK (event_type IN
    ('batch_scheduled', 'run_assigned', 'attempt_claimed',
     'attempt_completed', 'run_held_for_round', 'runner_metrics')),
  message TEXT NOT NULL,
  payload_json TEXT,
  recorded_at TEXT NOT NULL
);

CREATE INDEX scheduling_events_batch_idx
  ON scheduling_events (batch_id, recorded_at, id);
CREATE INDEX scheduling_events_runner_idx
  ON scheduling_events (runner_id, recorded_at, id);
