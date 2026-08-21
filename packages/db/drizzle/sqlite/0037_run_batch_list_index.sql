CREATE INDEX IF NOT EXISTS run_batches_project_created_id_idx
ON run_batches(project_id, created_at, id);
