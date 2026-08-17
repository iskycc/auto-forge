-- 免登日志分享：导出执行结果时为每个 attempt 生成可公开访问的日志链接。
-- 链接 token 只存 SHA-256 哈希（token_hash），明文不出现在数据库；expires_at 之后链接失效。
-- created_by 记录创建者用户 id，不加外键，账号删除后分享记录仍可审计。
CREATE TABLE attempt_log_shares (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES run_attempts(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE UNIQUE INDEX attempt_log_shares_token_uq ON attempt_log_shares (token_hash);
CREATE INDEX attempt_log_shares_attempt_idx ON attempt_log_shares (attempt_id, expires_at);
