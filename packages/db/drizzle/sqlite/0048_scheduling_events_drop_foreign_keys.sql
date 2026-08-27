-- SQLite 无法原地删除外键：重建诊断流水表并保留既有事件。与 PostgreSQL 侧
-- 0047 保持语义一致——事件引用完整性由应用写入路径保证，批次删除时的事件
-- 清理由保留周期显式执行。
CREATE TABLE scheduling_events_next (
  id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL,
  runner_id TEXT,
  execution_run_id TEXT,
  attempt_id TEXT,
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
