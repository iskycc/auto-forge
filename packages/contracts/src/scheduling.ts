import { z } from "zod";

import { executionEnvironmentVariableSchema } from "./environment";

export const createRunBatchInputSchema = z
  .object({
    suiteId: z.string().min(1).max(128),
    projectId: z.string().min(1).max(128).optional(),
    environmentVersionId: z.string().min(1).max(128).optional(),
    runnerIds: z.array(z.string().min(1).max(128)).min(1).max(64),
    retryLimit: z.number().int().min(0).max(10),
    queueTimeoutMs: z.number().int().min(1_000).max(604_800_000).default(86_400_000),
    claimTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
    executionTimeoutMs: z.number().int().min(1_000).max(86_400_000).default(3_600_000),
    uploadTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(600_000),
    environmentVariables: z.array(executionEnvironmentVariableSchema).max(64).default([]),
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
    if (value.environmentVersionId && value.environmentVariables.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["environmentVariables"],
        message: "引用环境版本时不能同时提交内联环境变量。",
      });
    }
  });

export type CreateRunBatchInput = z.input<typeof createRunBatchInputSchema>;

export const runBatchPreflightBlockerSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,127}$/),
  category: z.enum(["parameter", "environment", "runner", "toolchain", "input", "resource"]),
  message: z.string().min(1).max(1_024),
  path: z
    .array(z.union([z.string(), z.number()]))
    .max(16)
    .optional(),
  runnerId: z.string().min(1).max(128).optional(),
  caseDefinitionId: z.string().min(1).max(128).optional(),
  sourceId: z.string().min(1).max(128).optional(),
});

export const runBatchPreflightResultSchema = z.object({
  ready: z.boolean(),
  blockers: z.array(runBatchPreflightBlockerSchema).max(1_024),
});

export type RunBatchPreflightBlocker = z.infer<typeof runBatchPreflightBlockerSchema>;
export type RunBatchPreflightResult = z.infer<typeof runBatchPreflightResultSchema>;
