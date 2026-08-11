-- Track whether a case source comparison hit the per-list entry cap.
ALTER TABLE case_source_comparisons ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0;
