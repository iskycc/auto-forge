import { z } from "zod";

export const DDT_ASSOCIATION_IMPORT_MAXIMUM_BYTES = 16 * 1024 * 1024;
export const DDT_ASSOCIATION_IMPORT_MAXIMUM_ROWS = 500_000;
export const DDT_ASSOCIATION_IMPORT_ISSUE_LIMIT = 100;

export const ddtAssociationSectionSchema = z.enum([
  "range",
  "categories",
  "srCategories",
  "srClasses",
]);
export type DdtAssociationSection = z.infer<typeof ddtAssociationSectionSchema>;

export const DDT_ASSOCIATION_SHEETS = {
  range: { name: "候选测试类", headers: ["测试类路径", "异常说明"] },
  categories: { name: "分类执行类", headers: ["需求分类", "测试类路径", "异常说明"] },
  srCategories: { name: "SR需求分类", headers: ["SR", "需求分类", "异常说明"] },
  srClasses: { name: "SR直接关联", headers: ["SR", "测试类路径", "异常说明"] },
} as const;

const sourceLocation = {
  sheetName: z.string().min(1).max(128),
  rowNumber: z.number().int().positive(),
};
const className = z.string().trim().min(1).max(1024);
const srNum = z.string().trim().min(1).max(512);
const categoryName = z.string().trim().min(1).max(160);
export const ddtAssociationImportRowSchema = z.discriminatedUnion("section", [
  z.object({ ...sourceLocation, section: z.literal("range"), className }),
  z.object({ ...sourceLocation, section: z.literal("categories"), categoryName, className }),
  z.object({
    ...sourceLocation,
    section: z.literal("srCategories"),
    srNum,
    categoryName: categoryName.or(z.literal("")),
  }),
  z.object({
    ...sourceLocation,
    section: z.literal("srClasses"),
    srNum,
    className: className.or(z.literal("")),
  }),
]);
export type DdtAssociationImportRow = z.infer<typeof ddtAssociationImportRowSchema>;

export const ddtAssociationImportIssueSchema = z.object({
  ...sourceLocation,
  identifier: z.string().max(1024),
  reason: z.string().min(1).max(1000),
});
export type DdtAssociationImportIssue = z.infer<typeof ddtAssociationImportIssueSchema>;

export const parsedDdtAssociationImportSchema = z.object({
  rows: z.array(ddtAssociationImportRowSchema).max(DDT_ASSOCIATION_IMPORT_MAXIMUM_ROWS),
  rowCount: z.number().int().nonnegative(),
  issueCount: z.number().int().nonnegative(),
  issues: z.array(ddtAssociationImportIssueSchema).max(DDT_ASSOCIATION_IMPORT_ISSUE_LIMIT),
});
export type ParsedDdtAssociationImport = z.infer<typeof parsedDdtAssociationImportSchema>;

export const ddtAssociationImportPreviewSchema = parsedDdtAssociationImportSchema
  .omit({ rows: true })
  .extend({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    counts: z.record(ddtAssociationSectionSchema, z.number().int().nonnegative()),
    samples: z.array(ddtAssociationImportRowSchema).max(20),
  });
export type DdtAssociationImportPreview = z.infer<typeof ddtAssociationImportPreviewSchema>;

export const ddtAssociationImportProgressSchema = z.object({
  total: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  phase: ddtAssociationSectionSchema,
});
export type DdtAssociationImportProgress = z.infer<typeof ddtAssociationImportProgressSchema>;

export const ddtAssociationImportEventSchema = z.discriminatedUnion("type", [
  ddtAssociationImportProgressSchema.extend({ type: z.literal("progress") }),
  ddtAssociationImportProgressSchema.extend({ type: z.literal("completed") }),
  z.object({
    type: z.literal("failed"),
    code: z.string().max(100),
    message: z.string().max(2000),
    processed: z.number().int().nonnegative(),
  }),
]);
