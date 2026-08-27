CREATE INDEX IF NOT EXISTS execution_runs_case_created_idx
  ON execution_runs (case_definition_id, created_at, id);
