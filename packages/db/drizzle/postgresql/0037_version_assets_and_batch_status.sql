ALTER TABLE project_version_runtime_assets
  ALTER COLUMN jar_bundle_asset_id DROP NOT NULL;
ALTER TABLE project_version_runtime_assets
  ADD COLUMN jdk_asset_id TEXT REFERENCES project_runtime_assets(id) ON DELETE RESTRICT;
ALTER TABLE project_version_runtime_assets
  ADD COLUMN inherited_from_project_version_id TEXT REFERENCES project_versions(id) ON DELETE SET NULL;

UPDATE project_version_runtime_assets version_asset
SET jdk_asset_id = global.jdk_asset_id
FROM project_adapter_configurations global
WHERE global.project_id = version_asset.project_id
  AND global.jdk_asset_id IS NOT NULL;

INSERT INTO project_version_runtime_assets
  (project_version_id, project_id, jdk_asset_id, jar_bundle_asset_id, revision, updated_by, updated_at)
SELECT version.id, version.project_id, global.jdk_asset_id, global.jar_bundle_asset_id,
       global.revision, global.updated_by, global.updated_at
FROM project_versions version
JOIN project_adapter_configurations global ON global.project_id = version.project_id
WHERE (global.jdk_asset_id IS NOT NULL OR global.jar_bundle_asset_id IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM project_version_runtime_assets existing
    WHERE existing.project_version_id = version.id
  );

ALTER TABLE project_version_runtime_assets
  ADD CONSTRAINT project_version_runtime_assets_nonempty_ck
  CHECK (jdk_asset_id IS NOT NULL OR jar_bundle_asset_id IS NOT NULL);
CREATE INDEX project_version_runtime_assets_jdk_idx
  ON project_version_runtime_assets(jdk_asset_id);
CREATE INDEX project_version_runtime_assets_bundle_idx
  ON project_version_runtime_assets(jar_bundle_asset_id);

DROP INDEX IF EXISTS case_definitions_source_class_uq;
CREATE INDEX case_definitions_source_class_idx ON case_definitions(source_id, class_name);
CREATE INDEX case_definitions_hierarchy_class_idx
  ON case_definitions(project_id, project_version_id, test_stage_id, class_name);

INSERT INTO run_batch_status_events
  (id, batch_id, from_status, to_status, batch_version, reason, recorded_at)
SELECT 'migration:0037:' || batch.id, batch.id, 'failed', 'succeeded', batch.version + 1,
       'migration.normal_test_failure', batch.updated_at
FROM run_batches batch
WHERE batch.status = 'failed'
  AND batch.cancel_requested_at IS NULL
  AND EXISTS (SELECT 1 FROM execution_runs run WHERE run.batch_id = batch.id)
  AND NOT EXISTS (
    SELECT 1 FROM execution_runs run
    WHERE run.batch_id = batch.id
      AND (
        run.status NOT IN ('succeeded', 'failed')
        OR (run.status = 'failed' AND COALESCE(run.terminal_reason_code, '') NOT IN (
          'TESTNG_ASSERTIONS_FAILED', 'TESTNG_CONFIGURATION_FAILED', 'TEST_ASSERTION_FAILED'
        ))
      )
  );

UPDATE run_batches batch
SET status = 'succeeded', version = version + 1
WHERE batch.status = 'failed'
  AND batch.cancel_requested_at IS NULL
  AND EXISTS (SELECT 1 FROM execution_runs run WHERE run.batch_id = batch.id)
  AND NOT EXISTS (
    SELECT 1 FROM execution_runs run
    WHERE run.batch_id = batch.id
      AND (
        run.status NOT IN ('succeeded', 'failed')
        OR (run.status = 'failed' AND COALESCE(run.terminal_reason_code, '') NOT IN (
          'TESTNG_ASSERTIONS_FAILED', 'TESTNG_CONFIGURATION_FAILED', 'TEST_ASSERTION_FAILED'
        ))
      )
  );
