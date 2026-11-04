-- Bound foreign-key checks and cascades during execution-history retention.
CREATE INDEX analytics_facts_batch_idx ON analytics_facts(batch_id);
CREATE INDEX analytics_facts_run_idx ON analytics_facts(run_id);
CREATE INDEX analytics_facts_runner_idx ON analytics_facts(runner_id);
