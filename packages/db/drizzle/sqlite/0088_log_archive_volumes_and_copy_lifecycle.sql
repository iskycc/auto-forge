ALTER TABLE log_archive_jobs ADD COLUMN group_id TEXT;
ALTER TABLE log_archive_jobs ADD COLUMN source_cutoff_at TEXT;
ALTER TABLE log_archive_jobs ADD COLUMN month_start_at TEXT;
ALTER TABLE log_archive_jobs ADD COLUMN month_end_at TEXT;
ALTER TABLE log_archive_jobs ADD COLUMN volume_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE log_archive_jobs ADD COLUMN target_source_bytes INTEGER NOT NULL DEFAULT 1073741824;
ALTER TABLE log_archive_jobs ADD COLUMN minimum_free_bytes INTEGER NOT NULL DEFAULT 1073741824;
ALTER TABLE log_archive_jobs ADD COLUMN minimum_free_percent INTEGER NOT NULL DEFAULT 10;
ALTER TABLE log_archive_jobs ADD COLUMN planning_completed_at TEXT;
ALTER TABLE log_archive_jobs ADD COLUMN next_volume_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE log_archive_jobs ADD COLUMN estimated_temporary_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE log_archive_jobs ADD COLUMN disk_reserved_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE log_archive_jobs ADD COLUMN copy_state TEXT NOT NULL DEFAULT 'retained' CHECK(copy_state IN ('retained','delete_requested','deleting','deleted','delete_failed'));
ALTER TABLE log_archive_jobs ADD COLUMN download_confirmed_by TEXT;
ALTER TABLE log_archive_jobs ADD COLUMN download_confirmed_at TEXT;
ALTER TABLE log_archive_jobs ADD COLUMN copy_deleted_at TEXT;
ALTER TABLE log_archive_jobs ADD COLUMN copy_removal_error TEXT;
CREATE UNIQUE INDEX log_archive_jobs_volume_uq ON log_archive_jobs(group_id,volume_number) WHERE group_id IS NOT NULL;
CREATE INDEX log_archive_jobs_copy_work_idx ON log_archive_jobs(copy_state,created_at);
CREATE TABLE log_archive_download_receipts (
  archive_id TEXT NOT NULL REFERENCES log_archive_jobs(id),
  actor_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY(archive_id,actor_id)
);
