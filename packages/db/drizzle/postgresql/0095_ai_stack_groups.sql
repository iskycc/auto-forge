ALTER TABLE ai_analysis_jobs ADD COLUMN strategy TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE ai_analysis_groups ADD COLUMN part_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_analysis_groups ADD COLUMN publication_cursor TEXT NOT NULL DEFAULT '';
