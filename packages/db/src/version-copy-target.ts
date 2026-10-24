import type { VersionCopySqlDialect } from "./version-copy-plan";

/** Failed copies retain their reservation until their owned records are cleaned up. */
export const VERSION_COPY_RESERVED = "status NOT IN ('completed','cancelled')";

const DIRECT_VERSION_TABLES = [
  "test_stages",
  "project_version_runtime_assets",
  "case_sources",
  "case_definitions",
  "case_import_jobs",
  "ddt_import_jobs",
  "ddt_execution_configuration",
  "ddt_execution_class_range",
  "ddt_requirement_categories",
  "ddt_sr_execution_mappings",
  "ddt_cases",
  "ddt_sr_tags",
  "ddt_sr_tag_assignments",
  "ddt_deleted_cases",
  "ddt_case_templates",
  "ddt_debug_workspaces",
  "ddt_debug_cases",
  "ddt_change_requests",
] as const;

/** Probe indexed ownership, including historical/personal data that the copy does not overwrite. */
export function versionCopyTargetHasContentSql(dialect: VersionCopySqlDialect): string {
  const version = (column: string) =>
    dialect === "sqlite"
      ? `json_extract(${column}, '$.projectVersionId')`
      : `(${column}::jsonb ->> 'projectVersionId')`;
  return [
    ...DIRECT_VERSION_TABLES.map(
      (table) =>
        `EXISTS (SELECT 1 FROM ${table} c WHERE c.project_id=v.project_id AND c.project_version_id=v.id)`,
    ),
    ...["case_suites", "run_batches"].map(
      (table) =>
        `EXISTS (SELECT 1 FROM ${table} c WHERE c.project_id=v.project_id AND ${version("c.policy_json")}=v.id)`,
    ),
  ].join(" OR ");
}
