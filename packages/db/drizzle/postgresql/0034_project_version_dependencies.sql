CREATE TABLE "project_version_runtime_assets" (
  "project_version_id" text PRIMARY KEY NOT NULL REFERENCES "project_versions"("id") ON DELETE cascade,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "jar_bundle_asset_id" text NOT NULL REFERENCES "project_runtime_assets"("id") ON DELETE restrict,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_by" text,
  "updated_at" text NOT NULL
);
CREATE INDEX "project_version_runtime_assets_project_idx"
  ON "project_version_runtime_assets" ("project_id", "project_version_id");
