import type { VersionCopyCollection } from "@autoforge/application";

export type VersionCopySqlDialect = "sqlite" | "postgres";
export type VersionCopyTable = VersionCopyCollection & { predicate: string };

/** Explicit version-owned inventory; global identities, Runner credentials and live queue leases stay in place. */
export const VERSION_COPY_TABLES: readonly VersionCopyTable[] = [
  {
    name: "test_stages",
    primaryKey: ["id"],
    predicate: "c.id IN (SELECT id FROM selected_stages)",
  },
  {
    name: "project_runtime_assets",
    primaryKey: ["id"],
    predicate:
      "c.id IN (SELECT jdk_asset_id FROM project_version_runtime_assets WHERE project_version_id=(SELECT version_id FROM scope) UNION SELECT jar_bundle_asset_id FROM project_version_runtime_assets WHERE project_version_id=(SELECT version_id FROM scope))",
  },
  {
    name: "project_version_runtime_assets",
    primaryKey: ["project_version_id"],
    predicate: "c.project_version_id=(SELECT version_id FROM scope)",
  },
  {
    name: "case_sources",
    primaryKey: ["id"],
    predicate: "c.id IN (SELECT id FROM selected_sources)",
  },
  {
    name: "case_import_jobs",
    primaryKey: ["id"],
    predicate: "c.project_version_id=(SELECT version_id FROM scope)",
  },
  {
    name: "case_definitions",
    primaryKey: ["id"],
    predicate: "c.id IN (SELECT id FROM selected_cases)",
  },
  {
    name: "case_versions",
    primaryKey: ["id"],
    predicate: "c.case_definition_id IN (SELECT id FROM selected_cases)",
  },
  {
    name: "test_methods",
    primaryKey: ["id"],
    predicate: "c.case_definition_id IN (SELECT id FROM selected_cases)",
  },
  {
    name: "case_source_comparisons",
    primaryKey: ["id"],
    predicate:
      "c.current_source_id IN (SELECT id FROM selected_sources) AND c.candidate_source_id IN (SELECT id FROM selected_sources)",
  },
  {
    name: "ddt_import_jobs",
    primaryKey: ["id"],
    predicate: "c.project_version_id=(SELECT version_id FROM scope) AND c.debug_owner_id IS NULL",
  },
  {
    name: "ddt_import_files",
    primaryKey: ["id"],
    predicate: "c.job_id IN (SELECT id FROM selected_imports)",
  },
  {
    name: "ddt_import_case_ids",
    primaryKey: ["job_id", "case_id_normalized"],
    predicate: "c.job_id IN (SELECT id FROM selected_imports)",
  },
  {
    name: "ddt_cases",
    primaryKey: ["id"],
    predicate: "c.project_version_id=(SELECT version_id FROM scope)",
  },
  {
    name: "ddt_deleted_cases",
    primaryKey: ["id"],
    predicate: "c.project_version_id=(SELECT version_id FROM scope)",
  },
  {
    name: "ddt_case_history",
    primaryKey: ["id"],
    predicate:
      "c.ddt_case_id IN (SELECT id FROM ddt_cases WHERE project_version_id=(SELECT version_id FROM scope) UNION SELECT ddt_case_id FROM ddt_deleted_cases WHERE project_version_id=(SELECT version_id FROM scope))",
  },
  {
    name: "ddt_execution_configuration",
    primaryKey: ["project_id", "project_version_id", "test_stage_id"],
    predicate: "c.project_version_id=(SELECT version_id FROM scope)",
  },
  {
    name: "ddt_execution_class_range",
    primaryKey: [
      "project_id",
      "project_version_id",
      "test_stage_id",
      "execution_case_definition_id",
    ],
    predicate: "c.project_version_id=(SELECT version_id FROM scope)",
  },
  {
    name: "ddt_requirement_categories",
    primaryKey: ["id"],
    predicate: "c.project_version_id=(SELECT version_id FROM scope)",
  },
  {
    name: "ddt_sr_execution_mappings",
    primaryKey: ["project_id", "project_version_id", "test_stage_id", "sr_num_normalized"],
    predicate: "c.project_version_id=(SELECT version_id FROM scope)",
  },
  {
    name: "ddt_case_templates",
    primaryKey: ["id"],
    predicate: "c.project_version_id=(SELECT version_id FROM scope)",
  },
  {
    name: "ddt_change_requests",
    primaryKey: ["id"],
    predicate: "c.project_version_id=(SELECT version_id FROM scope)",
  },
  {
    name: "ddt_change_request_items",
    primaryKey: ["request_id", "position"],
    predicate:
      "c.request_id IN (SELECT id FROM ddt_change_requests WHERE project_version_id=(SELECT version_id FROM scope))",
  },
  {
    name: "case_suites",
    primaryKey: ["id"],
    predicate: "c.id IN (SELECT id FROM selected_suites)",
  },
  {
    name: "case_suite_items",
    primaryKey: ["id"],
    predicate: "c.suite_id IN (SELECT id FROM selected_suites)",
  },
  {
    name: "case_suite_ddt_items",
    primaryKey: ["id"],
    predicate: "c.suite_id IN (SELECT id FROM selected_suites)",
  },
  {
    name: "case_suite_versions",
    primaryKey: ["id"],
    predicate:
      "c.suite_id IN (SELECT id FROM selected_suites) OR EXISTS (SELECT 1 FROM run_batches b WHERE b.id IN (SELECT id FROM selected_batches) AND b.suite_id=c.suite_id AND b.suite_version=c.version)",
  },
  {
    name: "case_suite_round_recovery_credentials",
    primaryKey: ["suite_id", "rule_id"],
    predicate: "c.suite_id IN (SELECT id FROM selected_suites)",
  },
  {
    name: "case_suite_schedules",
    primaryKey: ["id"],
    predicate: "c.suite_id IN (SELECT id FROM selected_suites)",
  },
  {
    name: "webhook_configurations",
    primaryKey: ["id"],
    predicate:
      "c.id IN (SELECT webhook_id FROM case_suite_webhook_bindings WHERE suite_id IN (SELECT id FROM selected_suites) UNION SELECT webhook_id FROM webhook_deliveries WHERE batch_id IN (SELECT id FROM selected_batches))",
  },
  {
    name: "case_suite_webhook_bindings",
    primaryKey: ["suite_id", "webhook_id"],
    predicate: "c.suite_id IN (SELECT id FROM selected_suites)",
  },
  {
    name: "run_batches",
    primaryKey: ["id"],
    predicate: "c.id IN (SELECT id FROM selected_batches)",
  },
  {
    name: "run_batch_runners",
    primaryKey: ["batch_id", "runner_id"],
    predicate: "c.batch_id IN (SELECT id FROM selected_batches)",
  },
  {
    name: "execution_runs",
    primaryKey: ["id"],
    predicate: "c.batch_id IN (SELECT id FROM selected_batches)",
  },
  {
    name: "run_attempts",
    primaryKey: ["id"],
    predicate: "c.execution_run_id IN (SELECT id FROM selected_runs)",
  },
  {
    name: "assignments",
    primaryKey: ["id"],
    predicate: "c.batch_id IN (SELECT id FROM selected_batches)",
  },
  {
    name: "attempt_state_events",
    primaryKey: ["id"],
    predicate: "c.attempt_id IN (SELECT id FROM selected_attempts)",
  },
  {
    name: "attempt_log_watermarks",
    primaryKey: ["attempt_id", "stream"],
    predicate: "c.attempt_id IN (SELECT id FROM selected_attempts)",
  },
  {
    name: "attempt_artifacts",
    primaryKey: ["id"],
    predicate: "c.attempt_id IN (SELECT id FROM selected_attempts)",
  },
  {
    name: "public_batch_access",
    primaryKey: ["batch_id"],
    predicate: "c.batch_id IN (SELECT id FROM selected_batches)",
  },
  {
    name: "public_attempt_access",
    primaryKey: ["attempt_id"],
    predicate: "c.attempt_id IN (SELECT id FROM selected_attempts)",
  },
  {
    name: "webhook_deliveries",
    primaryKey: ["id"],
    predicate: "c.batch_id IN (SELECT id FROM selected_batches)",
  },
  {
    name: "run_batch_status_events",
    primaryKey: ["id"],
    predicate: "c.batch_id IN (SELECT id FROM selected_batches)",
  },
  {
    name: "run_batch_retry_concurrency_states",
    primaryKey: ["batch_id"],
    predicate: "c.batch_id IN (SELECT id FROM selected_batches)",
  },
  {
    name: "run_batch_round_concurrencies",
    primaryKey: ["batch_id", "execution_round"],
    predicate: "c.batch_id IN (SELECT id FROM selected_batches)",
  },
  {
    name: "run_batch_round_recoveries",
    primaryKey: ["batch_id", "rule_id"],
    predicate: "c.batch_id IN (SELECT id FROM selected_batches)",
  },
  {
    name: "scheduling_events",
    primaryKey: ["id"],
    predicate: "c.batch_id IN (SELECT id FROM selected_batches)",
  },
  {
    name: "failure_analysis_batches",
    primaryKey: ["batch_id"],
    predicate: "c.batch_id IN (SELECT id FROM selected_batches)",
  },
  {
    name: "failure_analysis_claims",
    primaryKey: ["id"],
    predicate: "c.batch_id IN (SELECT id FROM selected_batches)",
  },
  {
    name: "failure_analysis_claim_releases",
    primaryKey: ["id"],
    predicate: "c.batch_id IN (SELECT id FROM selected_batches)",
  },
  {
    name: "analytics_facts",
    primaryKey: ["attempt_id"],
    predicate: "c.batch_id IN (SELECT id FROM selected_batches)",
  },
  {
    name: "scheduled_trigger_receipts",
    primaryKey: ["schedule_id", "scheduled_for"],
    predicate:
      "c.schedule_id IN (SELECT id FROM case_suite_schedules WHERE suite_id IN (SELECT id FROM selected_suites)) AND (c.batch_id IS NULL OR c.batch_id IN (SELECT id FROM selected_batches))",
  },
];

