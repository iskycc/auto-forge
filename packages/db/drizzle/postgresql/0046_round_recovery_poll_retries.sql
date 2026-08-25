ALTER TABLE run_batch_round_recoveries
ADD COLUMN poll_failure_count INTEGER NOT NULL DEFAULT 0;
