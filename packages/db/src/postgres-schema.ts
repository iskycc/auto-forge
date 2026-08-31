import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  primaryKey,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const pgProjects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    ownerUserId: text("owner_user_id"),
  },
  (table) => [
    uniqueIndex("projects_slug_uq").on(table.slug),
    uniqueIndex("projects_one_default_uq")
      .on(table.isDefault)
      .where(sql`${table.isDefault} = true`),
  ],
);

export const pgProjectVersions = pgTable(
  "project_versions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => pgProjects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("project_versions_project_name_uq").on(table.projectId, table.normalizedName),
    index("project_versions_project_status_idx").on(table.projectId, table.status),
  ],
);

export const pgTestStages = pgTable(
  "test_stages",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => pgProjects.id, { onDelete: "cascade" }),
    projectVersionId: text("project_version_id")
      .notNull()
      .references(() => pgProjectVersions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    description: text("description").notNull().default(""),
    position: integer("position").notNull(),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("test_stages_version_name_uq").on(table.projectVersionId, table.normalizedName),
    uniqueIndex("test_stages_version_position_uq").on(table.projectVersionId, table.position),
    index("test_stages_project_version_idx").on(table.projectId, table.projectVersionId),
  ],
);

export const pgProjectRuntimeAssets = pgTable(
  "project_runtime_assets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => pgProjects.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["jdk", "jar-bundle"] }).notNull(),
    sourceType: text("source_type", { enum: ["upload", "url"] }).notNull(),
    fileName: text("file_name").notNull(),
    url: text("url"),
    objectKey: text("object_key"),
    sha256: text("sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    archiveFormat: text("archive_format", { enum: ["zip", "tar.gz"] }).notNull(),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("project_runtime_assets_object_key_uq").on(table.objectKey),
    index("project_runtime_assets_project_kind_idx").on(table.projectId, table.kind),
  ],
);

export const pgProjectAdapterConfigurations = pgTable("project_adapter_configurations", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => pgProjects.id, { onDelete: "cascade" }),
  suiteName: text("suite_name").notNull().default(""),
  testName: text("test_name").notNull().default(""),
  environmentAddress: text("environment_address").notNull().default(""),
  jdkAssetId: text("jdk_asset_id").references(() => pgProjectRuntimeAssets.id, {
    onDelete: "set null",
  }),
  jarBundleAssetId: text("jar_bundle_asset_id").references(() => pgProjectRuntimeAssets.id, {
    onDelete: "set null",
  }),
  revision: integer("revision").notNull().default(1),
  updatedBy: text("updated_by"),
  updatedAt: text("updated_at").notNull(),
});

export const pgProjectVersionRuntimeAssets = pgTable("project_version_runtime_assets", {
  projectVersionId: text("project_version_id")
    .primaryKey()
    .references(() => pgProjectVersions.id, { onDelete: "cascade" }),
  projectId: text("project_id")
    .notNull()
    .references(() => pgProjects.id, { onDelete: "cascade" }),
  jdkAssetId: text("jdk_asset_id").references(() => pgProjectRuntimeAssets.id, {
    onDelete: "restrict",
  }),
  jarBundleAssetId: text("jar_bundle_asset_id").references(() => pgProjectRuntimeAssets.id, {
    onDelete: "restrict",
  }),
  inheritedFromProjectVersionId: text("inherited_from_project_version_id").references(
    () => pgProjectVersions.id,
    { onDelete: "set null" },
  ),
  revision: integer("revision").notNull().default(1),
  updatedBy: text("updated_by"),
  updatedAt: text("updated_at").notNull(),
});

export const pgUsers = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    normalizedUsername: text("normalized_username").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    ldapGroupsJson: text("ldap_groups_json").notNull().default("[]"),
    source: text("source", { enum: ["local", "ldap"] }).notNull(),
    status: text("status", { enum: ["active", "disabled"] }).notNull(),
    passwordHash: text("password_hash"),
    passwordUpdatedAt: text("password_updated_at"),
    forcePasswordChange: boolean("force_password_change").notNull().default(false),
    failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
    lockedUntil: text("locked_until"),
    lastLoginAt: text("last_login_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    uniqueIndex("users_normalized_username_uq").on(table.normalizedUsername),
    index("users_status_updated_at_idx").on(table.status, table.updatedAt),
  ],
);

export const pgExternalIdentities = pgTable(
  "external_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => pgUsers.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    subject: text("subject").notNull(),
    directoryUsername: text("directory_username").notNull(),
    attributesJson: text("attributes_json").notNull(),
    synchronizedAt: text("synchronized_at").notNull(),
  },
  (table) => [
    uniqueIndex("external_identities_provider_subject_uq").on(table.providerId, table.subject),
    index("external_identities_user_idx").on(table.userId),
  ],
);

export const pgUserSessions = pgTable(
  "user_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => pgUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    uniqueIndex("user_sessions_token_hash_uq").on(table.tokenHash),
    index("user_sessions_user_active_idx").on(table.userId, table.revokedAt, table.expiresAt),
  ],
);

export const pgRoles = pgTable(
  "roles",
  {
    id: text("id").primaryKey(),
    key: text("role_key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    scope: text("scope", { enum: ["system", "project"] }).notNull(),
    builtIn: boolean("built_in").notNull().default(false),
    active: boolean("active").notNull().default(true),
    permissionsJson: text("permissions_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("roles_key_uq").on(table.key)],
);

export const pgUserSystemRoles = pgTable(
  "user_system_roles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => pgUsers.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => pgRoles.id, { onDelete: "restrict" }),
    source: text("source", { enum: ["manual", "ldap"] })
      .notNull()
      .default("manual"),
    assignedAt: text("assigned_at").notNull(),
    assignedBy: text("assigned_by").references(() => pgUsers.id, { onDelete: "set null" }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.roleId] })],
);

export const pgProjectRoleBindings = pgTable(
  "project_role_bindings",
  {
    userId: text("user_id")
      .notNull()
      .references(() => pgUsers.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => pgProjects.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => pgRoles.id, { onDelete: "restrict" }),
    source: text("source", { enum: ["manual", "ldap"] })
      .notNull()
      .default("manual"),
    assignedAt: text("assigned_at").notNull(),
    assignedBy: text("assigned_by").references(() => pgUsers.id, { onDelete: "set null" }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.projectId, table.roleId] }),
    index("project_role_bindings_project_idx").on(table.projectId, table.userId),
  ],
);

export const pgAuthBootstrapUses = pgTable("auth_bootstrap_uses", {
  tokenHash: text("token_hash").primaryKey(),
  usedAt: text("used_at").notNull(),
});

