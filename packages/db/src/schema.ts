import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const caseSources = sqliteTable(
  "case_sources",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    originalFileName: text("original_file_name").notNull(),
    objectKey: text("object_key").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    classCount: integer("class_count").notNull(),
    methodCount: integer("method_count").notNull(),
    status: text("status", { enum: ["ready", "failed"] }).notNull(),
    warningsJson: text("warnings_json").notNull(),
    inspectionJson: text("inspection_json").notNull().default("{}"),
    authoritative: integer("authoritative", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("case_sources_sha256_uq").on(table.sha256),
    uniqueIndex("case_sources_object_key_uq").on(table.objectKey),
    index("case_sources_created_at_idx").on(table.createdAt),
    uniqueIndex("case_sources_one_authoritative_uq")
      .on(table.authoritative)
      .where(sql`${table.authoritative} = 1`),
  ],
);

export const caseSuites = sqliteTable(
  "case_suites",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    version: integer("version").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("case_suites_updated_at_idx").on(table.updatedAt)],
);

export const runners = sqliteTable(
  "runners",
  {
    id: text("id").primaryKey(),
    credentialHash: text("credential_hash").notNull(),
    name: text("name").notNull(),
    disabled: integer("disabled", { mode: "boolean" }).notNull(),
    os: text("os").notNull(),
    architecture: text("architecture").notNull(),
    agentVersion: text("agent_version").notNull(),
    protocolVersion: integer("protocol_version").notNull(),
    labelsJson: text("labels_json").notNull(),
    maxConcurrency: integer("max_concurrency").notNull(),
    busySlots: integer("busy_slots").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    cpuUtilizationPercent: real("cpu_utilization_percent"),
    memoryUtilizationPercent: real("memory_utilization_percent"),
    loadAverage1m: real("load_average_1m"),
    logicalCpuCount: integer("logical_cpu_count"),
    metricsObservedAt: text("metrics_observed_at"),
    terminalEnabled: integer("terminal_enabled", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("runners_credential_hash_uq").on(table.credentialHash),
    index("runners_last_seen_at_idx").on(table.lastSeenAt),
  ],
);

export const runnerBootstrapUses = sqliteTable("runner_bootstrap_uses", {
  tokenHash: text("token_hash").primaryKey(),
  usedAt: text("used_at").notNull(),
});

export const runBatches = sqliteTable(
  "run_batches",
  {
    id: text("id").primaryKey(),
    suiteId: text("suite_id").notNull(),
    suiteName: text("suite_name").notNull(),
    suiteVersion: integer("suite_version").notNull(),
    status: text("status", {
      enum: ["queued", "dispatching", "scheduled", "running", "succeeded", "failed", "cancelled"],
    }).notNull(),
    retryLimit: integer("retry_limit").notNull(),
    environmentJson: text("environment_json").notNull(),
    totalRuns: integer("total_runs").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("run_batches_status_created_at_idx").on(table.status, table.createdAt),
    index("run_batches_suite_id_idx").on(table.suiteId),
  ],
);

export const runBatchRunners = sqliteTable(
  "run_batch_runners",
  {
    batchId: text("batch_id")
      .notNull()
      .references(() => runBatches.id, { onDelete: "cascade" }),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runners.id, { onDelete: "restrict" }),
  },
  (table) => [
    uniqueIndex("run_batch_runners_batch_runner_uq").on(table.batchId, table.runnerId),
    index("run_batch_runners_runner_idx").on(table.runnerId),
  ],
);

