import { z } from "zod";

export const ddtSrTagScopeSchema = z.object({
  projectId: z.string().trim().min(1).max(128),
  projectVersionId: z.string().trim().min(1).max(128),
});
export const ddtSrTagSchema = z.object({ id: z.string(), name: z.string() });
export const ddtSrTagLookupSchema = z.record(z.string(), z.array(ddtSrTagSchema));
export const ddtSrTagPageSchema = z.object({
  items: z.array(ddtSrTagSchema),
  nextCursor: z.string().optional(),
});
export const ddtSrTagQuerySchema = z.object({
  query: z.string().trim().max(128).default(""),
  tagIds: z.array(z.string().min(1).max(128)).min(1).max(100).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});
export const ddtSrTagMutationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create"), name: z.string().trim().min(1).max(64) }),
  z.object({
    operation: z.literal("assign"),
    tagId: z.string().min(1).max(128),
    srNum: z.string().trim().min(1).max(512),
    assigned: z.boolean(),
  }),
]);
export const ddtSrTagFilterSchema = z.object({
  tagIds: z.array(z.string().min(1).max(128)).min(1).max(100),
  match: z.enum(["include", "exclude"]),
  cursor: z.string().max(128).optional(),
  revision: z.coerce.number().int().positive(),
});
export const ddtSrTagGroupsSchema = z.object({
  items: z.array(
    z.object({ srNum: z.string(), caseCount: z.number().int(), tags: z.array(ddtSrTagSchema) }),
  ),
  nextCursor: z.string().optional(),
});
export const ddtSrTagMembersSchema = z.object({
  items: z.array(z.object({ id: z.string(), srNum: z.string() })),
  nextCursor: z.string().optional(),
});
export type DdtSrTagScope = z.infer<typeof ddtSrTagScopeSchema>;
export type DdtSrTag = z.infer<typeof ddtSrTagSchema>;
export type DdtSrTagPage = z.infer<typeof ddtSrTagPageSchema>;
export type DdtSrTagQuery = z.infer<typeof ddtSrTagQuerySchema>;
export type DdtSrTagMutation = z.infer<typeof ddtSrTagMutationSchema>;
export type DdtSrTagGroups = z.infer<typeof ddtSrTagGroupsSchema>;
export type DdtSrTagMembers = z.infer<typeof ddtSrTagMembersSchema>;
export type DdtSrTagFilter = z.infer<typeof ddtSrTagFilterSchema>;

export const SR_TAG_IMPORT_MAXIMUM_BYTES = 16 * 1024 * 1024;
export const SR_TAG_IMPORT_MAXIMUM_ROWS = 100_000;
export const SR_TAG_IMPORT_ISSUE_LIMIT = 100;
export const SR_TAG_IMPORT_SAMPLE_LIMIT = 50;
export const SR_TAG_IMPORT_BATCH_SIZE = 100;
export const srTagClassificationSchema = z.object({
  srNum: z.string().trim().min(1).max(512),
  tagName: z.string().trim().min(1).max(64),
});
export const srTagImportRowSchema = srTagClassificationSchema.extend({
  sheetName: z.string().max(256),
  rowNumber: z.number().int().positive(),
});
export const srTagImportIssueSchema = z.object({
  sheetName: z.string(),
  rowNumber: z.number().int().positive(),
  srNum: z.string(),
  tagName: z.string(),
  reason: z.string(),
});
export const parsedSrTagImportSchema = z.object({
  rows: z.array(srTagImportRowSchema).max(SR_TAG_IMPORT_MAXIMUM_ROWS),
  rowCount: z.number().int().nonnegative(),
  issueCount: z.number().int().nonnegative(),
  issues: z.array(srTagImportIssueSchema).max(SR_TAG_IMPORT_ISSUE_LIMIT),
});
export const srTagImportPreviewSchema = parsedSrTagImportSchema.omit({ rows: true }).extend({
  samples: z.array(srTagImportRowSchema).max(SR_TAG_IMPORT_SAMPLE_LIMIT),
});
export const srTagImportResultSchema = z.object({
  rowCount: z.number().int().nonnegative(),
  createdCount: z.number().int().nonnegative(),
  existingCount: z.number().int().nonnegative(),
});
export type SrTagClassification = z.infer<typeof srTagClassificationSchema>;
export type SrTagImportRow = z.infer<typeof srTagImportRowSchema>;
export type SrTagImportIssue = z.infer<typeof srTagImportIssueSchema>;
export type ParsedSrTagImport = z.infer<typeof parsedSrTagImportSchema>;
export type SrTagImportPreview = z.infer<typeof srTagImportPreviewSchema>;
export type SrTagImportResult = z.infer<typeof srTagImportResultSchema>;
