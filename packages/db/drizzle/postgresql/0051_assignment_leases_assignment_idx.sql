-- 完成上报上下文与租约授权查询都按 assignment_id 检索，并按 created_at 倒序
-- 读取最新租约。通用索引避免历史租约累积后退化为全表扫描。
CREATE INDEX assignment_leases_assignment_idx
  ON assignment_leases (assignment_id, created_at DESC);
