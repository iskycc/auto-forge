-- Task version snapshots remain readable after the task configuration is deleted.
CREATE TABLE case_suite_versions_preserved (
  id TEXT PRIMARY KEY NOT NULL,
  suite_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  change_reason TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(suite_id, version)
);

INSERT INTO case_suite_versions_preserved
  (id, suite_id, version, snapshot_json, change_reason, created_by, created_at)
SELECT id, suite_id, version, snapshot_json, change_reason, created_by, created_at
FROM case_suite_versions;

DROP TABLE case_suite_versions;
ALTER TABLE case_suite_versions_preserved RENAME TO case_suite_versions;
