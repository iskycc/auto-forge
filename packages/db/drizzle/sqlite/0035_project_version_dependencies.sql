CREATE TABLE `project_version_runtime_assets` (
  `project_version_id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `jar_bundle_asset_id` text NOT NULL,
  `revision` integer DEFAULT 1 NOT NULL,
  `updated_by` text,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`project_version_id`) REFERENCES `project_versions`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`jar_bundle_asset_id`) REFERENCES `project_runtime_assets`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE INDEX `project_version_runtime_assets_project_idx`
  ON `project_version_runtime_assets` (`project_id`, `project_version_id`);
