-- 完成上报上下文连接（LEFT JOIN LATERAL 取每个 assignment 的最新 lease）与租约
-- 授权查询都按 assignment_id 检索、按 created_at 倒序取最新一行。此前只有
-- “active 租约”的部分唯一索引可用，历史租约累积后连接退化为全表扫描
-- （高并发基准中每次完成上报扫描全表，累计超过 1 秒纯扫描时间）。
CREATE INDEX assignment_leases_assignment_idx
  ON assignment_leases (assignment_id, created_at DESC);
