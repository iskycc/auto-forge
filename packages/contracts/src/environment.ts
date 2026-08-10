import { z } from "zod";

export const executionEnvironmentVariableSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "环境变量名格式无效。"),
  value: z.string().max(4_096),
});

export const executionEnvironmentSecretBindingInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "密文变量名格式无效。"),
  secretId: z.string().min(1).max(128),
});

const environmentVariablesSchema = z
  .array(executionEnvironmentVariableSchema)
  .max(64)
  .superRefine((variables, context) => {
    const names = variables.map((variable) => variable.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: "custom", message: "环境变量名不能重复。" });
    }
  });

export const createExecutionEnvironmentInputSchema = z
  .object({
    projectId: z.string().min(1).max(128),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1_000).default(""),
    variables: environmentVariablesSchema.default([]),
    secretBindings: z.array(executionEnvironmentSecretBindingInputSchema).max(64).default([]),
  })
  .superRefine(validateEnvironmentNames);

export const updateExecutionEnvironmentInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1_000).optional(),
    variables: environmentVariablesSchema.optional(),
    secretBindings: z.array(executionEnvironmentSecretBindingInputSchema).max(64).optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.description !== undefined ||
      input.variables !== undefined ||
      input.secretBindings !== undefined,
    { message: "至少提供一个需要修改的字段。" },
  )
  .superRefine(validateEnvironmentNames);

export const setExecutionEnvironmentStatusInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  status: z.enum(["active", "disabled"]),
});

export const copyExecutionEnvironmentInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).optional(),
});

export const createExecutionSecretInputSchema = z.object({
  projectId: z.string().min(1).max(128),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).default(""),
  value: z.string().min(1).max(16_384),
});

export const rotateExecutionSecretInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  value: z.string().min(1).max(16_384),
});

export const setExecutionSecretStatusInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  status: z.enum(["active", "disabled"]),
});

export type CreateExecutionEnvironmentInput = z.infer<typeof createExecutionEnvironmentInputSchema>;
export type UpdateExecutionEnvironmentInput = z.infer<typeof updateExecutionEnvironmentInputSchema>;
export type SetExecutionEnvironmentStatusInput = z.infer<
  typeof setExecutionEnvironmentStatusInputSchema
>;
export type CopyExecutionEnvironmentInput = z.infer<typeof copyExecutionEnvironmentInputSchema>;
export type CreateExecutionSecretInput = z.infer<typeof createExecutionSecretInputSchema>;
export type RotateExecutionSecretInput = z.infer<typeof rotateExecutionSecretInputSchema>;
export type SetExecutionSecretStatusInput = z.infer<typeof setExecutionSecretStatusInputSchema>;

function validateEnvironmentNames(
  input: {
    variables?: Array<{ name: string }> | undefined;
    secretBindings?: Array<{ name: string }> | undefined;
  },
  context: z.RefinementCtx,
): void {
  const names = [
    ...(input.variables ?? []).map((entry) => entry.name),
    ...(input.secretBindings ?? []).map((entry) => entry.name),
  ];
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: "custom", message: "普通变量与密文变量的名称不能重复。" });
  }
}