export const pgLdapConfigurations = pgTable("ldap_configurations", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  urlsJson: text("urls_json").notNull(),
  tlsMode: text("tls_mode", { enum: ["ldaps", "starttls"] }).notNull(),
  transportMode: text("transport_mode", { enum: ["ldaps", "starttls", "plain"] })
    .notNull()
    .default("ldaps"),
  verifyTlsCertificate: boolean("verify_tls_certificate").notNull().default(true),
  caPem: text("ca_pem"),
  connectTimeoutMs: integer("connect_timeout_ms").notNull(),
  operationTimeoutMs: integer("operation_timeout_ms").notNull(),
  pageSize: integer("page_size").notNull(),
  maximumUsers: integer("maximum_users").notNull(),
  synchronizationIntervalMinutes: integer("synchronization_interval_minutes").notNull().default(0),
  bindDn: text("bind_dn").notNull(),
  bindPasswordEncrypted: text("bind_password_encrypted"),
  userBaseDn: text("user_base_dn").notNull(),
  userFilter: text("user_filter").notNull(),
  userIdAttribute: text("user_id_attribute").notNull(),
  usernameAttribute: text("username_attribute").notNull(),
  displayNameAttribute: text("display_name_attribute").notNull(),
  emailAttribute: text("email_attribute").notNull(),
  groupBaseDn: text("group_base_dn"),
  groupFilter: text("group_filter"),
  groupMemberAttribute: text("group_member_attribute").notNull(),
  groupAttribute: text("group_attribute").notNull().default("memberOf"),
  groupNameAttribute: text("group_name_attribute").notNull().default("cn"),
  defaultRole: text("default_role", { enum: ["admin", "editor", "viewer"] })
    .notNull()
    .default("editor"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by").notNull().default(""),
  version: integer("version").notNull().default(1),
});

export const pgLdapGroupMappings = pgTable(
  "ldap_group_mappings",
  {
    id: text("id").primaryKey(),
    groupDn: text("group_dn").notNull(),
    normalizedGroupDn: text("normalized_group_dn").notNull(),
    roleId: text("role_id")
      .notNull()
      .references(() => pgRoles.id, { onDelete: "restrict" }),
    projectId: text("project_id").references(() => pgProjects.id, { onDelete: "cascade" }),
    priority: integer("priority").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("ldap_group_mappings_group_idx").on(table.normalizedGroupDn)],
);

export const pgAuditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    actorType: text("actor_type", { enum: ["user", "runner", "system"] }).notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    projectId: text("project_id").references(() => pgProjects.id, { onDelete: "set null" }),
    result: text("result", { enum: ["succeeded", "rejected", "failed"] }).notNull(),
    requestId: text("request_id"),
    detailsJson: text("details_json").notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (table) => [
    index("audit_events_recorded_at_idx").on(table.recordedAt, table.id),
    index("audit_events_actor_idx").on(table.actorId, table.recordedAt),
    index("audit_events_resource_idx").on(table.resourceType, table.resourceId, table.recordedAt),
  ],
);

export const pgCaseSources = pgTable(
  "case_sources",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().default("00000000-0000-7000-8000-000000000001"),
    projectVersionId: text("project_version_id").references(() => pgProjectVersions.id, {
      onDelete: "restrict",
    }),
    testStageId: text("test_stage_id").references(() => pgTestStages.id, {
      onDelete: "restrict",
    }),
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
    lifecycleStatus: text("lifecycle_status", { enum: ["active", "archived", "deleting"] })
      .notNull()
      .default("active"),
    revision: integer("revision").notNull().default(1),
    importedBy: text("imported_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("case_sources_legacy_project_sha256_uq")
      .on(table.projectId, table.sha256)
      .where(sql`${table.projectVersionId} IS NULL AND ${table.testStageId} IS NULL`),
    uniqueIndex("case_sources_stage_sha256_uq")
      .on(table.projectId, table.projectVersionId, table.testStageId, table.sha256)
      .where(sql`${table.projectVersionId} IS NOT NULL AND ${table.testStageId} IS NOT NULL`),
    index("case_sources_object_key_idx").on(table.objectKey),
    index("case_sources_created_at_idx").on(table.createdAt),
    uniqueIndex("case_sources_legacy_authoritative_uq")
      .on(table.projectId, table.authoritative)
      .where(
        sql`${table.authoritative} = true AND ${table.projectVersionId} IS NULL AND ${table.testStageId} IS NULL`,
      ),
    uniqueIndex("case_sources_stage_authoritative_uq")
      .on(table.projectId, table.projectVersionId, table.testStageId, table.authoritative)
      .where(
        sql`${table.authoritative} = true AND ${table.projectVersionId} IS NOT NULL AND ${table.testStageId} IS NOT NULL`,
      ),
    index("case_sources_project_created_idx").on(table.projectId, table.createdAt),
  ],
);

export const pgCaseDefinitions = pgTable(
  "case_definitions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().default("00000000-0000-7000-8000-000000000001"),
    projectVersionId: text("project_version_id").references(() => pgProjectVersions.id, {
      onDelete: "restrict",
    }),
    testStageId: text("test_stage_id").references(() => pgTestStages.id, {
      onDelete: "restrict",
    }),
    directoryPath: text("directory_path").notNull().default(""),
    sourceId: text("source_id")
      .notNull()
      .references(() => pgCaseSources.id, { onDelete: "cascade" }),
    className: text("class_name").notNull(),
    packageName: text("package_name").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description").notNull().default(""),
    tagsJson: text("tags_json").notNull().default("[]"),
    parametersJson: text("parameters_json").notNull().default("{}"),
    enabled: boolean("enabled").notNull(),
    archived: boolean("archived").notNull().default(false),
    revision: integer("revision").notNull().default(1),
    updatedBy: text("updated_by"),
    groupsJson: text("groups_json").notNull(),
    currentVersion: integer("current_version").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("case_definitions_source_class_idx").on(table.sourceId, table.className),
    index("case_definitions_hierarchy_class_idx").on(
      table.projectId,
      table.projectVersionId,
      table.testStageId,
      table.className,
    ),
    index("case_definitions_class_name_idx").on(table.className),
    index("case_definitions_stage_directory_idx").on(
      table.projectId,
      table.projectVersionId,
      table.testStageId,
      table.directoryPath,
    ),
  ],
);

