ALTER TABLE case_suites ADD COLUMN is_rerun BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE case_suites SET is_rerun=TRUE WHERE name ~ 'Rerun-20[0-9]{6}[0-9]*$';
CREATE INDEX case_suites_project_status_idx ON case_suites(project_id,status,updated_at,id);
CREATE INDEX case_suites_rerun_idx ON case_suites(project_id,is_rerun,status,id);
CREATE TABLE run_batch_history_snapshots (
  batch_id TEXT PRIMARY KEY NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  batch_version INTEGER NOT NULL,
  snapshot_version INTEGER NOT NULL,
  counters_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
