-- 用例执行日志外置到每批次独立 SQLite 文件（AUTOFORGE_DATA_DIR/attempt-logs/<batchId>.sqlite），
-- PostgreSQL 主库不再写入 attempt_log_chunks / attempt_log_watermarks，仅保存批次日志文件的存储路径。
-- 旧 attempt_log_chunks 表保留（历史数据仍由现有 retention 清理），停止新写入；
-- 新数据一律进入批次 SQLite 文件，与 Lite 模式语义一致。
ALTER TABLE run_batches ADD COLUMN attempt_logs_path TEXT;
