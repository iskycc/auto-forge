import { z } from "zod";

export const DDT_IMPORT_FILE_LIMIT = 200;
export const DDT_IMPORT_ZIP_SPREADSHEET_LIMIT = 200;
export const DDT_IMPORT_CONFIGURABLE_LIMIT_MAXIMUM = 10_000;
export const DDT_IMPORT_FILE_BYTES = 128 * 1_024 * 1_024;
export const DDT_IMPORT_TOTAL_BYTES = 512 * 1_024 * 1_024;
export const DDT_IMPORT_ARCHIVE_ENTRY_LIMIT = 10_000;
export const DDT_BULK_MUTATION_LIMIT = 5_000;
export const DDT_IMPORT_COLUMN_RESOLUTION_LIMIT = 5_000;
export const DDT_VALUE_SEARCH_CASE_NAME_MAX_LENGTH = 1_024;
export const DDT_VALUE_SEARCH_PAGE_SIZE = 20;
export const DDT_VALUE_SEARCH_MAX_KEYWORDS = 12;
export const DDT_VALUE_SEARCH_MAX_TEXT_LENGTH = 512;

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

export const inheritDdtCasesInputSchema = z.object({
  sourceProjectVersionId: z.string().min(1).max(128),
  sourceTestStageId: z.string().min(1).max(128),
  cursor: z.string().min(1).max(1_024).optional(),
});

export const ddtInheritancePageSchema = z.object({
  inheritedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  nextCursor: z.string().optional(),
});

export type InheritDdtCasesInput = z.infer<typeof inheritDdtCasesInputSchema>;
export type DdtInheritancePage = z.infer<typeof ddtInheritancePageSchema>;

export const ddtCaseLookupSchema = ddtScopeSchema.extend({
  caseId: z.string().trim().min(1).max(512),
});

const ddtValueSearchKeywordSchema = z
  .string()
  .trim()
  .min(1, "请输入要检索的字段值。")
  .max(DDT_VALUE_SEARCH_MAX_TEXT_LENGTH);

export const ddtValueSearchKeywordsSchema = z
  .array(ddtValueSearchKeywordSchema)
  .min(1, "请至少填写一个搜索条件。")
  .max(DDT_VALUE_SEARCH_MAX_KEYWORDS, "最多添加 12 个搜索条件。")
  .refine(
    (keywords) =>
      keywords.reduce((length, keyword) => length + keyword.length, 0) <=
      DDT_VALUE_SEARCH_MAX_TEXT_LENGTH,
    "所有搜索条件合计不能超过 512 个字符。",
  )
  .transform((keywords) => {
    const seen = new Set<string>();
    return keywords.filter((keyword) => {
      const normalized = keyword.toLocaleLowerCase("en-US");
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  });

export const ddtValueSearchInputSchema = ddtScopeSchema
  .extend({
    // Keep the original single-keyword input compatible with existing clients.
    keyword: ddtValueSearchKeywordSchema.optional(),
    keywords: ddtValueSearchKeywordsSchema.optional(),
    cursor: z.string().min(1).max(1_024).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(DDT_VALUE_SEARCH_PAGE_SIZE)
      .default(DDT_VALUE_SEARCH_PAGE_SIZE),
    // When present, count a slice and return page starts instead of result bodies.
    indexOffset: z
      .number()
      .int()
      .min(0)
      .max(DDT_VALUE_SEARCH_PAGE_SIZE - 1)
      .optional(),
  })
  .refine(
    (input) => (input.keyword !== undefined) !== (input.keywords !== undefined),
    "请提供关键词或关键词列表，不能同时提供两者。",
  );

export const ddtValueSearchPageSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        caseId: z.string(),
        caseName: z.string().max(DDT_VALUE_SEARCH_CASE_NAME_MAX_LENGTH).optional(),
        srNum: z.string(),
        matchCount: z.number().int().positive(),
        matches: z
          .array(
            z.object({
              path: z.array(z.string()),
              value: z.string(),
            }),
          )
          .max(8),
      }),
    )
    .max(20),
  scannedCount: z.number().int().nonnegative(),
  nextCursor: z.string().optional(),
  index: z
    .object({
      matchedCount: z.number().int().nonnegative().max(4_096),
      pageCursors: z.array(z.string().max(1_024)).max(205),
    })
    .optional(),
});

export type DdtValueSearchInput = z.infer<typeof ddtValueSearchInputSchema>;
export type DdtValueSearchPage = z.infer<typeof ddtValueSearchPageSchema>;

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
  caseIds: z.array(z.string().trim().min(1).max(512)).max(200).optional(),
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

export const saveDdtRequirementCategoryInputSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    name: z.string().trim().min(1).max(160),
    className: z.string().trim().min(1).max(1_024),
    expectedRevision: z.number().int().min(0),
  })
  .refine((input) => (input.id ? input.expectedRevision > 0 : input.expectedRevision === 0), {
    message: "新分类修订号必须为 0；编辑分类必须提供已有修订号。",
  });
export const deleteDdtRequirementCategoryInputSchema = z.object({
  id: z.string().min(1).max(128),
  expectedRevision: z.number().int().min(1),
});
export const setDdtSrCategoryInputSchema = z.object({
  srNum: z.string().trim().min(1).max(512),
  categoryId: z.string().min(1).max(128).nullable(),
  expectedRevision: z.number().int().min(0),
});

export const setDdtSrExecutionClassInputSchema = z.object({
  srNum: z.string().trim().min(1).max(512),
  className: z.string().trim().min(1).max(1_024).nullable(),
  expectedRevision: z.number().int().min(0),
});
export const changeDdtExecutionClassRangeInputSchema = z.object({
  caseDefinitionId: z.string().min(1).max(128),
  className: z.string().trim().min(1).max(1_024),
  included: z.boolean(),
  expectedRevision: z.number().int().min(0),
});
export const ddtExecutionMappingListInputSchema = z.object({
  onlyUnlinked: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  query: z.string().trim().max(512).default(""),
  cursor: z.string().max(1_024).optional(),
  limit: z.number().int().min(1).max(100).default(60),
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
    .max(DDT_IMPORT_CONFIGURABLE_LIMIT_MAXIMUM - 1),
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
