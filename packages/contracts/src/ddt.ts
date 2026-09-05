import { z } from "zod";

export const DDT_IMPORT_FILE_LIMIT = 200;
export const DDT_IMPORT_FILE_BYTES = 128 * 1_024 * 1_024;
export const DDT_IMPORT_TOTAL_BYTES = 512 * 1_024 * 1_024;
export const DDT_IMPORT_ARCHIVE_ENTRY_LIMIT = 10_000;
export const DDT_BULK_MUTATION_LIMIT = 5_000;
export const DDT_IMPORT_COLUMN_RESOLUTION_LIMIT = 5_000;

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

export const setDdtExecutionClassInputSchema = z.object({
  caseIds: z.array(z.string().min(1).max(512)).min(1).max(DDT_BULK_MUTATION_LIMIT),
  className: z.string().trim().min(1).max(1_024),
});

export const addCaseSuiteDdtItemsInputSchema = z.object({
  testStageId: z.string().min(1).max(128),
  caseIds: z.array(z.string().min(1).max(512)).min(1).max(100_000),
});

export const removeCaseSuiteDdtItemsInputSchema = z.object({
  ddtCaseIds: z.array(z.string().min(1).max(128)).min(1).max(100_000),
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

export const ddtImportColumnResolutionSchema = z.object({
  uploadIndex: z
    .number()
    .int()
    .min(0)
    .max(DDT_IMPORT_FILE_LIMIT - 1),
  archiveEntryName: z.string().trim().min(1).max(1_024).optional(),
  sheetName: z.string().trim().min(1).max(256),
  columnIndex: z.number().int().min(0).max(16_383),
  resolvedName: z.string().trim().min(1).max(256),
  deleteColumn: z.boolean().optional(),
});

export const resolveDdtImportColumnsInputSchema = z.object({
  columnResolutions: z
    .array(ddtImportColumnResolutionSchema)
    .min(1)
    .max(DDT_IMPORT_COLUMN_RESOLUTION_LIMIT),
});

export const ddtImportColumnConflictSchema = z.object({
  archiveEntryName: z.string().min(1).max(1_024).optional(),
  sheetName: z.string().min(1).max(256),
  normalizedName: z.string().min(1).max(256),
  columns: z
    .array(
      z.object({
        columnIndex: z.number().int().min(0).max(16_383),
        originalName: z.string().max(256),
        currentName: z.string().min(1).max(256),
        suggestedName: z.string().min(1).max(256),
        nonEmptyCount: z.number().int().min(0),
        sampleValues: z
          .array(
            z.object({
              rowNumber: z.number().int().min(2),
              value: z.string().max(256),
            }),
          )
          .max(8),
      }),
    )
    .min(2)
    .max(16_384),
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
export type DdtImportColumnResolution = z.infer<typeof ddtImportColumnResolutionSchema>;
export type DdtImportColumnConflict = z.infer<typeof ddtImportColumnConflictSchema>;
export type DdtColumnResolution = Omit<DdtImportColumnResolution, "uploadIndex">;
export type UpsertDdtTemplateInput = z.infer<typeof upsertDdtTemplateInputSchema>;
