import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

export const pgCaseSources = pgTable(
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
    inspectionJson: text("inspection_json").notNull(),
    authoritative: boolean("authoritative").notNull().default(false),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("case_sources_sha256_uq").on(table.sha256),
    uniqueIndex("case_sources_object_key_uq").on(table.objectKey),
    index("case_sources_created_at_idx").on(table.createdAt),
    uniqueIndex("case_sources_one_authoritative_uq")
      .on(table.authoritative)
      .where(sql`${table.authoritative} = true`),
  ],
);

export const pgCaseDefinitions = pgTable(
  "case_definitions",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => pgCaseSources.id, { onDelete: "cascade" }),
    className: text("class_name").notNull(),
    packageName: text("package_name").notNull(),
    displayName: text("display_name").notNull(),
    enabled: boolean("enabled").notNull(),
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

export const pgCaseVersions = pgTable(
  "case_versions",
  {
    id: text("id").primaryKey(),
    caseDefinitionId: text("case_definition_id")
      .notNull()
      .references(() => pgCaseDefinitions.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("case_versions_definition_version_uq").on(table.caseDefinitionId, table.version),
  ],
);

export const pgTestMethods = pgTable(
  "test_methods",
  {
    id: text("id").primaryKey(),
    caseDefinitionId: text("case_definition_id")
      .notNull()
      .references(() => pgCaseDefinitions.id, { onDelete: "cascade" }),
    methodName: text("method_name").notNull(),
    descriptor: text("descriptor").notNull(),
    enabled: boolean("enabled").notNull(),
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

export const pgCaseSuites = pgTable(
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

export const pgCaseSuiteItems = pgTable(
  "case_suite_items",
  {
    id: text("id").primaryKey(),
    suiteId: text("suite_id")
      .notNull()
      .references(() => pgCaseSuites.id, { onDelete: "cascade" }),
    caseDefinitionId: text("case_definition_id")
      .notNull()
      .references(() => pgCaseDefinitions.id, { onDelete: "cascade" }),
    addedAt: text("added_at").notNull(),
  },
  (table) => [
    uniqueIndex("case_suite_items_suite_case_uq").on(table.suiteId, table.caseDefinitionId),
    index("case_suite_items_suite_idx").on(table.suiteId),
  ],
);

export const pgRunners = pgTable(
  "runners",
  {
    id: text("id").primaryKey(),
    credentialHash: text("credential_hash").notNull(),
    name: text("name").notNull(),
    disabled: boolean("disabled").notNull().default(false),
    os: text("os").notNull(),
    architecture: text("architecture").notNull(),
    agentVersion: text("agent_version").notNull(),
    protocolVersion: integer("protocol_version").notNull(),
    labelsJson: text("labels_json").notNull(),
    maxConcurrency: integer("max_concurrency").notNull(),
    busySlots: integer("busy_slots").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    terminalEnabled: boolean("terminal_enabled").notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("runners_credential_hash_uq").on(table.credentialHash),
    index("runners_last_seen_at_idx").on(table.lastSeenAt),
  ],
);

export const pgRunnerBootstrapUses = pgTable("runner_bootstrap_uses", {
  tokenHash: text("token_hash").primaryKey(),
  usedAt: text("used_at").notNull(),
});

export const postgresSchema = {
  caseSources: pgCaseSources,
  caseDefinitions: pgCaseDefinitions,
  caseVersions: pgCaseVersions,
  testMethods: pgTestMethods,
  caseSuites: pgCaseSuites,
  caseSuiteItems: pgCaseSuiteItems,
  runners: pgRunners,
  runnerBootstrapUses: pgRunnerBootstrapUses,
};
