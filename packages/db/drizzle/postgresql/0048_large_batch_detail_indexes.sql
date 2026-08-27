CREATE INDEX execution_runs_batch_created_idx
  ON execution_runs(batch_id, created_at, id);

CREATE INDEX execution_runs_batch_name_idx
  ON execution_runs(batch_id, display_name, id);
