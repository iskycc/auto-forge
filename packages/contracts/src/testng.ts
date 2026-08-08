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
});

export const testNgClassCandidateSchema = z.object({
  className: z.string().min(1),
  packageName: z.string(),
  simpleName: z.string().min(1),
  enabled: z.boolean(),
  classLevelTest: z.boolean(),
  groups: z.array(z.string()),
  methods: z.array(testNgMethodCandidateSchema),
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
  testClassCount: z.number().int().nonnegative(),
  testMethodCount: z.number().int().nonnegative(),
  hasRootTestNgXml: z.boolean(),
  discoveryMode: z.literal("bytecode-annotations"),
  classes: z.array(testNgClassCandidateSchema),
  warnings: z.array(jarInspectionWarningSchema),
});

export const jarImportResultSchema = z.object({
  sourceId: z.string().min(1),
  duplicate: z.boolean(),
  importedClassCount: z.number().int().nonnegative(),
  importedMethodCount: z.number().int().nonnegative(),
  inspection: jarInspectionSchema,
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
export type TestNgClassCandidate = z.infer<typeof testNgClassCandidateSchema>;
export type JarInspectionWarning = z.infer<typeof jarInspectionWarningSchema>;
export type JarInspection = z.infer<typeof jarInspectionSchema>;
export type JarImportResult = z.infer<typeof jarImportResultSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