export const pgCaseVersions = pgTable(
  "case_versions",
  {
    id: text("id").primaryKey(),
    caseDefinitionId: text("case_definition_id")
      .notNull()
      .references(() => pgCaseDefinitions.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => pgCaseSources.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    createdBy: text("created_by"),
    changeReason: text("change_reason").notNull().default("source.import"),
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
    projectId: text("project_id").notNull().default("00000000-0000-7000-8000-000000000001"),
    name: text("name").notNull(),
    description: text("description"),
    version: integer("version").notNull(),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    enabled: boolean("enabled").notNull().default(true),
    revision: integer("revision").notNull().default(1),
    policyJson: text("policy_json").notNull().default("{}"),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("case_suites_updated_at_idx").on(table.updatedAt)],
);

export const pgCaseSuiteRoundRecoveryCredentials = pgTable(
  "case_suite_round_recovery_credentials",
  {
    suiteId: text("suite_id")
      .notNull()
      .references(() => pgCaseSuites.id, { onDelete: "cascade" }),
    ruleId: text("rule_id").notNull(),
    apiKeyCiphertext: text("api_key_ciphertext").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.suiteId, table.ruleId] })],
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
    credentialVersion: integer("credential_version").notNull().default(1),
    credentialRevokedAt: text("credential_revoked_at"),
    credentialRotationRequestedAt: text("credential_rotation_requested_at"),
    previousCredentialHash: text("previous_credential_hash"),
    previousCredentialValidUntil: text("previous_credential_valid_until"),
    deregisteredAt: text("deregistered_at"),
    purgedAt: text("purged_at"),
    name: text("name").notNull(),
    disabled: boolean("disabled").notNull().default(false),
    draining: boolean("draining").notNull().default(false),
    os: text("os").notNull(),
    architecture: text("architecture").notNull(),
    agentVersion: text("agent_version").notNull(),
    protocolVersion: integer("protocol_version").notNull(),
    labelsJson: text("labels_json").notNull(),
    capabilitiesJson: text("capabilities_json").notNull().default("[]"),
    maxConcurrency: integer("max_concurrency").notNull(),
    busySlots: integer("busy_slots").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    cpuUtilizationPercent: doublePrecision("cpu_utilization_percent"),
    memoryUtilizationPercent: doublePrecision("memory_utilization_percent"),
    loadAverage1m: doublePrecision("load_average_1m"),
    logicalCpuCount: integer("logical_cpu_count"),
    metricsObservedAt: text("metrics_observed_at"),
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

export const pgRunnerInstallationProfiles = pgTable(
  "runner_installation_profiles",
  {
    id: text("id").primaryKey(),
    runnerId: text("runner_id").references(() => pgRunners.id, { onDelete: "set null" }),
    runnerName: text("runner_name").notNull(),
    connectionEncrypted: text("connection_encrypted").notNull(),
    expectedHostKeySha256: text("expected_host_key_sha256").notNull(),
    installationMode: text("installation_mode", {
      enum: ["auto", "ubuntu", "opensuse", "opensuse-leap", "opensuse-tumbleweed"],
    }).notNull(),
    runAsRoot: boolean("run_as_root").notNull().default(false),
    dataDirectory: text("data_directory"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("runner_installation_profiles_runner_uq").on(table.runnerId),
    index("runner_installation_profiles_name_idx").on(table.runnerName, table.updatedAt),
  ],
);

export const pgRunnerGroups = pgTable(
  "runner_groups",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    description: text("description").notNull().default(""),
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("runner_groups_normalized_name_uq").on(table.normalizedName)],
);

export const pgRunnerGroupMembers = pgTable(
  "runner_group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => pgRunnerGroups.id, { onDelete: "cascade" }),
    runnerId: text("runner_id")
      .notNull()
      .references(() => pgRunners.id, { onDelete: "cascade" }),
    addedAt: text("added_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.runnerId] }),
    index("runner_group_members_runner_idx").on(table.runnerId, table.groupId),
  ],
);

export const pgExecutionEnvironments = pgTable(
  "execution_environments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => pgProjects.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    description: text("description").notNull(),
    status: text("status", { enum: ["active", "disabled"] }).notNull(),
    currentVersion: integer("current_version").notNull(),
    revision: integer("revision").notNull().default(1),
    createdBy: text("created_by")
      .notNull()
      .references(() => pgUsers.id, { onDelete: "restrict" }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("execution_environments_project_name_uq").on(table.projectId, table.normalizedName),
    index("execution_environments_project_status_idx").on(table.projectId, table.status),
  ],
);

