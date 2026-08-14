CREATE TABLE project_versions (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX project_versions_project_name_uq
  ON project_versions(project_id, normalized_name);
CREATE INDEX project_versions_project_status_idx
  ON project_versions(project_id, status);

CREATE TABLE test_stages (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_version_id TEXT NOT NULL REFERENCES project_versions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX test_stages_version_name_uq
  ON test_stages(project_version_id, normalized_name);
CREATE UNIQUE INDEX test_stages_version_position_uq
  ON test_stages(project_version_id, position);
CREATE INDEX test_stages_project_version_idx
  ON test_stages(project_id, project_version_id);

CREATE TABLE project_runtime_assets (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('jdk', 'jar-bundle')),
  source_type TEXT NOT NULL CHECK (source_type IN ('upload', 'url')),
  file_name TEXT NOT NULL,
  url TEXT,
  object_key TEXT,
  sha256 TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  archive_format TEXT NOT NULL CHECK (archive_format IN ('zip', 'tar.gz')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  CHECK ((source_type = 'upload' AND object_key IS NOT NULL AND url IS NULL)
    OR (source_type = 'url' AND url IS NOT NULL AND object_key IS NULL))
);
CREATE UNIQUE INDEX project_runtime_assets_object_key_uq
  ON project_runtime_assets(object_key);
CREATE INDEX project_runtime_assets_project_kind_idx
  ON project_runtime_assets(project_id, kind);

CREATE TABLE project_adapter_configurations (
  project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  suite_name TEXT NOT NULL DEFAULT '',
  test_name TEXT NOT NULL DEFAULT '',
  environment_address TEXT NOT NULL DEFAULT '',
  jdk_asset_id TEXT REFERENCES project_runtime_assets(id) ON DELETE SET NULL,
  jar_bundle_asset_id TEXT REFERENCES project_runtime_assets(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

ALTER TABLE case_sources ADD COLUMN project_version_id TEXT REFERENCES project_versions(id) ON DELETE RESTRICT;
ALTER TABLE case_sources ADD COLUMN test_stage_id TEXT REFERENCES test_stages(id) ON DELETE RESTRICT;
ALTER TABLE case_definitions ADD COLUMN project_version_id TEXT REFERENCES project_versions(id) ON DELETE RESTRICT;
ALTER TABLE case_definitions ADD COLUMN test_stage_id TEXT REFERENCES test_stages(id) ON DELETE RESTRICT;
ALTER TABLE case_definitions ADD COLUMN directory_path TEXT NOT NULL DEFAULT '';
ALTER TABLE case_import_jobs ADD COLUMN project_version_id TEXT REFERENCES project_versions(id) ON DELETE RESTRICT;
ALTER TABLE case_import_jobs ADD COLUMN test_stage_id TEXT REFERENCES test_stages(id) ON DELETE RESTRICT;
ALTER TABLE run_batches ADD COLUMN adapter_runtime_json TEXT;

DROP INDEX case_import_jobs_idempotency_uq;
CREATE UNIQUE INDEX case_import_jobs_legacy_idempotency_uq
  ON case_import_jobs(project_id, idempotency_key)
  WHERE project_version_id IS NULL AND test_stage_id IS NULL;
CREATE UNIQUE INDEX case_import_jobs_stage_idempotency_uq
  ON case_import_jobs(project_id, project_version_id, test_stage_id, idempotency_key)
  WHERE project_version_id IS NOT NULL AND test_stage_id IS NOT NULL;

DROP INDEX case_sources_project_sha256_uq;
DROP INDEX case_sources_project_authoritative_uq;
CREATE UNIQUE INDEX case_sources_legacy_project_sha256_uq
  ON case_sources(project_id, sha256)
  WHERE project_version_id IS NULL AND test_stage_id IS NULL;
CREATE UNIQUE INDEX case_sources_stage_sha256_uq
  ON case_sources(project_id, project_version_id, test_stage_id, sha256)
  WHERE project_version_id IS NOT NULL AND test_stage_id IS NOT NULL;
CREATE UNIQUE INDEX case_sources_legacy_authoritative_uq
  ON case_sources(project_id, authoritative)
  WHERE authoritative = TRUE AND project_version_id IS NULL AND test_stage_id IS NULL;
CREATE UNIQUE INDEX case_sources_stage_authoritative_uq
  ON case_sources(project_id, project_version_id, test_stage_id, authoritative)
  WHERE authoritative = TRUE AND project_version_id IS NOT NULL AND test_stage_id IS NOT NULL;
CREATE INDEX case_definitions_stage_directory_idx
  ON case_definitions(project_id, project_version_id, test_stage_id, directory_path);
