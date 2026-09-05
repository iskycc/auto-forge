import { jarInspectionSchema } from "./testng";
import { z } from "zod";
import { analyticsBatchComparisonSchema, analyticsFilterSchema } from "./operations";

const identifier = z.string().min(1).max(160);
const scope = z.object({ projectId: identifier, projectVersionId: identifier });
const analysisScope = scope.partial({ projectVersionId: true });
const page = analysisScope.extend({
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(100),
});
const batch = analysisScope.extend({ batchId: identifier });

/** Only explicitly registered, read-only projections may be executed by the background worker. */
export const executionCasePageFilterSchema = z.object({
  scope: z.union([z.literal("all"), z.literal("summary"), z.number().int().positive()]),
  status: z
    .enum(["assigned", "running", "succeeded", "failed", "timed_out", "cancelled", "pending"])
    .optional(),
  query: z.string().max(240).optional(),
  sort: z.enum(["none", "name", "status", "runner", "duration"]),
  direction: z.enum(["asc", "desc"]),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(500),
});
export const readModelQuerySchema = z.discriminatedUnion("kind", [
  analysisScope.extend({
    kind: z.literal("execution_case_page"),
    batchId: identifier,
    terminalVersion: z.number().int().nonnegative().optional(),
    filter: executionCasePageFilterSchema,
  }),
  z.object({
    kind: z.literal("batch_counters"),
    projectId: identifier,
    batches: z
      .array(
        z.object({
          id: identifier,
          projectId: identifier,
          terminalVersion: z.number().int().nonnegative().optional(),
        }),
      )
      .min(1)
      .max(200),
  }),
  z.object({ kind: z.literal("source_preview"), projectId: identifier, sourceId: identifier }),
  z.object({
    kind: z.literal("public_statistics"),
    projectId: identifier,
    refreshSeconds: z.number().int().min(1).max(3600),
  }),
  z.object({
    kind: z.literal("analytics_scope"),
    projectId: identifier,
    projectIds: z.array(identifier).optional(),
    filter: analyticsFilterSchema,
  }),
  analysisScope.extend({ kind: z.literal("suite_directory"), suiteId: identifier }),
  analysisScope.extend({
    kind: z.literal("execution_overview"),
    batchId: identifier,
    terminalVersion: z.number().int().nonnegative().optional(),
  }),
  scope.extend({ kind: z.literal("dashboard"), timeZone: z.string().min(1).max(120) }),
  scope.extend({ kind: z.literal("analytics"), filter: analyticsFilterSchema }),
  analysisScope.extend({
    kind: z.literal("batch_comparison"),
    rightProjectId: identifier.optional(),
    leftBatchId: identifier,
    rightBatchId: identifier,
  }),
  scope.extend({ kind: z.literal("suite_activity"), suiteIds: z.array(identifier).max(200) }),
  scope.extend({ kind: z.literal("case_directory"), testStageId: identifier }),
  scope.extend({ kind: z.literal("ddt_dashboard"), testStageId: identifier }),
  page.extend({
    kind: z.literal("analysis_batches"),
    view: z.enum(["started", "available"]).default("started"),
  }),
  batch.extend({ kind: z.literal("analysis_batch") }),
  batch.extend({
    kind: z.literal("analysis_statistics"),
    cursor: z.string().max(1024).optional(),
    limit: z.number().int().min(1).max(100),
  }),
]);

export type ReadModelQuery = z.infer<typeof readModelQuerySchema>;
export const readModelStatusSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  generation: z.string().nullable(),
  generatedAt: z.string().datetime().nullable(),
  state: z.enum(["pending", "ready", "stale", "failed"]),
});
export type ReadModelStatus = z.infer<typeof readModelStatusSchema>;

export const caseDirectoryManifestSchema = z.object({
  caseCount: z.number().int().nonnegative(),
  partCount: z.number().int().nonnegative(),
});
export type CaseDirectoryManifest = z.infer<typeof caseDirectoryManifestSchema>;

const directoryCaseSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectVersionId: z.string().optional(),
  testStageId: z.string().optional(),
  directoryPath: z.string(),
  sourceId: z.string(),
  className: z.string(),
  packageName: z.string(),
  displayName: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  enabled: z.boolean(),
  archived: z.boolean(),
  groups: z.array(z.string()),
  parameters: z.record(z.string(), z.string()),
  currentVersion: z.number().int(),
  revision: z.number().int(),
  updatedBy: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  methods: z.array(
    z.object({
      id: z.string(),
      caseDefinitionId: z.string(),
      methodName: z.string(),
      descriptor: z.string(),
      enabled: z.boolean(),
      groups: z.array(z.string()),
      description: z.string().optional(),
      dataProvider: z.string().optional(),
      dependsOnMethods: z.array(z.string()),
      dependsOnGroups: z.array(z.string()),
      priority: z.number().optional(),
      createdAt: z.string(),
    }),
  ),
});

export const caseDirectoryPartSchema = z.object({
  items: z.array(directoryCaseSchema).max(250),
  outcomes: z
    .array(
      z.object({
        caseDefinitionId: z.string(),
        outcome: z.enum(["succeeded", "failed", "timed_out", "cancelled"]),
        resultCode: z.string().optional(),
        executedAt: z.string(),
      }),
    )
    .max(250),
});
export type CaseDirectoryPart = z.infer<typeof caseDirectoryPartSchema>;

export const ddtDashboardSnapshotSchema = z.object({
  caseCount: z.number().int().nonnegative(),
  groupCount: z.number().int().nonnegative(),
  sourceCount: z.number().int().nonnegative(),
  journeyCount: z.number().int().nonnegative(),
  importedToday: z.number().int().nonnegative(),
  updatedToday: z.number().int().nonnegative(),
  groups: z.array(z.object({ srNum: z.string(), count: z.number().int().nonnegative() })),
  timeline: z.array(z.object({ date: z.string(), count: z.number().int().nonnegative() })),
});

export const batchComparisonPartSchema = analyticsBatchComparisonSchema.shape.cases.max(250);
export const batchComparisonManifestSchema = analyticsBatchComparisonSchema
  .omit({ cases: true })
  .extend({
    partCount: z.number().int().nonnegative(),
    changes: z.object({
      outcome: z.number().int().nonnegative(),
      version: z.number().int().nonnegative(),
      slower: z.number().int().nonnegative(),
      faster: z.number().int().nonnegative(),
    }),
  });
export type BatchComparisonManifest = z.infer<typeof batchComparisonManifestSchema>;

export const suiteDirectoryPartSchema = z.object({
  items: z
    .array(
      z.object({
        id: identifier,
        suiteId: identifier,
        addedAt: z.string(),
        caseDefinition: z.object({
          id: identifier,
          displayName: z.string(),
          className: z.string(),
          packageName: z.string(),
          methodCount: z.number().int().nonnegative(),
        }),
      }),
    )
    .max(250),
  ddtItems: z
    .array(
      z.object({
        id: identifier,
        suiteId: identifier,
        addedAt: z.string(),
        ddtCase: z.object({
          id: identifier,
          caseId: z.string(),
          srNum: z.string(),
          kind: z.enum(["standard", "journey"]),
          executionClass: z.object({ className: z.string() }).optional(),
        }),
      }),
    )
    .max(250),
});
export type SuiteDirectoryPart = z.infer<typeof suiteDirectoryPartSchema>;
export const suiteDirectoryManifestSchema = caseDirectoryManifestSchema.extend({
  revision: z.number().int(),
});
export type SuiteDirectoryManifest = z.infer<typeof suiteDirectoryManifestSchema>;

export const sourcePreviewSchema = jarInspectionSchema.extend({
  classes: jarInspectionSchema.shape.classes.max(100),
});
