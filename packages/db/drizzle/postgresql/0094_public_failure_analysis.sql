CREATE TABLE public_failure_analysis_links (
  batch_id TEXT PRIMARY KEY NOT NULL REFERENCES failure_analysis_batches(batch_id) ON DELETE CASCADE,
  publisher_id TEXT NOT NULL REFERENCES users(id),
  published_at TEXT NOT NULL,
  revoked_at TEXT
);
