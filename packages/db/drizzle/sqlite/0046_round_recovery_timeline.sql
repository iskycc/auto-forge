ALTER TABLE run_batch_round_recoveries ADD COLUMN activated_at TEXT;
ALTER TABLE run_batch_round_recoveries ADD COLUMN started_at TEXT;
ALTER TABLE run_batch_round_recoveries ADD COLUMN finished_at TEXT;
ALTER TABLE run_batch_round_recoveries ADD COLUMN build_result TEXT;

-- 历史记录没有精确激活时刻；使用首个可靠的更新时间作为保守回填，避免伪造
-- Jenkins 构建起止时间。新记录在轮次屏障激活时会写入准确时间。
UPDATE run_batch_round_recoveries
SET activated_at = updated_at
WHERE status <> 'idle' AND activated_at IS NULL;
