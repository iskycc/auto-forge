import { z } from "zod";
import { ddtScopeSchema } from "./ddt";
import { createSingleCaseRunInputSchema } from "./scheduling";

export const createCaseDebugRunSchema = ddtScopeSchema
  .extend({
    kind: z.enum(["testng", "ddt"]),
    caseDefinitionId: z.string().min(1).max(128),
    ddtCaseId: z.string().min(1).max(512).optional(),
    execution: createSingleCaseRunInputSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if ((input.kind === "ddt") !== Boolean(input.ddtCaseId)) {
      context.addIssue({
        code: "custom",
        path: ["ddtCaseId"],
        message: "DDT 调试必须选择一个 DDT 用例，普通调试不能携带 DDT 数据。",
      });
    }
    if (input.kind === "ddt" && !input.execution.adapter.enabled) {
      context.addIssue({
        code: "custom",
        path: ["execution", "adapter"],
        message: "DDT 调试必须启用 Adapter，以传递 CaseId。",
      });
    }
    if (input.execution.projectId && input.execution.projectId !== input.projectId) {
      context.addIssue({
        code: "custom",
        path: ["execution", "projectId"],
        message: "执行配置与当前项目不一致。",
      });
    }
  });

export type CreateCaseDebugRunInput = z.infer<typeof createCaseDebugRunSchema>;
