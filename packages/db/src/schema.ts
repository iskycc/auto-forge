import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("case_sources_sha256_uq").on(table.sha256),
    uniqueIndex("case_sources_object_key_uq").on(table.objectKey),
    index("case_sources_created_at_idx").on(table.createdAt),
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
};
