CREATE TABLE run_batch_retry_concurrency_states (
  batch_id TEXT PRIMARY KEY NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  rule_index INTEGER NOT NULL CHECK (rule_index >= 0),
  concurrency INTEGER NOT NULL CHECK (concurrency >= 1),
  activated_round INTEGER NOT NULL CHECK (activated_round >= 2 AND activated_round <= 11),
  updated_at TEXT NOT NULL
);
