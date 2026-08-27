-- 与 PostgreSQL 0048 对齐：完成上报上下文连接与租约授权查询按 assignment_id
-- 检索并按 created_at 倒序取最新 lease，缺少通用索引时随历史租约线性退化。
CREATE INDEX assignment_leases_assignment_idx
  ON assignment_leases (assignment_id, created_at DESC);
