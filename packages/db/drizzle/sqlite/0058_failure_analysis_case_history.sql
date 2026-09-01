CREATE INDEX failure_analysis_claims_case_history_idx
ON failure_analysis_claims(project_id, case_definition_id, status, completed_at DESC, id DESC);
