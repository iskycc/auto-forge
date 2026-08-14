import { z } from "zod";

export const testNgMethodCandidateSchema = z.object({
  methodName: z.string().min(1),
  descriptor: z.string().min(1),
  enabled: z.boolean(),
  annotationSource: z.enum(["method", "class"]),
  groups: z.array(z.string()),
  description: z.string().optional(),
  dataProvider: z.string().optional(),
  dependsOnMethods: z.array(z.string()),
  dependsOnGroups: z.array(z.string()),
  priority: z.number().int().optional(),
  parameters: z.record(z.string().min(1).max(128), z.string().max(4_096)).optional(),
});

export const javaSourceReferenceSchema = z.object({
  entryPath: z.string().min(1).max(2_048),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive(),
});

export const testNgClassCandidateSchema = z.object({
  className: z.string().min(1),
  packageName: z.string(),
  simpleName: z.string().min(1),
  enabled: z.boolean(),
  classLevelTest: z.boolean(),
  groups: z.array(z.string()),
  parameters: z.record(z.string().min(1).max(128), z.string().max(4_096)).optional(),
  source: javaSourceReferenceSchema.optional(),
  methods: z.array(testNgMethodCandidateSchema),
});

export const testNgXmlSummarySchema = z.object({
  suiteName: z.string().min(1).max(512),
  testCount: z.number().int().nonnegative(),
  selectedClassCount: z.number().int().nonnegative(),
  parameters: z.record(z.string().min(1).max(128), z.string().max(4_096)),
});

export const testNgXmlSelectionSchema = z.object({
  suiteName: z.string().min(1).max(512),
  testName: z.string().min(1).max(512),
  parameters: z.record(z.string().min(1).max(128), z.string().max(4_096)),
  includedGroups: z.array(z.string().min(1).max(256)).max(256),
  excludedGroups: z.array(z.string().min(1).max(256)).max(256),
  includedPackages: z.array(z.string().min(1).max(1_024)).max(1_024),
  selectedClasses: z
    .array(
      z.object({
        className: z.string().min(1).max(1_024),
        includedMethods: z.array(z.string().min(1).max(256)).max(1_024),
        excludedMethods: z.array(z.string().min(1).max(256)).max(1_024),
      }),
    )
    .max(5_000),
});

export const jarInspectionWarningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  entry: z.string().optional(),
});

export const jarInspectionSchema = z.object({
  schemaVersion: z.literal(1),
  fileName: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  classFileCount: z.number().int().nonnegative(),
  javaSourceFileCount: z.number().int().nonnegative().optional(),
  testClassCount: z.number().int().nonnegative(),
  testMethodCount: z.number().int().nonnegative(),
  hasRootTestNgXml: z.boolean(),
  testNgXml: testNgXmlSummarySchema.optional(),
  discoveryMode: z.enum(["bytecode-annotations", "java-source-annotations"]),
  executable: z.boolean().optional(),
  classes: z.array(testNgClassCandidateSchema),
  testNgXmlSelections: z.array(testNgXmlSelectionSchema).max(200).optional(),
  targetJavaVersion: z.number().int().min(8).max(100).optional(),
  warnings: z.array(jarInspectionWarningSchema),
});

export const jarImportResultSchema = z.object({
  sourceId: z.string().min(1),
  duplicate: z.boolean(),
  importedClassCount: z.number().int().nonnegative(),
  importedMethodCount: z.number().int().nonnegative(),
  inspection: jarInspectionSchema,
});

export const jarImportJobSchema = z.object({
  id: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128),
  projectVersionId: z.string().min(1).max(128).optional(),
  testStageId: z.string().min(1).max(128).optional(),
  fileName: z.string().min(1).max(512),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  status: z.enum(["queued", "running", "cancel_requested", "cancelled", "succeeded", "failed"]),
  progressPercent: z.number().int().min(0).max(100),
  result: jarImportResultSchema.optional(),
  errorCode: z.string().min(1).max(128).optional(),
  errorSummary: z.string().min(1).max(1_000).optional(),
  requestedBy: z.string().min(1).max(128).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
});

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1),
    details: z.unknown().optional(),
  }),
});

export type TestNgMethodCandidate = z.infer<typeof testNgMethodCandidateSchema>;
export type JavaSourceReference = z.infer<typeof javaSourceReferenceSchema>;
export type TestNgClassCandidate = z.infer<typeof testNgClassCandidateSchema>;
export type TestNgXmlSummary = z.infer<typeof testNgXmlSummarySchema>;
export type TestNgXmlSelection = z.infer<typeof testNgXmlSelectionSchema>;
export type JarInspectionWarning = z.infer<typeof jarInspectionWarningSchema>;
export type JarInspection = z.infer<typeof jarInspectionSchema>;
export type JarImportResult = z.infer<typeof jarImportResultSchema>;
export type JarImportJob = z.infer<typeof jarImportJobSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
