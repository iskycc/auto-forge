-- 用例日志迁移到每批次独立 SQLite 文件（AUTOFORGE_DATA_DIR/attempt-logs/<batchId>.sqlite），
-- 主数据库不再保存日志内容，只保留 attempt 结果记录（run_attempts）。
-- 旧日志数据随本次升级丢弃；执行结果、事件与产物元数据保留。
DROP TABLE attempt_log_chunks;
-- 主库仅保存批次日志文件的存储路径（相对数据目录），与 Full 模式语义一致。
ALTER TABLE run_batches ADD COLUMN attempt_logs_path TEXT;
