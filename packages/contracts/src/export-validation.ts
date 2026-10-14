import { z } from "zod";

export const EXPORT_ISSUE_PREVIEW_LIMIT = 100;

export const exportRowIssueSchema = z.object({
  rowNumber: z.number().int().min(2),
  executionRunId: z.string().max(160),
  attemptId: z.string().max(160).nullable(),
  round: z.number().int().positive(),
  casePath: z.string().max(1_024),
  caseName: z.string().max(512),
  fields: z
    .array(z.object({ field: z.string().max(100), reason: z.string().max(200) }))
    .min(1)
    .max(40),
});

export const exportValidationReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    totalRows: z.number().int().nonnegative(),
    validRows: z.number().int().nonnegative(),
    excludedRows: z.number().int().nonnegative(),
    issues: z.array(exportRowIssueSchema).max(EXPORT_ISSUE_PREVIEW_LIMIT),
    truncated: z.boolean(),
  })
  .superRefine((report, context) => {
    if (
      report.validRows + report.excludedRows !== report.totalRows ||
      report.issues.length > report.excludedRows ||
      report.truncated !== report.issues.length < report.excludedRows
    ) {
      context.addIssue({ code: "custom", message: "导出校验统计不一致。" });
    }
  });

export type ExportRowIssue = z.infer<typeof exportRowIssueSchema>;
export type ExportValidationReport = z.infer<typeof exportValidationReportSchema>;
