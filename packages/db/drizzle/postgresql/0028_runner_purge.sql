-- 执行机注销后的墓碑清除（purge）：purged_at 非空表示记录已从列表隐藏、凭据材料已清除。
-- 执行历史表通过外键引用 runners，记录本身保留。
ALTER TABLE runners ADD COLUMN purged_at TEXT;
