import { z } from "zod";

const environmentVariableSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "环境变量名格式无效。"),
  value: z.string().max(4_096),
});

export const createRunBatchInputSchema = z
  .object({
    suiteId: z.string().min(1).max(128),
    runnerIds: z.array(z.string().min(1).max(128)).min(1).max(64),
    retryLimit: z.number().int().min(0).max(10),
    environmentVariables: z.array(environmentVariableSchema).max(64).default([]),
  })
  .superRefine((value, context) => {
    if (new Set(value.runnerIds).size !== value.runnerIds.length) {
      context.addIssue({
        code: "custom",
        path: ["runnerIds"],
        message: "runnerIds 不能包含重复项。",
      });
    }
    const variableNames = value.environmentVariables.map((variable) => variable.name);
    if (new Set(variableNames).size !== variableNames.length) {
      context.addIssue({
        code: "custom",
        path: ["environmentVariables"],
        message: "环境变量名不能重复。",
      });
    }
  });

export type CreateRunBatchInput = z.infer<typeof createRunBatchInputSchema>;