export const pgExecutionEnvironmentVersions = pgTable(
  "execution_environment_versions",
  {
    id: text("id").primaryKey(),
    environmentId: text("environment_id")
      .notNull()
      .references(() => pgExecutionEnvironments.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    variablesJson: text("variables_json").notNull(),
    secretBindingsJson: text("secret_bindings_json").notNull().default("[]"),
    createdBy: text("created_by")
      .notNull()
      .references(() => pgUsers.id, { onDelete: "restrict" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("execution_environment_versions_number_uq").on(table.environmentId, table.version),
  ],
);

export const pgExecutionSecrets = pgTable(
  "execution_secrets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => pgProjects.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    description: text("description").notNull(),
    status: text("status", { enum: ["active", "disabled"] }).notNull(),
    currentVersion: integer("current_version").notNull(),
    revision: integer("revision").notNull().default(1),
    createdBy: text("created_by")
      .notNull()
      .references(() => pgUsers.id, { onDelete: "restrict" }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("execution_secrets_project_name_uq").on(table.projectId, table.normalizedName),
    index("execution_secrets_project_status_idx").on(table.projectId, table.status),
  ],
);

export const pgExecutionSecretVersions = pgTable(
  "execution_secret_versions",
  {
    id: text("id").primaryKey(),
    secretId: text("secret_id")
      .notNull()
      .references(() => pgExecutionSecrets.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    valueEncrypted: text("value_encrypted").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => pgUsers.id, { onDelete: "restrict" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("execution_secret_versions_number_uq").on(table.secretId, table.version)],
);

export const pgRunBatches = pgTable(
  "run_batches",
  {
    id: text("id").primaryKey(),
    // 自然递增展示编号；UUID 主键不变，该列只服务界面展示，由仓储从序列生成。
    sequenceNumber: integer("sequence_number").notNull().default(0),
    suiteId: text("suite_id").notNull(),
    suiteName: text("suite_name").notNull(),
    suiteVersion: integer("suite_version").notNull(),
    batchKind: text("batch_kind", {
      enum: ["standard", "final_failure_rerun", "case_log_rerun"],
    })
      .notNull()
      .default("standard"),
    parentBatchId: text("parent_batch_id"),
    sourceExecutionRunId: text("source_execution_run_id"),
    requestedByUsername: text("requested_by_username"),
    requestedBySource: text("requested_by_source", { enum: ["local", "ldap"] }),
    status: text("status", {
      enum: ["queued", "dispatching", "scheduled", "running", "succeeded", "failed", "cancelled"],
    }).notNull(),
    retryLimit: integer("retry_limit").notNull(),
    retryMode: text("retry_mode", { enum: ["immediate", "round"] })
      .notNull()
      .default("immediate"),
    currentRound: integer("current_round").notNull().default(1),
    queueTimeoutMs: integer("queue_timeout_ms").notNull().default(86_400_000),
    claimTimeoutMs: integer("claim_timeout_ms").notNull().default(300_000),
    executionTimeoutMs: integer("execution_timeout_ms").notNull().default(3_600_000),
    uploadTimeoutMs: integer("upload_timeout_ms").notNull().default(600_000),
    environmentJson: text("environment_json").notNull(),
    secretBindingsJson: text("secret_bindings_json").notNull().default("[]"),
    totalRuns: integer("total_runs").notNull(),
    projectId: text("project_id").notNull().default("00000000-0000-7000-8000-000000000001"),
    environmentId: text("environment_id").references(() => pgExecutionEnvironments.id, {
      onDelete: "restrict",
    }),
    environmentVersionId: text("environment_version_id").references(
      () => pgExecutionEnvironmentVersions.id,
      { onDelete: "restrict" },
    ),
    priority: integer("priority").notNull().default(0),
    policyJson: text("policy_json"),
    adapterRuntimeJson: text("adapter_runtime_json"),
    cancelRequestedAt: text("cancel_requested_at"),
    version: integer("version").notNull().default(1),
    scheduledFor: text("scheduled_for").notNull().default("1970-01-01T00:00:00.000Z"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("run_batches_status_created_at_idx").on(table.status, table.createdAt),
    index("run_batches_status_scheduled_for_idx").on(table.status, table.scheduledFor),
    index("run_batches_suite_id_idx").on(table.suiteId),
    index("run_batches_project_created_id_idx").on(table.projectId, table.createdAt, table.id),
  ],
);

export const pgRunBatchRetryConcurrencyStates = pgTable("run_batch_retry_concurrency_states", {
  batchId: text("batch_id")
    .primaryKey()
    .references(() => pgRunBatches.id, { onDelete: "cascade" }),
  ruleId: text("rule_id").notNull(),
  ruleIndex: integer("rule_index").notNull(),
  concurrency: integer("concurrency").notNull(),
  activatedRound: integer("activated_round").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const pgRunBatchRoundConcurrencies = pgTable(
  "run_batch_round_concurrencies",
  {
    batchId: text("batch_id")
      .notNull()
      .references(() => pgRunBatches.id, { onDelete: "cascade" }),
    executionRound: integer("execution_round").notNull(),
    concurrency: integer("concurrency").notNull(),
    source: text("source", { enum: ["base", "inherited_rule", "rule_transition"] }).notNull(),
    ruleId: text("rule_id"),
    previousConcurrency: integer("previous_concurrency"),
    recordedAt: text("recorded_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.batchId, table.executionRound] })],
);

export const pgRunBatchStatusEvents = pgTable(
  "run_batch_status_events",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id")
      .notNull()
      .references(() => pgRunBatches.id, { onDelete: "cascade" }),
    fromStatus: text("from_status", {
      enum: ["queued", "dispatching", "scheduled", "running", "succeeded", "failed", "cancelled"],
    }),
    toStatus: text("to_status", {
      enum: ["queued", "dispatching", "scheduled", "running", "succeeded", "failed", "cancelled"],
    }).notNull(),
    batchVersion: integer("batch_version").notNull(),
    reason: text("reason").notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (table) => [
    index("run_batch_status_events_batch_idx").on(table.batchId, table.recordedAt, table.id),
  ],
);

export const pgWebhookConfigurations = pgTable(
  "webhook_configurations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => pgProjects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    description: text("description").notNull().default(""),
    targetUrl: text("target_url").notNull(),
    method: text("method", { enum: ["GET", "POST"] }).notNull(),
    bodyTemplate: text("body_template"),
    enabled: boolean("enabled").notNull().default(true),
    enabledAt: text("enabled_at"),
    revision: integer("revision").notNull().default(1),
    deletedAt: text("deleted_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("webhook_configurations_project_name_uq")
      .on(table.projectId, table.normalizedName)
      .where(sql`${table.deletedAt} IS NULL`),
    index("webhook_configurations_project_idx").on(table.projectId, table.createdAt),
  ],
);

export const pgCaseSuiteWebhookBindings = pgTable(
  "case_suite_webhook_bindings",
  {
    suiteId: text("suite_id")
      .notNull()
      .references(() => pgCaseSuites.id, { onDelete: "cascade" }),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => pgWebhookConfigurations.id, { onDelete: "restrict" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.suiteId, table.webhookId] }),
    index("case_suite_webhook_bindings_webhook_idx").on(table.webhookId, table.suiteId),
  ],
);

export const pgWebhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => pgWebhookConfigurations.id, { onDelete: "restrict" }),
    batchId: text("batch_id")
      .notNull()
      .references(() => pgRunBatches.id, { onDelete: "cascade" }),
    webhookName: text("webhook_name").notNull(),
    requestUrl: text("request_url").notNull(),
    requestMethod: text("request_method", { enum: ["GET", "POST"] }).notNull(),
    requestBodyTemplate: text("request_body_template"),
    status: text("status", {
      enum: ["pending", "delivering", "succeeded", "failed"],
    }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    availableAt: text("available_at").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    responseStatus: integer("response_status"),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
    deliveredAt: text("delivered_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("webhook_deliveries_webhook_batch_uq").on(table.webhookId, table.batchId),
    index("webhook_deliveries_due_idx").on(table.status, table.availableAt, table.leaseExpiresAt),
    index("webhook_deliveries_webhook_created_idx").on(table.webhookId, table.createdAt),
  ],
);

export const pgRunBatchRunners = pgTable(
  "run_batch_runners",
  {
    batchId: text("batch_id")
      .notNull()
      .references(() => pgRunBatches.id, { onDelete: "cascade" }),
    runnerId: text("runner_id")
      .notNull()
      .references(() => pgRunners.id, { onDelete: "restrict" }),
  },
  (table) => [
    uniqueIndex("run_batch_runners_batch_runner_uq").on(table.batchId, table.runnerId),
    index("run_batch_runners_runner_idx").on(table.runnerId),
  ],
);

export const pgExecutionRuns = pgTable(
  "execution_runs",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id")
      .notNull()
      .references(() => pgRunBatches.id, { onDelete: "cascade" }),
    caseDefinitionId: text("case_definition_id").notNull(),
    caseVersion: integer("case_version").notNull(),
    displayName: text("display_name").notNull(),
    className: text("class_name").notNull(),
    caseType: text("case_type", { enum: ["testng", "ddt"] })
      .notNull()
      .default("testng"),
    executionCaseDefinitionId: text("execution_case_definition_id"),
    classDataJson: text("class_data_json"),
    classDataSizeBytes: integer("class_data_size_bytes"),
    classDataSha256: text("class_data_sha256"),
    ddtSrNum: text("ddt_sr_num"),
    parametersJson: text("parameters_json").notNull().default("{}"),
    status: text("status", {
      enum: ["queued", "assigned", "running", "succeeded", "failed", "cancelled"],
    }).notNull(),
    assignedRunnerId: text("assigned_runner_id").references(() => pgRunners.id, {
      onDelete: "restrict",
    }),
    attemptCount: integer("attempt_count").notNull(),
    schedulingScore: doublePrecision("scheduling_score"),
    createdAt: text("created_at").notNull(),
    assignedAt: text("assigned_at"),
    heldRound: integer("held_round").notNull().default(0),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull().default(1),
    terminalOutcome: text("terminal_outcome", {
      enum: ["succeeded", "failed", "timed_out", "cancelled"],
    }),
    terminalReasonCode: text("terminal_reason_code"),
    cancelRequestedAt: text("cancel_requested_at"),
    queueDeadlineAt: text("queue_deadline_at"),
    executionTimeoutMs: integer("execution_timeout_ms").notNull().default(3_600_000),
    uploadTimeoutMs: integer("upload_timeout_ms").notNull().default(600_000),
  },
  (table) => [
    uniqueIndex("execution_runs_batch_case_uq").on(table.batchId, table.caseDefinitionId),
    index("execution_runs_batch_status_idx").on(table.batchId, table.status),
    index("execution_runs_batch_created_idx").on(table.batchId, table.createdAt, table.id),
    index("execution_runs_batch_name_idx").on(table.batchId, table.displayName, table.id),
    index("execution_runs_case_created_idx").on(table.caseDefinitionId, table.createdAt, table.id),
    index("execution_runs_runner_status_idx").on(table.assignedRunnerId, table.status),
  ],
);

export const pgRunAttempts = pgTable(
  "run_attempts",
  {
    id: text("id").primaryKey(),
    executionRunId: text("execution_run_id")
      .notNull()
      .references(() => pgExecutionRuns.id, { onDelete: "cascade" }),
    runnerId: text("runner_id")
      .notNull()
      .references(() => pgRunners.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    status: text("status", {
      enum: ["assigned", "running", "succeeded", "failed", "timed_out", "cancelled"],
    }).notNull(),
    schedulingScore: doublePrecision("scheduling_score").notNull(),
    createdAt: text("created_at").notNull(),
    version: integer("version").notNull().default(1),
    startedAt: text("started_at"),
    uploadStartedAt: text("upload_started_at"),
    finishedAt: text("finished_at"),
    outcome: text("outcome", { enum: ["succeeded", "failed", "timed_out", "cancelled"] }),
    resultCode: text("result_code"),
    resultSummary: text("result_summary"),
    completionDigest: text("completion_digest"),
    durationMs: integer("duration_ms"),
    testNgResultJson: text("testng_result_json"),
  },
  (table) => [
    uniqueIndex("run_attempts_run_number_uq").on(table.executionRunId, table.attemptNumber),
    index("run_attempts_runner_status_idx").on(table.runnerId, table.status),
  ],
);

// 日志公开访问：token 明文只出现在导出响应中，库中只存 SHA-256 哈希。
// expires_at 对新记录为永久哨兵值（应用层 PERMANENT_LOG_ACCESS_EXPIRY），列保持 NOT NULL。
export const pgAttemptLogShares = pgTable(
  "attempt_log_shares",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => pgRunAttempts.id, { onDelete: "cascade" }),
    batchId: text("batch_id")
      .notNull()
      .references(() => pgRunBatches.id, { onDelete: "cascade" }),
    // 创建者用户 id 不加外键：账号删除后公开访问记录仍需保留审计。
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    uniqueIndex("attempt_log_shares_token_uq").on(table.tokenHash),
    index("attempt_log_shares_attempt_idx").on(table.attemptId, table.expiresAt),
  ],
);

export const pgAssignments = pgTable(
  "assignments",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => pgRunAttempts.id, { onDelete: "cascade" }),
    executionRunId: text("execution_run_id")
      .notNull()
      .references(() => pgExecutionRuns.id, { onDelete: "cascade" }),
    batchId: text("batch_id")
      .notNull()
      .references(() => pgRunBatches.id, { onDelete: "cascade" }),
    runnerId: text("runner_id")
      .notNull()
      .references(() => pgRunners.id, { onDelete: "restrict" }),
    status: text("status", {
      enum: ["pending", "claimed", "running", "completed", "cancelled", "expired"],
    }).notNull(),
    priority: integer("priority").notNull().default(0),
    executionSpecJson: text("execution_spec_json").notNull(),
    availableAt: text("available_at").notNull(),
    claimDeadlineAt: text("claim_deadline_at").notNull(),
    claimedAt: text("claimed_at"),
    completedAt: text("completed_at"),
    cancelRequestedAt: text("cancel_requested_at"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("assignments_attempt_uq").on(table.attemptId),
    index("assignments_runner_claim_idx").on(
      table.runnerId,
      table.status,
      table.availableAt,
      table.priority,
      table.createdAt,
    ),
    index("assignments_batch_status_idx").on(table.batchId, table.status),
  ],
);

export const pgAssignmentLeases = pgTable(
  "assignment_leases",
  {
    id: text("id").primaryKey(),
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => pgAssignments.id, { onDelete: "cascade" }),
    runnerId: text("runner_id")
      .notNull()
      .references(() => pgRunners.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull(),
    tokenEncrypted: text("token_encrypted").notNull(),
    status: text("status", { enum: ["active", "released", "expired", "revoked"] }).notNull(),
    version: integer("version").notNull().default(1),
    expiresAt: text("expires_at").notNull(),
    renewedAt: text("renewed_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("assignment_leases_token_uq").on(table.tokenHash),
    index("assignment_leases_expiry_idx").on(table.status, table.expiresAt),
  ],
);

export const pgAssignmentClaimRequests = pgTable(
  "assignment_claim_requests",
  {
    runnerId: text("runner_id")
      .notNull()
      .references(() => pgRunners.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    responseJson: text("response_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.runnerId, table.requestId] })],
);

export const pgAttemptCompletionReceipts = pgTable("attempt_completion_receipts", {
  attemptId: text("attempt_id")
    .primaryKey()
    .references(() => pgRunAttempts.id, { onDelete: "cascade" }),
  completionId: text("completion_id").notNull().unique(),
  resultDigest: text("result_digest").notNull(),
  responseJson: text("response_json").notNull(),
  acceptedAt: text("accepted_at").notNull(),
});

export const pgAttemptStateEvents = pgTable(
  "attempt_state_events",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => pgRunAttempts.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    reasonCode: text("reason_code"),
    actorType: text("actor_type", { enum: ["user", "runner", "system"] }).notNull(),
    actorId: text("actor_id"),
    detailsJson: text("details_json").notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (table) => [
    index("attempt_state_events_attempt_idx").on(table.attemptId, table.recordedAt, table.id),
  ],
);

export const pgAttemptLogWatermarks = pgTable(
  "attempt_log_watermarks",
  {
    attemptId: text("attempt_id")
      .notNull()
      .references(() => pgRunAttempts.id, { onDelete: "cascade" }),
    stream: text("stream", { enum: ["stdout", "stderr", "agent"] }).notNull(),
    acknowledgedSequence: bigint("acknowledged_sequence", { mode: "number" }).notNull().default(-1),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.attemptId, table.stream] })],
);

export const pgAttemptArtifacts = pgTable(
  "attempt_artifacts",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => pgRunAttempts.id, { onDelete: "cascade" }),
    relativePath: text("relative_path").notNull(),
    objectKey: text("object_key"),
    mediaType: text("media_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    required: boolean("required").notNull().default(false),
    status: text("status", { enum: ["declared", "uploaded", "rejected"] }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("attempt_artifacts_attempt_path_uq").on(table.attemptId, table.relativePath),
  ],
);

export const pgCaseSourceComparisons = pgTable(
  "case_source_comparisons",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    currentSourceId: text("current_source_id"),
    candidateSourceId: text("candidate_source_id").notNull(),
    addedJson: text("added_json").notNull(),
    changedJson: text("changed_json").notNull(),
    removedJson: text("removed_json").notNull(),
    conflictsJson: text("conflicts_json").notNull(),
    truncated: boolean("truncated").notNull().default(false),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("case_source_comparisons_project_created_idx").on(table.projectId, table.createdAt),
  ],
);

export const pgCaseSuiteVersions = pgTable(
  "case_suite_versions",
  {
    id: text("id").primaryKey(),
    suiteId: text("suite_id").notNull(),
    version: integer("version").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    changeReason: text("change_reason").notNull(),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("case_suite_versions_suite_version_uq").on(table.suiteId, table.version)],
);

export const pgCaseSuiteSchedules = pgTable("case_suite_schedules", {
  id: text("id").primaryKey(),
  suiteId: text("suite_id").notNull(),
  projectId: text("project_id").notNull(),
  cronExpression: text("cron_expression").notNull(),
  timeZone: text("time_zone").notNull(),
  missedRunPolicy: text("missed_run_policy", { enum: ["skip", "run-once"] }).notNull(),
  enabled: boolean("enabled").notNull().default(true),
  nextTriggerAt: text("next_trigger_at").notNull(),
  lastTriggerAt: text("last_trigger_at"),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const pgLdapSyncJobs = pgTable(
  "ldap_sync_jobs",
  {
    id: text("id").primaryKey(),
    status: text("status", {
      enum: ["queued", "running", "succeeded", "failed", "cancelled"],
    }).notNull(),
    triggerKind: text("trigger_kind", { enum: ["manual", "scheduled"] }).notNull(),
    checkpointJson: text("checkpoint_json").notNull().default("{}"),
    processedUsers: integer("processed_users").notNull().default(0),
    disabledUsers: integer("disabled_users").notNull().default(0),
    errorCode: text("error_code"),
    errorSummary: text("error_summary"),
    requestedBy: text("requested_by"),
    scheduledAt: text("scheduled_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("ldap_sync_jobs_status_scheduled_idx").on(table.status, table.scheduledAt)],
);

export const pgServiceAccounts = pgTable(
  "service_accounts",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    description: text("description").notNull().default(""),
    status: text("status", { enum: ["active", "disabled"] }).notNull(),
    systemPermissionsJson: text("system_permissions_json").notNull().default("[]"),
    projectPermissionsJson: text("project_permissions_json").notNull().default("{}"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    revision: integer("revision").notNull().default(1),
  },
  (table) => [uniqueIndex("service_accounts_normalized_name_uq").on(table.normalizedName)],
);

export const pgApiTokens = pgTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    serviceAccountId: text("service_account_id").notNull(),
    name: text("name").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull(),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
    replacedByTokenId: text("replaced_by_token_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("api_tokens_hash_uq").on(table.tokenHash),
    index("api_tokens_account_active_idx").on(
      table.serviceAccountId,
      table.revokedAt,
      table.expiresAt,
    ),
  ],
);

export const pgNotifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    projectId: text("project_id"),
    kind: text("kind").notNull(),
    severity: text("severity", { enum: ["info", "warning", "critical"] }).notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    readAt: text("read_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("notifications_user_unread_idx").on(table.userId, table.readAt, table.createdAt),
  ],
);

export const pgRetentionPolicies = pgTable("retention_policies", {
  category: text("category").primaryKey(),
  retentionDays: integer("retention_days").notNull(),
  minimumDays: integer("minimum_days").notNull(),
  maximumDays: integer("maximum_days").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: text("updated_at").notNull(),
  revision: integer("revision").notNull().default(1),
});

export const pgCleanupJobs = pgTable(
  "cleanup_jobs",
  {
    id: text("id").primaryKey(),
    category: text("category").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    objectKey: text("object_key"),
    status: text("status", {
      enum: ["pending", "leased", "succeeded", "failed", "dead_letter"],
    }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: text("available_at").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    errorSummary: text("error_summary"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("cleanup_jobs_resource_uq").on(
      table.category,
      table.resourceType,
      table.resourceId,
    ),
    index("cleanup_jobs_claim_idx").on(table.status, table.availableAt, table.leaseExpiresAt),
  ],
);

export const pgAnalyticsFacts = pgTable(
  "analytics_facts",
  {
    attemptId: text("attempt_id").primaryKey(),
    projectId: text("project_id").notNull(),
    batchId: text("batch_id").notNull(),
    runId: text("run_id").notNull(),
    suiteId: text("suite_id").notNull(),
    caseDefinitionId: text("case_definition_id").notNull(),
    caseVersion: integer("case_version").notNull(),
    runnerId: text("runner_id").notNull(),
    environmentVersionId: text("environment_version_id"),
    outcome: text("outcome").notNull(),
    resultCode: text("result_code"),
    failureSignature: text("failure_signature"),
    durationMs: bigint("duration_ms", { mode: "number" }),
    passed: integer("passed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    completedAt: text("completed_at").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
  },
  (table) => [
    index("analytics_facts_dimensions_idx").on(
      table.projectId,
      table.completedAt,
      table.suiteId,
      table.caseDefinitionId,
      table.runnerId,
    ),
  ],
);

export const pgSystemSettings = pgTable("system_settings", {
  settingKey: text("setting_key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: text("updated_at").notNull(),
  revision: integer("revision").notNull().default(1),
});

export const pgCaseImportJobs = pgTable(
  "case_import_jobs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    projectVersionId: text("project_version_id").references(() => pgProjectVersions.id, {
      onDelete: "restrict",
    }),
    testStageId: text("test_stage_id").references(() => pgTestStages.id, {
      onDelete: "restrict",
    }),
    idempotencyKey: text("idempotency_key").notNull(),
    fileName: text("file_name").notNull(),
    objectKey: text("object_key").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    status: text("status", {
      enum: ["queued", "running", "cancel_requested", "cancelled", "succeeded", "failed"],
    }).notNull(),
    progressPercent: integer("progress_percent").notNull().default(0),
    resultJson: text("result_json"),
    errorCode: text("error_code"),
    errorSummary: text("error_summary"),
    requestedBy: text("requested_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (table) => [
    uniqueIndex("case_import_jobs_legacy_idempotency_uq")
      .on(table.projectId, table.idempotencyKey)
      .where(sql`${table.projectVersionId} IS NULL AND ${table.testStageId} IS NULL`),
    uniqueIndex("case_import_jobs_stage_idempotency_uq")
      .on(table.projectId, table.projectVersionId, table.testStageId, table.idempotencyKey)
      .where(sql`${table.projectVersionId} IS NOT NULL AND ${table.testStageId} IS NOT NULL`),
    index("case_import_jobs_status_idx").on(table.status, table.updatedAt),
  ],
);

export const pgDdtImportJobs = pgTable(
  "ddt_import_jobs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    projectVersionId: text("project_version_id").notNull(),
    testStageId: text("test_stage_id").notNull(),
    status: text("status", {
      enum: [
        "previewed",
        "queued",
        "running",
        "cancel_requested",
        "succeeded",
        "partially_succeeded",
        "failed",
        "cancelled",
      ],
    }).notNull(),
    conflictStrategy: text("conflict_strategy", { enum: ["overwrite", "skip", "error"] }),
    uploadsJson: text("uploads_json").notNull().default("[]"),
    progressPercent: integer("progress_percent").notNull().default(0),
    totalFiles: integer("total_files").notNull().default(0),
    validFiles: integer("valid_files").notNull().default(0),
    totalRows: integer("total_rows").notNull().default(0),
    insertedCount: integer("inserted_count").notNull().default(0),
    updatedCount: integer("updated_count").notNull().default(0),
    unchangedCount: integer("unchanged_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    failedFiles: integer("failed_files").notNull().default(0),
    errorCode: text("error_code"),
    errorSummary: text("error_summary"),
    requestedBy: text("requested_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (table) => [
    index("ddt_import_jobs_scope_created_idx").on(
      table.projectId,
      table.projectVersionId,
      table.testStageId,
      table.createdAt,
      table.id,
    ),
    index("ddt_import_jobs_status_idx").on(table.status, table.updatedAt),
  ],
);

export const pgDdtImportFiles = pgTable(
  "ddt_import_files",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull(),
    uploadId: text("upload_id").notNull(),
    fileName: text("file_name").notNull(),
    archiveEntryName: text("archive_entry_name"),
    status: text("status", {
      enum: ["valid", "excluded", "pending", "importing", "succeeded", "failed", "cancelled"],
    }).notNull(),
    rowCount: integer("row_count").notNull().default(0),
    insertedCount: integer("inserted_count").notNull().default(0),
    updatedCount: integer("updated_count").notNull().default(0),
    unchangedCount: integer("unchanged_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    errorSummary: text("error_summary"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("ddt_import_files_job_idx").on(table.jobId, table.createdAt, table.id)],
);

export const pgDdtCases = pgTable(
  "ddt_cases",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    projectVersionId: text("project_version_id").notNull(),
    testStageId: text("test_stage_id").notNull(),
    caseId: text("case_id").notNull(),
    caseIdNormalized: text("case_id_normalized").notNull(),
    srNum: text("sr_num").notNull(),
    srNumNormalized: text("sr_num_normalized").notNull(),
    caseKind: text("case_kind", { enum: ["standard", "journey"] }).notNull(),
    dataJson: text("data_json").notNull(),
    executionCaseDefinitionId: text("execution_case_definition_id").references(
      () => pgCaseDefinitions.id,
      { onDelete: "set null" },
    ),
    sourceFileId: text("source_file_id"),
    sourceName: text("source_name").notNull().default(""),
    revision: integer("revision").notNull().default(1),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("ddt_cases_scope_case_id_uq").on(
      table.projectId,
      table.projectVersionId,
      table.testStageId,
      table.caseIdNormalized,
    ),
    index("ddt_cases_scope_sr_num_idx").on(
      table.projectId,
      table.projectVersionId,
      table.testStageId,
      table.srNumNormalized,
      table.caseIdNormalized,
    ),
    index("ddt_cases_scope_updated_idx").on(
      table.projectId,
      table.projectVersionId,
      table.testStageId,
      table.updatedAt,
      table.id,
    ),
  ],
);

export const pgCaseSuiteDdtItems = pgTable(
  "case_suite_ddt_items",
  {
    id: text("id").primaryKey(),
    suiteId: text("suite_id")
      .notNull()
      .references(() => pgCaseSuites.id, { onDelete: "cascade" }),
    ddtCaseId: text("ddt_case_id")
      .notNull()
      .references(() => pgDdtCases.id, { onDelete: "restrict" }),
    addedAt: text("added_at").notNull(),
  },
  (table) => [
    uniqueIndex("case_suite_ddt_items_suite_case_uq").on(table.suiteId, table.ddtCaseId),
    index("case_suite_ddt_items_suite_idx").on(table.suiteId),
  ],
);

export const pgDdtCaseHistory = pgTable(
  "ddt_case_history",
  {
    id: text("id").primaryKey(),
    ddtCaseId: text("ddt_case_id").notNull(),
    caseId: text("case_id").notNull(),
    changeType: text("change_type", {
      enum: ["edit", "bulk_edit", "import_overwrite", "restore"],
    }).notNull(),
    actorId: text("actor_id"),
    sourceName: text("source_name").notNull().default(""),
    beforeJson: text("before_json").notNull(),
    afterJson: text("after_json").notNull(),
    changesJson: text("changes_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("ddt_case_history_case_idx").on(table.ddtCaseId, table.createdAt, table.id)],
);

export const pgDdtDeletedCases = pgTable(
  "ddt_deleted_cases",
  {
    id: text("id").primaryKey(),
    ddtCaseId: text("ddt_case_id").notNull(),
    projectId: text("project_id").notNull(),
    projectVersionId: text("project_version_id").notNull(),
    testStageId: text("test_stage_id").notNull(),
    caseId: text("case_id").notNull(),
    caseIdNormalized: text("case_id_normalized").notNull(),
    srNum: text("sr_num").notNull(),
    srNumNormalized: text("sr_num_normalized").notNull(),
    caseKind: text("case_kind", { enum: ["standard", "journey"] }).notNull(),
    dataJson: text("data_json").notNull(),
    executionCaseDefinitionId: text("execution_case_definition_id").references(
      () => pgCaseDefinitions.id,
      { onDelete: "set null" },
    ),
    sourceFileId: text("source_file_id"),
    sourceName: text("source_name").notNull().default(""),
    caseCreatedAt: text("case_created_at").notNull(),
    caseUpdatedAt: text("case_updated_at").notNull(),
    deletedBy: text("deleted_by"),
    deletedAt: text("deleted_at").notNull(),
  },
  (table) => [
    index("ddt_deleted_cases_scope_idx").on(
      table.projectId,
      table.projectVersionId,
      table.testStageId,
      table.deletedAt,
      table.id,
    ),
    index("ddt_deleted_cases_case_id_idx").on(
      table.projectId,
      table.projectVersionId,
      table.testStageId,
      table.caseIdNormalized,
    ),
  ],
);

export const pgDdtCaseTemplates = pgTable(
  "ddt_case_templates",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    projectVersionId: text("project_version_id").notNull(),
    testStageId: text("test_stage_id").notNull(),
    srNum: text("sr_num").notNull(),
    srNumNormalized: text("sr_num_normalized").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    rulesJson: text("rules_json").notNull().default("[]"),
    revision: integer("revision").notNull().default(1),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("ddt_case_templates_scope_sr_num_uq").on(
      table.projectId,
      table.projectVersionId,
      table.testStageId,
      table.srNumNormalized,
    ),
    index("ddt_case_templates_scope_updated_idx").on(
      table.projectId,
      table.projectVersionId,
      table.testStageId,
      table.updatedAt,
      table.id,
    ),
  ],
);

export const pgDdtImportCaseIds = pgTable(
  "ddt_import_case_ids",
  {
    jobId: text("job_id").notNull(),
    caseId: text("case_id").notNull(),
    caseIdNormalized: text("case_id_normalized").notNull(),
    outcome: text("outcome", { enum: ["inserted", "updated", "unchanged", "skipped"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.caseIdNormalized] }),
    index("ddt_import_case_ids_order_idx").on(table.jobId, table.caseIdNormalized),
  ],
);

export const postgresSchema = {
  projects: pgProjects,
  projectVersions: pgProjectVersions,
  testStages: pgTestStages,
  projectRuntimeAssets: pgProjectRuntimeAssets,
  projectAdapterConfigurations: pgProjectAdapterConfigurations,
  projectVersionRuntimeAssets: pgProjectVersionRuntimeAssets,
  users: pgUsers,
  externalIdentities: pgExternalIdentities,
  userSessions: pgUserSessions,
  roles: pgRoles,
  userSystemRoles: pgUserSystemRoles,
  projectRoleBindings: pgProjectRoleBindings,
  authBootstrapUses: pgAuthBootstrapUses,
  ldapConfigurations: pgLdapConfigurations,
  ldapGroupMappings: pgLdapGroupMappings,
  auditEvents: pgAuditEvents,
  caseSources: pgCaseSources,
  caseDefinitions: pgCaseDefinitions,
  caseVersions: pgCaseVersions,
  testMethods: pgTestMethods,
  caseSuites: pgCaseSuites,
  caseSuiteRoundRecoveryCredentials: pgCaseSuiteRoundRecoveryCredentials,
  caseSuiteItems: pgCaseSuiteItems,
  caseSuiteDdtItems: pgCaseSuiteDdtItems,
  runners: pgRunners,
  runnerBootstrapUses: pgRunnerBootstrapUses,
  runnerInstallationProfiles: pgRunnerInstallationProfiles,
  runnerGroups: pgRunnerGroups,
  runnerGroupMembers: pgRunnerGroupMembers,
  executionEnvironments: pgExecutionEnvironments,
  executionEnvironmentVersions: pgExecutionEnvironmentVersions,
  executionSecrets: pgExecutionSecrets,
  executionSecretVersions: pgExecutionSecretVersions,
  runBatches: pgRunBatches,
  runBatchRetryConcurrencyStates: pgRunBatchRetryConcurrencyStates,
  runBatchRoundConcurrencies: pgRunBatchRoundConcurrencies,
  runBatchStatusEvents: pgRunBatchStatusEvents,
  webhookConfigurations: pgWebhookConfigurations,
  caseSuiteWebhookBindings: pgCaseSuiteWebhookBindings,
  webhookDeliveries: pgWebhookDeliveries,
  runBatchRunners: pgRunBatchRunners,
  executionRuns: pgExecutionRuns,
  runAttempts: pgRunAttempts,
  assignments: pgAssignments,
  assignmentLeases: pgAssignmentLeases,
  assignmentClaimRequests: pgAssignmentClaimRequests,
  attemptCompletionReceipts: pgAttemptCompletionReceipts,
  attemptStateEvents: pgAttemptStateEvents,
  attemptLogWatermarks: pgAttemptLogWatermarks,
  attemptLogShares: pgAttemptLogShares,
  attemptArtifacts: pgAttemptArtifacts,
  caseSourceComparisons: pgCaseSourceComparisons,
  caseSuiteVersions: pgCaseSuiteVersions,
  caseSuiteSchedules: pgCaseSuiteSchedules,
  ldapSyncJobs: pgLdapSyncJobs,
  serviceAccounts: pgServiceAccounts,
  apiTokens: pgApiTokens,
  notifications: pgNotifications,
  retentionPolicies: pgRetentionPolicies,
  cleanupJobs: pgCleanupJobs,
  analyticsFacts: pgAnalyticsFacts,
  systemSettings: pgSystemSettings,
  caseImportJobs: pgCaseImportJobs,
  ddtImportJobs: pgDdtImportJobs,
  ddtImportFiles: pgDdtImportFiles,
  ddtCases: pgDdtCases,
  ddtCaseHistory: pgDdtCaseHistory,
  ddtDeletedCases: pgDdtDeletedCases,
  ddtCaseTemplates: pgDdtCaseTemplates,
  ddtImportCaseIds: pgDdtImportCaseIds,
};
