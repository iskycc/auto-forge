import { z } from "zod";

import { executionEnvironmentVariableSchema } from "./environment";
import { caseSuiteAdapterConfigurationSchema } from "./management";

const executionInputFields = {
  projectId: z.string().min(1).max(128).optional(),
  environmentVersionId: z.string().min(1).max(128).optional(),
  runnerIds: z.array(z.string().min(1).max(128)).max(64).default([]),
  runnerGroupId: z.string().min(1).max(128).optional(),
  // 优先级、重试与排队/执行超时允许缺省，创建时按“输入 ?? 任务策略 ?? 系统默认”合并。
  retryLimit: z.number().int().min(0).max(10).optional(),
  retryMode: z.enum(["immediate", "round"]).optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  queueTimeoutMs: z.number().int().min(1_000).max(604_800_000).optional(),
  claimTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
  executionTimeoutMs: z.number().int().min(1_000).max(86_400_000).optional(),
  uploadTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(600_000),
  environmentVariables: z.array(executionEnvironmentVariableSchema).max(64).default([]),
} as const;

function validateExecutionInput(
  value: {
    runnerIds: string[];
    runnerGroupId?: string | undefined;
    environmentVersionId?: string | undefined;
    environmentVariables: Array<{ name: string }>;
  },
  context: z.RefinementCtx,
): void {
  const hasDirectRunnerSelection = value.runnerIds.length > 0;
  const hasRunnerGroupSelection = Boolean(value.runnerGroupId);
  if (hasDirectRunnerSelection === hasRunnerGroupSelection) {
    context.addIssue({
      code: "custom",
      path: ["runnerIds"],
      message: "必须且只能选择执行机或执行机组中的一种。",
    });
  }
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
}

export const createRunBatchInputSchema = z
  .object({ suiteId: z.string().min(1).max(128), ...executionInputFields })
  .superRefine(validateExecutionInput);

export type CreateRunBatchInput = z.input<typeof createRunBatchInputSchema>;

export const createSingleCaseRunInputSchema = z
  .object({
    ...executionInputFields,
    parameters: z.record(z.string().min(1).max(128), z.string().max(1_024)).default({}),
    artifactPatterns: z.array(z.string().min(1).max(256)).max(32).default([]),
    adapter: caseSuiteAdapterConfigurationSchema.default({
      enabled: false,
      suiteName: "",
      testName: "",
      environmentAddresses: [],
    }),
  })
  .superRefine((value, context) => {
    validateExecutionInput(value, context);
    if (!value.adapter.enabled) return;
    if (!value.adapter.suiteName) {
      context.addIssue({
        code: "custom",
        path: ["adapter", "suiteName"],
        message: "启用 Adapter 时必须填写 Suite Name。",
      });
    }
    if (!value.adapter.testName) {
      context.addIssue({
        code: "custom",
        path: ["adapter", "testName"],
        message: "启用 Adapter 时必须填写 Test Name。",
      });
    }
    if (value.adapter.environmentAddresses.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["adapter", "environmentAddresses"],
        message: "启用 Adapter 时必须填写至少一个执行环境 IP 或地址。",
      });
    }
  });

export type CreateSingleCaseRunInput = z.input<typeof createSingleCaseRunInputSchema>;

export type RetryMode = "immediate" | "round";

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
