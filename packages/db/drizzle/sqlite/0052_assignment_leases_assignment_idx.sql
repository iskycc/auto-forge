-- 与 PostgreSQL 0051 对齐：完成上报上下文与租约授权查询按 assignment_id
-- 检索并按 created_at 倒序读取最新租约，避免历史租约线性扫描。
CREATE INDEX assignment_leases_assignment_idx
  ON assignment_leases (assignment_id, created_at DESC);
