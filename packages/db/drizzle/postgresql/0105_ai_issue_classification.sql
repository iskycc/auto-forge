-- Additive migration. Legacy jobs and conclusions keep their existing representation.
ALTER TABLE ai_analysis_jobs ADD COLUMN issue_phase TEXT NOT NULL DEFAULT 'plan';
ALTER TABLE ai_analysis_jobs ADD COLUMN issue_cursor TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_analysis_jobs ADD COLUMN issue_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_analysis_jobs ADD COLUMN issue_reviewed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_analysis_groups ADD COLUMN initial_summary TEXT;
ALTER TABLE ai_analysis_groups ADD COLUMN refinement_json TEXT;
ALTER TABLE ai_analysis_items ADD COLUMN issue_category_id TEXT;
ALTER TABLE ai_analysis_conclusions ADD COLUMN issue_rank INTEGER;
ALTER TABLE ai_analysis_conclusions ADD COLUMN issue_summary TEXT;

CREATE TABLE ai_analysis_issue_categories (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES ai_analysis_jobs(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES ai_analysis_groups(id) ON DELETE CASCADE,
  member_count INTEGER NOT NULL CHECK (member_count > 0),
  summary TEXT NOT NULL,
  conclusion_json TEXT NOT NULL,
  rank INTEGER CHECK (rank > 0),
  UNIQUE (job_id, rank)
);
CREATE INDEX ai_issue_categories_group_idx ON ai_analysis_issue_categories(group_id, id);
CREATE INDEX ai_issue_categories_rank_idx ON ai_analysis_issue_categories(job_id, rank, member_count DESC, id);
CREATE INDEX ai_issue_items_scan_idx ON ai_analysis_items(job_id, status, id);
