CREATE TABLE failure_analysis_claim_releases (
  id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  execution_run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
  case_definition_id TEXT NOT NULL,
  claimant_id TEXT NOT NULL,
  claimant_username TEXT NOT NULL,
  claimant_display_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  released_at TEXT NOT NULL
);

CREATE INDEX failure_analysis_claim_releases_batch_idx
  ON failure_analysis_claim_releases (batch_id, released_at DESC, id DESC);
CREATE INDEX failure_analysis_claim_releases_claimant_idx
  ON failure_analysis_claim_releases (project_id, claimant_id, released_at DESC, id DESC);
