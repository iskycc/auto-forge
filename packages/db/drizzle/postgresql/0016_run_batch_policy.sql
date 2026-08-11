-- Run batch execution policy snapshot: stores the suite policy merged at batch
-- creation (concurrency, runnerLabels, artifactPatterns). NULL keeps legacy
-- behavior (unbounded concurrency, built-in labels, default artifact rules).
ALTER TABLE run_batches ADD COLUMN policy_json TEXT;
