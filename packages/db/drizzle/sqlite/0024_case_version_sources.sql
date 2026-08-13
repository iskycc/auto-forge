CREATE TABLE case_versions_next (
  id TEXT PRIMARY KEY NOT NULL,
  case_definition_id TEXT NOT NULL REFERENCES case_definitions(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES case_sources(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  change_reason TEXT NOT NULL DEFAULT 'source.import',
  created_at TEXT NOT NULL
);

INSERT INTO case_versions_next
  (id, case_definition_id, source_id, version, snapshot_json, created_by, change_reason, created_at)
SELECT
  version.id,
  version.case_definition_id,
  definition.source_id,
  version.version,
  version.snapshot_json,
  version.created_by,
  version.change_reason,
  version.created_at
FROM case_versions version
INNER JOIN case_definitions definition ON definition.id = version.case_definition_id;

DROP TABLE case_versions;
ALTER TABLE case_versions_next RENAME TO case_versions;

CREATE UNIQUE INDEX case_versions_definition_version_uq
  ON case_versions(case_definition_id, version);
CREATE INDEX case_versions_source_idx ON case_versions(source_id);
