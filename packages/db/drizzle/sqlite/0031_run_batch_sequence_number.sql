-- 执行批次的自然递增展示编号：UUID 主键保留（Runner 协议、外键、队列去重键不变），
-- sequence_number 仅用于界面展示。存量数据按 (created_at, id) 创建顺序稠密回填；
-- 新批次由仓储在同一写事务内取 MAX(sequence_number)+1 生成（SQLite 单写者保证唯一）。
-- DEFAULT 0 仅用于兼容原始 INSERT 的旧测试夹具，应用路径必须显式写入真实编号。
ALTER TABLE run_batches ADD COLUMN sequence_number INTEGER NOT NULL DEFAULT 0;
UPDATE run_batches
SET sequence_number = (
  SELECT COUNT(*)
  FROM run_batches AS other
  WHERE other.created_at < run_batches.created_at
     OR (other.created_at = run_batches.created_at AND other.id <= run_batches.id)
);
