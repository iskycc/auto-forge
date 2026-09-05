CREATE TABLE failure_analysis_batches (
  batch_id TEXT PRIMARY KEY NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL
);

CREATE INDEX failure_analysis_batches_project_idx
  ON failure_analysis_batches (project_id, started_at DESC, batch_id DESC);

-- Preserve analyses people already worked on; untouched executions remain opt-in.
INSERT INTO failure_analysis_batches (batch_id, project_id, started_by, started_at)
SELECT batch_id, project_id, 'legacy-analysis', MIN(claimed_at)
FROM failure_analysis_claims GROUP BY batch_id, project_id;
