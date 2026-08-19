import { z } from "zod";

const runnerGroupDescriptionSchema = z.string().trim().max(500);

const runnerGroupFields = {
  name: z.string().trim().min(1).max(120),
  description: runnerGroupDescriptionSchema.default(""),
  runnerIds: z
    .array(z.string().min(1).max(128))
    .max(64)
    .refine((runnerIds) => new Set(runnerIds).size === runnerIds.length, {
      message: "执行机组不能包含重复执行机。",
    }),
} as const;

export const createRunnerGroupInputSchema = z.object(runnerGroupFields);

export const updateRunnerGroupInputSchema = z
  .object({
    name: runnerGroupFields.name.optional(),
    description: runnerGroupDescriptionSchema.optional(),
    runnerIds: runnerGroupFields.runnerIds.optional(),
    expectedRevision: z.number().int().min(1),
  })
  .refine(
    (input) =>
      input.name !== undefined || input.description !== undefined || input.runnerIds !== undefined,
    { message: "执行机组更新至少需要包含一个变更字段。" },
  );

export type CreateRunnerGroupInput = z.input<typeof createRunnerGroupInputSchema>;
export type UpdateRunnerGroupInput = z.input<typeof updateRunnerGroupInputSchema>;
