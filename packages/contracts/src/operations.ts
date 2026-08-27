import { z } from "zod";
import { platformTimeZoneSchema } from "./platform";

const identifierSchema = z.string().trim().min(1).max(128);
const permissionSchema = z.string().trim().min(1).max(128);

export const serviceAccountSchema = z.object({
  id: identifierSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500),
  status: z.enum(["active", "disabled"]),
  systemPermissions: z.array(permissionSchema).max(128),
  projectPermissions: z.record(identifierSchema, z.array(permissionSchema).max(128)),
  createdBy: identifierSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  revision: z.number().int().positive(),
});

const serviceAccountNameSchema = z.string().trim().min(1).max(120);
const serviceAccountDescriptionSchema = z.string().trim().max(500);
const serviceAccountSystemPermissionsSchema = z.array(permissionSchema).max(128);
const serviceAccountProjectPermissionsSchema = z
  .record(identifierSchema, z.array(permissionSchema).max(128))
  .refine((value) => Object.keys(value).length <= 100, "项目权限最多覆盖 100 个项目。");

export const createServiceAccountInputSchema = z.object({
  name: serviceAccountNameSchema,
  description: serviceAccountDescriptionSchema.default(""),
  systemPermissions: serviceAccountSystemPermissionsSchema.default([]),
  projectPermissions: serviceAccountProjectPermissionsSchema.default({}),
});

// Do not derive this schema with partial(): Zod preserves defaults through
// partial fields, which would turn a status-only update into an instruction to
// clear every permission assignment.
export const updateServiceAccountInputSchema = z.object({
  name: serviceAccountNameSchema.optional(),
  description: serviceAccountDescriptionSchema.optional(),
  systemPermissions: serviceAccountSystemPermissionsSchema.optional(),
  projectPermissions: serviceAccountProjectPermissionsSchema.optional(),
  status: z.enum(["active", "disabled"]).optional(),
  expectedRevision: z.number().int().positive(),
});

export const apiTokenSchema = z.object({
  id: identifierSchema,
  serviceAccountId: identifierSchema,
  name: z.string().min(1).max(120),
  prefix: z.string().min(4).max(32),
  scopes: z.array(permissionSchema).max(128),
  expiresAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
});

export const issueApiTokenInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z.array(permissionSchema).min(1).max(128),
  expiresAt: z.string().datetime(),
});

export const issuedApiTokenSchema = apiTokenSchema.extend({
  token: z.string().min(32).max(512),
});