export function versionCopyScopeSql(dialect: VersionCopySqlDialect): string {
  const json = (column: string) =>
    dialect === "sqlite"
      ? `json_extract(${column}, '$.projectVersionId')`
      : `(${column}::jsonb ->> 'projectVersionId')`;
  return `WITH scope(project_id,version_id) AS (VALUES (?,?)),
    base_batches AS (SELECT b.id FROM run_batches b,scope WHERE b.project_id=scope.project_id AND ${json("b.policy_json")}=scope.version_id),
    selected_batches AS (SELECT id FROM base_batches UNION SELECT r.batch_id FROM failure_analysis_claims a JOIN run_attempts p ON p.id=a.rerun_proof_attempt_id JOIN execution_runs r ON r.id=p.execution_run_id JOIN run_batches b ON b.id=r.batch_id WHERE a.batch_id IN (SELECT id FROM base_batches) AND b.project_id=(SELECT project_id FROM scope)),
    selected_runs AS (SELECT id FROM execution_runs WHERE batch_id IN (SELECT id FROM selected_batches)),
    selected_attempts AS (SELECT id FROM run_attempts WHERE execution_run_id IN (SELECT id FROM selected_runs)),
    selected_suites AS (SELECT s.id FROM case_suites s,scope WHERE s.project_id=scope.project_id AND ${json("s.policy_json")}=scope.version_id),
    selected_imports AS (SELECT id FROM ddt_import_jobs WHERE project_version_id=(SELECT version_id FROM scope) AND debug_owner_id IS NULL),
    selected_cases AS (SELECT id FROM case_definitions WHERE project_version_id=(SELECT version_id FROM scope) UNION SELECT d.id FROM case_definitions d JOIN execution_runs r ON r.case_definition_id=d.id OR r.execution_case_definition_id=d.id WHERE r.id IN (SELECT id FROM selected_runs)),
    base_sources AS (SELECT id FROM case_sources WHERE project_version_id=(SELECT version_id FROM scope) UNION SELECT source_id FROM case_definitions WHERE id IN (SELECT id FROM selected_cases) UNION SELECT source_id FROM case_versions WHERE case_definition_id IN (SELECT id FROM selected_cases)),
    selected_sources AS (SELECT id FROM base_sources UNION SELECT current_source_id FROM case_source_comparisons WHERE candidate_source_id IN (SELECT id FROM base_sources) UNION SELECT candidate_source_id FROM case_source_comparisons WHERE current_source_id IN (SELECT id FROM base_sources)),
    selected_stages AS (SELECT id FROM test_stages WHERE project_version_id=(SELECT version_id FROM scope) UNION SELECT test_stage_id FROM case_sources WHERE id IN (SELECT id FROM selected_sources) UNION SELECT test_stage_id FROM case_definitions WHERE id IN (SELECT id FROM selected_cases))`;
}

export function versionCopyRowKey(
  collection: VersionCopyCollection,
  row: Record<string, unknown>,
): string {
  return JSON.stringify(collection.primaryKey.map((key) => row[key]));
}
