import { z } from "zod";
import { ddtCaseDataSchema } from "./ddt";

export const ddtChangeDataSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    data: ddtCaseDataSchema,
  })
  .strict();

export const DDT_CHANGE_REQUEST_CASE_LIMIT = 50;
export const ddtChangeSelectionSchema = z
  .object({
    caseId: z.string().trim().min(1).max(512),
    personalRevision: z.number().int().positive(),
    baseId: z.string().min(1).max(128).nullable(),
    baseRevision: z.number().int().positive().nullable(),
    fields: z.array(z.string().min(1).max(512)).min(1).max(1000).optional(),
  })
  .strict();
export const submitDdtChangeRequestSchema = z
  .object({
    id: z.uuid(),
    title: z.string().trim().min(1, "请填写变更标题。").max(160),
    description: z.string().trim().max(4000).default(""),
    cases: z
      .array(ddtChangeSelectionSchema)
      .min(1, "请至少选择一个差异用例。")
      .max(DDT_CHANGE_REQUEST_CASE_LIMIT),
  })
  .strict();
export const reviewDdtChangeRequestSchema = z
  .object({
    action: z.enum(["approve", "reject", "withdraw"]),
    comment: z.string().trim().max(4000).default(""),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.action === "reject" && !input.comment)
      context.addIssue({
        code: "custom",
        path: ["comment"],
        message: "退回时请填写原因，便于提交人修改。",
      });
  });
export type DdtChangeSelection = z.infer<typeof ddtChangeSelectionSchema>;
export type SubmitDdtChangeRequest = z.infer<typeof submitDdtChangeRequestSchema>;
export type ReviewDdtChangeRequest = z.infer<typeof reviewDdtChangeRequestSchema>;
