CREATE TABLE `project_version_runtime_assets_next` (
  `project_version_id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `jdk_asset_id` text,
  `jar_bundle_asset_id` text,
  `inherited_from_project_version_id` text,
  `revision` integer DEFAULT 1 NOT NULL,
  `updated_by` text,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`project_version_id`) REFERENCES `project_versions`(`id`) ON DELETE cascade,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade,
  FOREIGN KEY (`jdk_asset_id`) REFERENCES `project_runtime_assets`(`id`) ON DELETE restrict,
  FOREIGN KEY (`jar_bundle_asset_id`) REFERENCES `project_runtime_assets`(`id`) ON DELETE restrict,
  FOREIGN KEY (`inherited_from_project_version_id`) REFERENCES `project_versions`(`id`) ON DELETE set null,
  CHECK (`jdk_asset_id` IS NOT NULL OR `jar_bundle_asset_id` IS NOT NULL)
);

INSERT INTO `project_version_runtime_assets_next`
  (`project_version_id`, `project_id`, `jdk_asset_id`, `jar_bundle_asset_id`, `revision`,
   `updated_by`, `updated_at`)
SELECT version.id, version.project_id, global.jdk_asset_id,
       COALESCE(version_asset.jar_bundle_asset_id, global.jar_bundle_asset_id),
       COALESCE(version_asset.revision, global.revision, 1),
       COALESCE(version_asset.updated_by, global.updated_by),
       COALESCE(version_asset.updated_at, global.updated_at, version.updated_at)
FROM project_versions version
LEFT JOIN project_version_runtime_assets version_asset
  ON version_asset.project_version_id = version.id
LEFT JOIN project_adapter_configurations global ON global.project_id = version.project_id
WHERE global.jdk_asset_id IS NOT NULL
   OR version_asset.jar_bundle_asset_id IS NOT NULL
   OR global.jar_bundle_asset_id IS NOT NULL;

DROP TABLE `project_version_runtime_assets`;
ALTER TABLE `project_version_runtime_assets_next` RENAME TO `project_version_runtime_assets`;
CREATE INDEX `project_version_runtime_assets_project_idx`
  ON `project_version_runtime_assets` (`project_id`, `project_version_id`);
CREATE INDEX `project_version_runtime_assets_jdk_idx`
  ON `project_version_runtime_assets` (`jdk_asset_id`);
CREATE INDEX `project_version_runtime_assets_bundle_idx`
  ON `project_version_runtime_assets` (`jar_bundle_asset_id`);

DROP INDEX IF EXISTS `case_definitions_source_class_uq`;
CREATE INDEX `case_definitions_source_class_idx` ON `case_definitions` (`source_id`, `class_name`);
CREATE INDEX `case_definitions_hierarchy_class_idx`
  ON `case_definitions` (`project_id`, `project_version_id`, `test_stage_id`, `class_name`);

INSERT INTO run_batch_status_events
  (id, batch_id, from_status, to_status, batch_version, reason, recorded_at)
SELECT 'migration:0038:' || id, id, 'failed', 'succeeded', version + 1,
       'migration.normal_test_failure', updated_at
FROM run_batches
WHERE status = 'failed'
  AND cancel_requested_at IS NULL
  AND EXISTS (SELECT 1 FROM execution_runs run WHERE run.batch_id = run_batches.id)
  AND NOT EXISTS (
    SELECT 1 FROM execution_runs run
    WHERE run.batch_id = run_batches.id
      AND (
        run.status NOT IN ('succeeded', 'failed')
        OR (run.status = 'failed' AND COALESCE(run.terminal_reason_code, '') NOT IN (
          'TESTNG_ASSERTIONS_FAILED', 'TESTNG_CONFIGURATION_FAILED', 'TEST_ASSERTION_FAILED'
        ))
      )
  );

UPDATE run_batches
SET status = 'succeeded', version = version + 1
WHERE status = 'failed'
  AND cancel_requested_at IS NULL
  AND EXISTS (SELECT 1 FROM execution_runs run WHERE run.batch_id = run_batches.id)
  AND NOT EXISTS (
    SELECT 1 FROM execution_runs run
    WHERE run.batch_id = run_batches.id
      AND (
        run.status NOT IN ('succeeded', 'failed')
        OR (run.status = 'failed' AND COALESCE(run.terminal_reason_code, '') NOT IN (
          'TESTNG_ASSERTIONS_FAILED', 'TESTNG_CONFIGURATION_FAILED', 'TEST_ASSERTION_FAILED'
        ))
      )
  );
