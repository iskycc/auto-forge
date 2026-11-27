ALTER TABLE ai_analysis_issue_categories ADD COLUMN affected_subjects_json TEXT;
ALTER TABLE ai_analysis_issue_categories ADD COLUMN synthesis_cursor TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_analysis_issue_categories ADD COLUMN synthesis_complete INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_analysis_items ADD COLUMN issue_finding_json TEXT;
CREATE INDEX ai_issue_member_synthesis_idx ON ai_analysis_items(issue_category_id, id)
  WHERE issue_finding_json IS NOT NULL;
