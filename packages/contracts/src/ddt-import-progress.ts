import { z } from "zod";
import { ddtImportJobStatusSchema, ddtScopeSchema } from "./ddt";

export const DDT_IMPORT_FILES_PAGE_SIZE = 50;
const count = z.number().int().nonnegative();

export const ddtImportJobSummarySchema = ddtScopeSchema.extend({
  id: z.string(),
  status: ddtImportJobStatusSchema,
  progressPercent: count.max(100),
  totalFiles: count,
  validFiles: count,
  totalRows: count,
  insertedCount: count,
  updatedCount: count,
  unchangedCount: count,
  skippedCount: count,
  failedFiles: count,
  errorSummary: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ddtImportJobSummaryPageSchema = z.object({
  items: z.array(ddtImportJobSummarySchema).max(100),
  nextCursor: z.string().optional(),
});

export const ddtImportFilesQuerySchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(DDT_IMPORT_FILES_PAGE_SIZE),
});

export const ddtImportFileCursorSchema = z.object({
  jobId: z.string().min(1),
  createdAt: z.string().min(1).max(64),
  id: z.string().min(1).max(512),
});

export const ddtImportFileSummarySchema = z.object({
  id: z.string(),
  fileName: z.string(),
  archiveEntryName: z.string().optional(),
  status: z.enum(["valid", "excluded", "pending", "importing", "succeeded", "failed", "cancelled"]),
  rowCount: count,
  insertedCount: count,
  updatedCount: count,
  unchangedCount: count,
  skippedCount: count,
  errorSummary: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ddtImportFilePageSchema = z.object({
  items: z.array(ddtImportFileSummarySchema).max(100),
  totalCount: count,
  nextCursor: z.string().optional(),
});

export type DdtImportJobSummary = z.infer<typeof ddtImportJobSummarySchema>;
export type DdtImportFileSummary = z.infer<typeof ddtImportFileSummarySchema>;
export type DdtImportFilePage = z.infer<typeof ddtImportFilePageSchema>;
