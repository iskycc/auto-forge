import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("projects_slug_uq").on(table.slug),
    uniqueIndex("projects_one_default_uq")
      .on(table.isDefault)
      .where(sql`${table.isDefault} = 1`),
  ],
);

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    normalizedUsername: text("normalized_username").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    source: text("source", { enum: ["local", "ldap"] }).notNull(),
    status: text("status", { enum: ["active", "disabled"] }).notNull(),
    passwordHash: text("password_hash"),
    passwordUpdatedAt: text("password_updated_at"),
    forcePasswordChange: integer("force_password_change", { mode: "boolean" })
      .notNull()
      .default(false),
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

export const externalIdentities = sqliteTable(
  "external_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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

export const userSessions = sqliteTable(
  "user_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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

export const roles = sqliteTable(
  "roles",
  {
    id: text("id").primaryKey(),
    key: text("role_key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    scope: text("scope", { enum: ["system", "project"] }).notNull(),
    builtIn: integer("built_in", { mode: "boolean" }).notNull().default(false),
    permissionsJson: text("permissions_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("roles_key_uq").on(table.key)],
);

export const userSystemRoles = sqliteTable(
  "user_system_roles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    source: text("source", { enum: ["manual", "ldap"] })
      .notNull()
      .default("manual"),
    assignedAt: text("assigned_at").notNull(),
    assignedBy: text("assigned_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.roleId] })],
);

export const projectRoleBindings = sqliteTable(
  "project_role_bindings",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    source: text("source", { enum: ["manual", "ldap"] })
      .notNull()
      .default("manual"),
    assignedAt: text("assigned_at").notNull(),
    assignedBy: text("assigned_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.projectId, table.roleId] }),
    index("project_role_bindings_project_idx").on(table.projectId, table.userId),
  ],
);

export const authBootstrapUses = sqliteTable("auth_bootstrap_uses", {
  tokenHash: text("token_hash").primaryKey(),
  usedAt: text("used_at").notNull(),
});

export const ldapConfigurations = sqliteTable("ldap_configurations", {
  id: text("id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  urlsJson: text("urls_json").notNull(),
  tlsMode: text("tls_mode", { enum: ["ldaps", "starttls"] }).notNull(),
  caPem: text("ca_pem"),
  connectTimeoutMs: integer("connect_timeout_ms").notNull(),
  operationTimeoutMs: integer("operation_timeout_ms").notNull(),
  pageSize: integer("page_size").notNull(),
  maximumUsers: integer("maximum_users").notNull(),
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
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  version: integer("version").notNull().default(1),
});

export const ldapGroupMappings = sqliteTable(
  "ldap_group_mappings",
  {
    id: text("id").primaryKey(),
    groupDn: text("group_dn").notNull(),
    normalizedGroupDn: text("normalized_group_dn").notNull(),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    priority: integer("priority").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("ldap_group_mappings_group_idx").on(table.normalizedGroupDn)],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    actorType: text("actor_type", { enum: ["user", "runner", "system"] }).notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
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
    draining: integer("draining", { mode: "boolean" }).notNull().default(false),
    os: text("os").notNull(),
    architecture: text("architecture").notNull(),
    agentVersion: text("agent_version").notNull(),
    protocolVersion: integer("protocol_version").notNull(),
    labelsJson: text("labels_json").notNull(),
    capabilitiesJson: text("capabilities_json").notNull().default("[]"),
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
    projectId: text("project_id").notNull().default("00000000-0000-7000-8000-000000000001"),
    priority: integer("priority").notNull().default(0),
    cancelRequestedAt: text("cancel_requested_at"),
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
    version: integer("version").notNull().default(1),
    terminalOutcome: text("terminal_outcome", {
      enum: ["succeeded", "failed", "timed_out", "cancelled"],
    }),
    cancelRequestedAt: text("cancel_requested_at"),
    queueDeadlineAt: text("queue_deadline_at"),
    executionTimeoutMs: integer("execution_timeout_ms").notNull().default(3_600_000),
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
    version: integer("version").notNull().default(1),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    outcome: text("outcome", { enum: ["succeeded", "failed", "timed_out", "cancelled"] }),
    resultCode: text("result_code"),
    resultSummary: text("result_summary"),
    completionDigest: text("completion_digest"),
  },
  (table) => [
    uniqueIndex("run_attempts_run_number_uq").on(table.executionRunId, table.attemptNumber),
    index("run_attempts_runner_status_idx").on(table.runnerId, table.status),
  ],
);

export const assignments = sqliteTable(
  "assignments",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => runAttempts.id, { onDelete: "cascade" }),
    executionRunId: text("execution_run_id")
      .notNull()
      .references(() => executionRuns.id, { onDelete: "cascade" }),
    batchId: text("batch_id")
      .notNull()
      .references(() => runBatches.id, { onDelete: "cascade" }),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runners.id, { onDelete: "restrict" }),
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

export const assignmentLeases = sqliteTable(
  "assignment_leases",
  {
    id: text("id").primaryKey(),
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => assignments.id, { onDelete: "cascade" }),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runners.id, { onDelete: "restrict" }),
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

export const assignmentClaimRequests = sqliteTable(
  "assignment_claim_requests",
  {
    runnerId: text("runner_id")
      .notNull()
      .references(() => runners.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    responseJson: text("response_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.runnerId, table.requestId] })],
);

export const attemptCompletionReceipts = sqliteTable("attempt_completion_receipts", {
  attemptId: text("attempt_id")
    .primaryKey()
    .references(() => runAttempts.id, { onDelete: "cascade" }),
  completionId: text("completion_id").notNull(),
  resultDigest: text("result_digest").notNull(),
  responseJson: text("response_json").notNull(),
  acceptedAt: text("accepted_at").notNull(),
});

export const attemptStateEvents = sqliteTable(
  "attempt_state_events",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => runAttempts.id, { onDelete: "cascade" }),
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

export const attemptLogWatermarks = sqliteTable(
  "attempt_log_watermarks",
  {
    attemptId: text("attempt_id")
      .notNull()
      .references(() => runAttempts.id, { onDelete: "cascade" }),
    stream: text("stream", { enum: ["stdout", "stderr", "agent"] }).notNull(),
    acknowledgedSequence: integer("acknowledged_sequence").notNull().default(-1),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.attemptId, table.stream] })],
);

export const attemptArtifacts = sqliteTable(
  "attempt_artifacts",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => runAttempts.id, { onDelete: "cascade" }),
    relativePath: text("relative_path").notNull(),
    objectKey: text("object_key"),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    required: integer("required", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: ["declared", "uploaded", "rejected"] }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("attempt_artifacts_attempt_path_uq").on(table.attemptId, table.relativePath),
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
  projects,
  users,
  externalIdentities,
  userSessions,
  roles,
  userSystemRoles,
  projectRoleBindings,
  authBootstrapUses,
  ldapConfigurations,
  ldapGroupMappings,
  auditEvents,
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
  assignments,
  assignmentLeases,
  assignmentClaimRequests,
  attemptCompletionReceipts,
  attemptStateEvents,
  attemptLogWatermarks,
  attemptArtifacts,
};
