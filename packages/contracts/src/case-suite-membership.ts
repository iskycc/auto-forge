import { z } from "zod";

export const CASE_SUITE_MEMBER_REMARK_LIMIT = 500;
export const CASE_SUITE_MARKER_COUNT = 5;
export const CASE_SUITE_MARKER_TEXT_LIMIT = 120;
export const CASE_SUITE_MARKER_HEADERS = ["标识1", "标识2", "标识3", "标识4", "标识5"] as const;
export const CASE_SUITE_MARKER_IMPORT_LIMIT = 100_000;
export const CASE_SUITE_MARKER_FILE_BYTES = 16 * 1024 * 1024;

export const caseSuiteMemberRemarkSchema = z.string().trim().max(CASE_SUITE_MEMBER_REMARK_LIMIT);
export const caseSuiteMemberKindSchema = z.enum(["standard", "ddt"]);
export type CaseSuiteMemberKind = z.infer<typeof caseSuiteMemberKindSchema>;
export const caseSuiteMarkersSchema = z
  .array(
    z
      .string()
      .trim()
      .max(CASE_SUITE_MARKER_TEXT_LIMIT)
      .refine(
        (value) => !/[\u0000-\u001f\u007f\ufffe\uffff]/u.test(value),
        "标识只能包含单行可显示文本。",
      ),
  )
  .max(CASE_SUITE_MARKER_COUNT);
export type CaseSuiteMarkers = z.infer<typeof caseSuiteMarkersSchema>;
export const caseSuiteMarkerEditSchema = z
  .object({
    kind: caseSuiteMemberKindSchema,
    memberId: z.string().min(1).max(128),
    markers: caseSuiteMarkersSchema,
  })
  .strict();
export type CaseSuiteMarkerEdit = z.infer<typeof caseSuiteMarkerEditSchema>;
export type CaseSuiteMarkerMember = CaseSuiteMarkerEdit & { caseLabel: string };

export type CaseSuiteMemberChange = {
  id: string;
  kind: CaseSuiteMemberKind;
  operation: "add" | "remove";
  count: number;
  actorName: string | null;
  remark: string;
  changedAt: string;
};
export type CaseSuiteChangedMember = { caseId: string; caseLabel: string };
export type CaseSuiteMembershipPage<T> = { items: T[]; nextCursor?: string };

export const CASE_SUITE_MARKER_SHEET = "任务用例标识";
export const CASE_SUITE_MARKER_WORKBOOK_HEADERS = ["用例", ...CASE_SUITE_MARKER_HEADERS] as const;
export const caseSuiteMarkerImportRowSchema = z
  .object({
    rowNumber: z
      .number()
      .int()
      .min(2)
      .max(CASE_SUITE_MARKER_IMPORT_LIMIT + 1),
    caseLabel: z.string().min(1),
    markers: caseSuiteMarkersSchema,
  })
  .strict();
export type CaseSuiteMarkerImportRow = z.infer<typeof caseSuiteMarkerImportRowSchema>;
export const caseSuiteMarkerImportRowsSchema = z
  .array(caseSuiteMarkerImportRowSchema)
  .min(1)
  .max(CASE_SUITE_MARKER_IMPORT_LIMIT);
export const caseSuiteMarkerRevisionSchema = z.number().int().nonnegative();
