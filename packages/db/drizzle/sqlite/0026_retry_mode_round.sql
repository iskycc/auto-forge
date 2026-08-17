-- 重试模式：immediate 为既有行为（失败立即重排），round 为整轮轮次制
-- （本轮全部 run 结束后，失败 run 统一进入下一轮）。
ALTER TABLE run_batches ADD COLUMN retry_mode TEXT NOT NULL DEFAULT 'immediate'
  CHECK (retry_mode IN ('immediate', 'round'));
-- round 模式下当前轮次号，从 1 开始。
ALTER TABLE run_batches ADD COLUMN current_round INTEGER NOT NULL DEFAULT 1;
-- round 模式下失败 run 被扣留等待的目标轮次；0 表示未扣留（可立即调度）。
ALTER TABLE execution_runs ADD COLUMN held_round INTEGER NOT NULL DEFAULT 0;
