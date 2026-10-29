ALTER TABLE execution_runs ADD COLUMN dispatch_order_key TEXT;
CREATE INDEX execution_runs_dispatch_order_idx
  ON execution_runs(batch_id, status, held_round, (coalesce(dispatch_order_key, substr(id, 20))), id);