export const executionRuns = sqliteTable(
  "execution_runs",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id")
      .notNull()
      .references(() => runBatches.id, { onDelete: "cascade" }),
    caseDefinitionId: text("case_definition_id").notNull(),
    caseVersion: integer("case_version").notNull(),
    displayName: text("display_name").notNull(),
    className: text("class_name").notNull(),
    status: text("status", {
      enum: ["queued", "assigned", "running", "succeeded", "failed", "cancelled"],
    }).notNull(),
    assignedRunnerId: text("assigned_runner_id").references(() => runners.id, {
      onDelete: "restrict",
    }),
    attemptCount: integer("attempt_count").notNull(),
    schedulingScore: real("scheduling_score"),
    createdAt: text("created_at").notNull(),
    assignedAt: text("assigned_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("execution_runs_batch_case_uq").on(table.batchId, table.caseDefinitionId),
    index("execution_runs_batch_status_idx").on(table.batchId, table.status),
    index("execution_runs_runner_status_idx").on(table.assignedRunnerId, table.status),
  ],
);

export const runAttempts = sqliteTable(
  "run_attempts",
  {
    id: text("id").primaryKey(),
    executionRunId: text("execution_run_id")
      .notNull()
      .references(() => executionRuns.id, { onDelete: "cascade" }),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runners.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    status: text("status", {
      enum: ["assigned", "running", "succeeded", "failed", "timed_out", "cancelled"],
    }).notNull(),
    schedulingScore: real("scheduling_score").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("run_attempts_run_number_uq").on(table.executionRunId, table.attemptNumber),
    index("run_attempts_runner_status_idx").on(table.runnerId, table.status),
  ],
);

export const caseDefinitions = sqliteTable(
  "case_definitions",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => caseSources.id, { onDelete: "cascade" }),
    className: text("class_name").notNull(),
    packageName: text("package_name").notNull(),
    displayName: text("display_name").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    groupsJson: text("groups_json").notNull(),
    currentVersion: integer("current_version").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("case_definitions_source_class_uq").on(table.sourceId, table.className),
    index("case_definitions_class_name_idx").on(table.className),
  ],
);

export const caseSuiteItems = sqliteTable(
  "case_suite_items",
  {
    id: text("id").primaryKey(),
    suiteId: text("suite_id")
      .notNull()
      .references(() => caseSuites.id, { onDelete: "cascade" }),
    caseDefinitionId: text("case_definition_id")
      .notNull()
      .references(() => caseDefinitions.id, { onDelete: "cascade" }),
    addedAt: text("added_at").notNull(),
  },
  (table) => [
    uniqueIndex("case_suite_items_suite_case_uq").on(table.suiteId, table.caseDefinitionId),
    index("case_suite_items_suite_idx").on(table.suiteId),
  ],
);

export const caseVersions = sqliteTable(
  "case_versions",
  {
    id: text("id").primaryKey(),
    caseDefinitionId: text("case_definition_id")
      .notNull()
      .references(() => caseDefinitions.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("case_versions_definition_version_uq").on(table.caseDefinitionId, table.version),
  ],
);

export const testMethods = sqliteTable(
  "test_methods",
  {
    id: text("id").primaryKey(),
    caseDefinitionId: text("case_definition_id")
      .notNull()
      .references(() => caseDefinitions.id, { onDelete: "cascade" }),
    methodName: text("method_name").notNull(),
    descriptor: text("descriptor").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    annotationSource: text("annotation_source", { enum: ["method", "class"] }).notNull(),
    groupsJson: text("groups_json").notNull(),
    description: text("description"),
    dataProvider: text("data_provider"),
    dependsOnMethodsJson: text("depends_on_methods_json").notNull(),
    dependsOnGroupsJson: text("depends_on_groups_json").notNull(),
    priority: integer("priority"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("test_methods_definition_method_descriptor_uq").on(
      table.caseDefinitionId,
      table.methodName,
      table.descriptor,
    ),
    index("test_methods_definition_idx").on(table.caseDefinitionId),
  ],
);

export const schema = {
  caseSources,
  caseDefinitions,
  caseVersions,
  testMethods,
  caseSuites,
  caseSuiteItems,
  runners,
  runnerBootstrapUses,
  runBatches,
  runBatchRunners,
  executionRuns,
  runAttempts,
};
