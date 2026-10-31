ALTER TABLE case_suites ADD COLUMN is_rerun INTEGER NOT NULL DEFAULT 0;
UPDATE case_suites SET is_rerun=1
WHERE rtrim(name,'0123456789') GLOB '*Rerun-'
  AND length(name)-length(rtrim(name,'0123456789'))>=8
  AND substr(name,length(rtrim(name,'0123456789'))+1,2)='20';
CREATE INDEX case_suites_project_status_idx ON case_suites(project_id,status,updated_at,id);
CREATE INDEX case_suites_rerun_idx ON case_suites(project_id,is_rerun,status,id);
CREATE TABLE run_batch_history_snapshots (
  batch_id TEXT PRIMARY KEY NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  batch_version INTEGER NOT NULL,
  snapshot_version INTEGER NOT NULL,
  counters_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
