CREATE TABLE failure_analysis_claims (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  execution_run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
  case_definition_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES run_attempts(id) ON DELETE CASCADE,
  case_name TEXT NOT NULL,
  class_name TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  failure_summary TEXT NOT NULL,
  result_code TEXT,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'analyzing', 'completed')),
  category TEXT CHECK (category IN ('rerun_passed', 'case_fixed', 'code_issue_filed')),
  claimant_id TEXT NOT NULL,
  claimant_username TEXT NOT NULL,
  claimant_display_name TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  analysis_started_at TEXT,
  completed_at TEXT,
  issue_description TEXT,
  case_fix_evidence TEXT,
  ticket_reference TEXT,
  remark TEXT,
  rerun_proof_attempt_id TEXT REFERENCES run_attempts(id) ON DELETE SET NULL,
  rerun_proof_url TEXT,
  screenshot_object_key TEXT,
  screenshot_file_name TEXT,
  screenshot_media_type TEXT CHECK (screenshot_media_type IN ('image/png', 'image/jpeg', 'image/webp')),
  screenshot_size_bytes INTEGER,
  screenshot_sha256 TEXT,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX failure_analysis_claims_run_uq
  ON failure_analysis_claims (execution_run_id);
CREATE INDEX failure_analysis_claims_project_claimant_idx
  ON failure_analysis_claims (project_id, claimant_id, updated_at DESC, id DESC);
CREATE INDEX failure_analysis_claims_project_claimant_batch_idx
  ON failure_analysis_claims (project_id, claimant_id, batch_id, updated_at DESC, id DESC);
CREATE INDEX failure_analysis_claims_batch_status_idx
  ON failure_analysis_claims (batch_id, status, execution_run_id);