export const caseSuiteScheduleSchema = z.object({
  id: identifierSchema,
  suiteId: identifierSchema,
  projectId: identifierSchema,
  cronExpression: z.string().min(9).max(120),
  timeZone: z.string().min(1).max(100),
  missedRunPolicy: z.enum(["skip", "run-once"]),
  enabled: z.boolean(),
  nextTriggerAt: z.string().datetime(),
  lastTriggerAt: z.string().datetime().optional(),
  lastTriggerStatus: z.enum(["created", "skipped", "failed"]).optional(),
  lastBatchId: identifierSchema.optional(),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const upsertCaseSuiteScheduleInputSchema = z.object({
  cronExpression: z.string().trim().min(9).max(120),
  timeZone: z.string().trim().min(1).max(100),
  missedRunPolicy: z.enum(["skip", "run-once"]),
  enabled: z.boolean().default(true),
  expectedRevision: z.number().int().positive().optional(),
});

export const ldapSyncJobSchema = z.object({
  id: identifierSchema,
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  triggerKind: z.enum(["manual", "scheduled"]),
  checkpoint: z.record(z.string(), z.unknown()),
  processedUsers: z.number().int().nonnegative(),
  disabledUsers: z.number().int().nonnegative(),
  errorCode: z.string().max(128).optional(),
  errorSummary: z.string().max(1_000).optional(),
  requestedBy: identifierSchema.optional(),
  scheduledAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const notificationSchema = z.object({
  id: identifierSchema,
  userId: identifierSchema,
  projectId: identifierSchema.optional(),
  kind: z.string().min(1).max(80),
  severity: z.enum(["info", "warning", "critical"]),
  title: z.string().min(1).max(160),
  message: z.string().min(1).max(2_000),
  resourceType: z.string().max(80).optional(),
  resourceId: identifierSchema.optional(),
  readAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
});

export const notificationListQuerySchema = z.object({
  unreadOnly: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const retentionCategorySchema = z.enum([
  "execution",
  "log",
  "artifact",
  "source",
  "analytics",
  "audit",
  "session",
  "queue",
]);

export const retentionPolicySchema = z.object({
  category: retentionCategorySchema,
  retentionDays: z.number().int().positive(),
  minimumDays: z.number().int().positive(),
  maximumDays: z.number().int().positive(),
  updatedBy: identifierSchema.optional(),
  updatedAt: z.string().datetime(),
  revision: z.number().int().positive(),
});

export const updateRetentionPolicyInputSchema = z.object({
  retentionDays: z.number().int().positive(),
  expectedRevision: z.number().int().positive(),
});

export const retentionPreviewSchema = z.object({
  category: retentionCategorySchema,
  cutoffAt: z.string().datetime(),
  eligibleRecords: z.number().int().nonnegative(),
  eligibleBytes: z.number().int().nonnegative(),
});

export const executeRetentionInputSchema = z.object({
  confirmation: retentionCategorySchema,
  limit: z.number().int().min(1).max(1_000).default(1_000),
});

export const retentionExecutionResultSchema = z.object({
  category: retentionCategorySchema,
  deletedRecords: z.number().int().nonnegative(),
  queuedObjectDeletes: z.number().int().nonnegative(),
  completedObjectDeletes: z.number().int().nonnegative(),
});

export const analyticsFilterSchema = z.object({
  projectId: identifierSchema.optional(),
  projectVersionId: identifierSchema.optional(),
  testStageId: identifierSchema.optional(),
  suiteId: identifierSchema.optional(),
  caseDefinitionId: identifierSchema.optional(),
  runnerId: identifierSchema.optional(),
  outcome: z.enum(["succeeded", "failed", "cancelled", "timed_out"]).optional(),
  failureSignature: z.string().max(256).optional(),
  tag: z.string().trim().min(1).max(128).optional(),
  completedAfter: z.string().datetime().optional(),
  completedBefore: z.string().datetime().optional(),
  timeZone: platformTimeZoneSchema.optional(),
});

const analyticsBatchSnapshotSchema = z.object({
  batchId: identifierSchema,
  projectId: identifierSchema,
  suiteId: identifierSchema,
  suiteVersion: z.number().int().positive(),
  selectedRunnerIds: z.array(identifierSchema),
  caseCount: z.number().int().nonnegative(),
});

export const analyticsBatchComparisonSchema = z.object({
  left: analyticsBatchSnapshotSchema,
  right: analyticsBatchSnapshotSchema,
  commonCaseCount: z.number().int().nonnegative(),
  onlyLeftCaseCount: z.number().int().nonnegative(),
  onlyRightCaseCount: z.number().int().nonnegative(),
  comparableScope: z.boolean(),
  cases: z.array(
    z.object({
      caseDefinitionId: identifierSchema,
      displayName: z.string(),
      leftVersion: z.number().int().positive().optional(),
      rightVersion: z.number().int().positive().optional(),
      leftOutcome: z.string().optional(),
      rightOutcome: z.string().optional(),
      leftDurationMs: z.number().int().nonnegative().optional(),
      rightDurationMs: z.number().int().nonnegative().optional(),
      durationDeltaMs: z.number().int().optional(),
    }),
  ),
});

const analyticsDimensionSchema = z.object({
  id: identifierSchema,
  count: z.number().int().nonnegative(),
});

export const analyticsSummarySchema = z.object({
  sampleCount: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1),
  failureRate: z.number().min(0).max(1),
  skippedRate: z.number().min(0).max(1),
  durationP50Ms: z.number().int().nonnegative().optional(),
  durationP95Ms: z.number().int().nonnegative().optional(),
  generatedAt: z.string().datetime(),
  dimensions: z.object({
    projects: z.array(analyticsDimensionSchema),
    suites: z.array(analyticsDimensionSchema),
    runners: z.array(analyticsDimensionSchema),
    outcomes: z.array(analyticsDimensionSchema),
  }),
  trend: z.array(
    z.object({
      bucket: z.string().datetime(),
      total: z.number().int().nonnegative(),
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
    }),
  ),
  failures: z.array(
    z.object({
      signature: z.string(),
      description: z.string().min(1).max(4_096),
      resultCode: z.string().optional(),
      count: z.number().int().positive(),
      lastSeenAt: z.string().datetime(),
    }),
  ),
  flakyCases: z.array(
    z.object({
      caseDefinitionId: identifierSchema,
      displayName: z.string().min(1).max(240),
      samples: z.number().int().positive(),
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

export const analyticsExportFormatSchema = z.enum(["csv", "json"]);

export const analyticsExportJobSchema = z.object({
  id: identifierSchema,
  requestedBy: identifierSchema,
  filter: analyticsFilterSchema,
  format: analyticsExportFormatSchema,
  status: z.enum(["queued", "running", "succeeded", "failed", "cancel_requested", "cancelled"]),
  progressPercent: z.number().int().min(0).max(100),
  rowCount: z.number().int().nonnegative().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  fileName: z.string().min(1).max(240).optional(),
  errorCode: z.string().min(1).max(128).optional(),
  errorSummary: z.string().min(1).max(1_000).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
});

export const createAnalyticsExportInputSchema = z.object({
  filter: analyticsFilterSchema.default({}),
  format: analyticsExportFormatSchema.default("csv"),
});

export const globalSearchQuerySchema = z.object({
  query: z.string().trim().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const globalSearchResultSchema = z.object({
  items: z.array(
    z.object({
      kind: z.enum(["case", "suite", "batch", "run", "runner"]),
      id: identifierSchema,
      projectId: identifierSchema.optional(),
      title: z.string().min(1).max(240),
      subtitle: z.string().max(500),
      href: z.string().startsWith("/"),
    }),
  ),
});

export const systemDiagnosticSchema = z.object({
  generatedAt: z.string().datetime(),
  mode: z.enum(["lite", "full"]),
  version: z.string().min(1),
  configurationRevision: z.number().int().positive(),
  database: z.object({ ready: z.boolean(), detail: z.string() }),
  objectStore: z.object({ ready: z.boolean(), detail: z.string() }),
  queue: z.object({ ready: z.boolean(), detail: z.string() }),
  deadLetters: z.array(
    z.object({
      messageId: z.string().min(1).max(128),
      runId: z.string().min(1).max(128),
      kind: z.string().min(1).max(64),
      deliveryAttempts: z.number().int().nonnegative(),
      errorCode: z.string().min(1).max(128),
      errorSummary: z.string().max(2_048),
      failedAt: z.string().datetime(),
    }),
  ),
  cache: z.object({ ready: z.boolean(), detail: z.string() }),
  dataDisk: z.object({
    capacityBytes: z.number().int().positive(),
    availableBytes: z.number().int().nonnegative(),
    usedPercent: z.number().min(0).max(100),
    status: z.enum(["ok", "warning", "critical"]),
  }),
  recentErrors: z.array(
    z.object({ timestamp: z.string().datetime(), code: z.string(), summary: z.string() }),
  ),
});

export type ServiceAccount = z.infer<typeof serviceAccountSchema>;
export type CreateServiceAccountInput = z.infer<typeof createServiceAccountInputSchema>;
export type UpdateServiceAccountInput = z.infer<typeof updateServiceAccountInputSchema>;
export type ApiToken = z.infer<typeof apiTokenSchema>;
export type IssuedApiToken = z.infer<typeof issuedApiTokenSchema>;
export type IssueApiTokenInput = z.infer<typeof issueApiTokenInputSchema>;
export type CaseSuiteSchedule = z.infer<typeof caseSuiteScheduleSchema>;
export type UpsertCaseSuiteScheduleInput = z.infer<typeof upsertCaseSuiteScheduleInputSchema>;
export type LdapSyncJob = z.infer<typeof ldapSyncJobSchema>;
export type Notification = z.infer<typeof notificationSchema>;
export type RetentionCategory = z.infer<typeof retentionCategorySchema>;
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
export type RetentionPreview = z.infer<typeof retentionPreviewSchema>;
export type RetentionExecutionResult = z.infer<typeof retentionExecutionResultSchema>;
export type AnalyticsFilter = z.infer<typeof analyticsFilterSchema>;
export type AnalyticsSummary = z.infer<typeof analyticsSummarySchema>;
export type AnalyticsBatchComparison = z.infer<typeof analyticsBatchComparisonSchema>;
export type AnalyticsExportFormat = z.infer<typeof analyticsExportFormatSchema>;
export type AnalyticsExportJob = z.infer<typeof analyticsExportJobSchema>;
export type CreateAnalyticsExportInput = z.infer<typeof createAnalyticsExportInputSchema>;
export type GlobalSearchResult = z.infer<typeof globalSearchResultSchema>;
export type SystemDiagnostic = z.infer<typeof systemDiagnosticSchema>;
