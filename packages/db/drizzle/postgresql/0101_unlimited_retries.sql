-- Additive policy JSON supports unlimited retries and completion rules.
ALTER TABLE run_batches DROP CONSTRAINT run_batches_retry_limit_check;
ALTER TABLE run_batches ALTER COLUMN retry_limit TYPE BIGINT;
ALTER TABLE run_batches ADD CONSTRAINT run_batches_retry_limit_check CHECK (retry_limit >= 0);

ALTER TABLE run_batch_round_recoveries ADD COLUMN credential_rule_id TEXT;
