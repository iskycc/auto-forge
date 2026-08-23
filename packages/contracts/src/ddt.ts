import { z } from "zod";

export const DDT_IMPORT_FILE_LIMIT = 200;
export const DDT_IMPORT_FILE_BYTES = 128 * 1_024 * 1_024;
export const DDT_IMPORT_TOTAL_BYTES = 512 * 1_024 * 1_024;
export const DDT_IMPORT_ARCHIVE_ENTRY_LIMIT = 10_000;
export const DDT_BULK_MUTATION_LIMIT = 5_000;

export const ddtCellValueSchema = z.union([
  z.string().max(1_000_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const ddtCaseStepSchema = z.record(z.string().min(1).max(256), ddtCellValueSchema);
export const ddtJourneyStepsSchema = z.record(
  z.string().regex(/^step[1-9]\d*$/i),
  ddtCaseStepSchema,
);
export const ddtCaseDataSchema = z.record(
  z.string().min(1).max(256),
  z.union([ddtCellValueSchema, ddtJourneyStepsSchema]),
);

export const ddtScopeSchema = z.object({
  projectId: z.string().min(1).max(128),
  projectVersionId: z.string().min(1).max(128),
  testStageId: z.string().min(1).max(128),
});

export const ddtSearchOperatorSchema = z.enum([
  "eq",
  "ne",
  "contains",
  "prefix",
  "exists",
  "gt",
  "gte",
  "lt",
  "lte",
]);

export const ddtSearchFilterSchema = z.object({
  field: z.string().trim().min(1).max(256),
  operator: ddtSearchOperatorSchema,
  value: ddtCellValueSchema.optional(),
});

export const ddtCaseListInputSchema = ddtScopeSchema.extend({
  query: z.string().trim().max(512).optional(),
  srNum: z.string().trim().max(512).optional(),
  sourceName: z.string().trim().max(512).optional(),
  cursor: z.string().min(1).max(1_024).optional(),
  limit: z.number().int().min(1).max(200).default(60),
  filters: z.array(ddtSearchFilterSchema).max(12).default([]),
});

export const updateDdtCaseInputSchema = z.object({
  expectedRevision: z.number().int().min(1),
  data: ddtCaseDataSchema,
});

export const bulkUpdateDdtCasesInputSchema = z.object({
  caseIds: z.array(z.string().min(1).max(512)).min(1).max(DDT_BULK_MUTATION_LIMIT),
  field: z.string().trim().min(1).max(256),
  value: ddtCellValueSchema,
  stepName: z
    .string()
    .regex(/^step[1-9]\d*$/i)
    .optional(),
});

export const bulkDdtCaseIdsInputSchema = z.object({
  caseIds: z.array(z.string().min(1).max(512)).min(1).max(DDT_BULK_MUTATION_LIMIT),
});

export const ddtTemplateFieldTypeSchema = z.enum(["string", "number", "boolean", "date"]);
export const ddtTemplateFieldRuleSchema = z.object({
  field: z.string().trim().min(1).max(256),
  required: z.boolean().default(false),
  type: ddtTemplateFieldTypeSchema,
  enumValues: z.array(ddtCellValueSchema).max(100).optional(),
  defaultValue: ddtCellValueSchema.optional(),
});

export const upsertDdtTemplateInputSchema = z.object({
  expectedRevision: z.number().int().min(1).optional(),
  srNum: z.string().trim().min(1).max(512),
  name: z.string().trim().min(1).max(256),
  description: z.string().trim().max(2_000).default(""),
  rules: z.array(ddtTemplateFieldRuleSchema).max(200),
});

export const confirmDdtImportInputSchema = z.object({
  conflictStrategy: z.enum(["overwrite", "skip", "error"]),
});

export const ddtImportJobStatusSchema = z.enum([
  "previewed",
  "queued",
  "running",
  "cancel_requested",
  "succeeded",
  "partially_succeeded",
  "failed",
  "cancelled",
]);

export type DdtCaseListInput = z.infer<typeof ddtCaseListInputSchema>;
export type DdtCellValue = z.infer<typeof ddtCellValueSchema>;
export type DdtSearchFilter = z.infer<typeof ddtSearchFilterSchema>;
export type DdtImportJobStatus = z.infer<typeof ddtImportJobStatusSchema>;
export type UpsertDdtTemplateInput = z.infer<typeof upsertDdtTemplateInputSchema>;
