ALTER TABLE failure_analysis_batches ADD COLUMN progress_started_at TEXT;
ALTER TABLE failure_analysis_batches ADD COLUMN archived_at TEXT;
ALTER TABLE failure_analysis_batches ADD COLUMN archived_by TEXT;

-- Preserve existing analysis work; claiming alone is not analysis progress.
UPDATE failure_analysis_batches SET progress_started_at=(
  SELECT MIN(COALESCE(claim.analysis_started_at,claim.completed_at,claim.updated_at))
  FROM failure_analysis_claims claim WHERE claim.batch_id=failure_analysis_batches.batch_id
    AND (claim.status<>'claimed' OR claim.analysis_started_at IS NOT NULL
         OR claim.screenshot_object_key IS NOT NULL)
);
CREATE INDEX failure_analysis_batches_archive_idx
  ON failure_analysis_batches(project_id,archived_at,batch_id);
