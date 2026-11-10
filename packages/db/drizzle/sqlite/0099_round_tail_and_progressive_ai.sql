-- Roll back by reverting the application; these additive columns/indexes may remain.
ALTER TABLE ai_analysis_jobs ADD COLUMN intake_open INTEGER NOT NULL DEFAULT 0 CHECK(intake_open IN (0,1));
ALTER TABLE ai_analysis_jobs ADD COLUMN next_intake_at TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_analysis_groups ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
CREATE INDEX ai_analysis_jobs_intake_idx ON ai_analysis_jobs(status,next_intake_at,created_at);
CREATE INDEX execution_runs_active_round_idx ON execution_runs(batch_id,execution_round) WHERE status IN ('assigned','running');
