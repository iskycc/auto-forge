-- 执行批次的自然递增展示编号：UUID 主键保留（Runner 协议、外键、队列去重键不变），
-- sequence_number 仅用于界面展示。存量数据按 (created_at, id) 创建顺序稠密回填；
-- 新批次从独立序列 run_batch_sequence_numbers 取值，避免并发创建竞争。
-- DEFAULT 0 仅用于兼容原始 INSERT 的旧测试夹具，应用路径必须显式写入真实编号。
CREATE SEQUENCE IF NOT EXISTS run_batch_sequence_numbers;
ALTER TABLE run_batches ADD COLUMN sequence_number INTEGER NOT NULL DEFAULT 0;
UPDATE run_batches AS target
SET sequence_number = ordered.row_number
FROM (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS row_number
  FROM run_batches
) AS ordered
WHERE target.id = ordered.id;
SELECT setval(
  'run_batch_sequence_numbers',
  COALESCE((SELECT MAX(sequence_number) FROM run_batches), 0) + 1,
  false
);
