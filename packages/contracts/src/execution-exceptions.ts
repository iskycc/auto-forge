import { z } from "zod";

const batchStatus = z.enum([
  "queued",
  "dispatching",
  "scheduled",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const executionExceptionCursorSchema = z
  .object({
    occurredAt: z.string().datetime(),
    id: z.string().min(1).max(320),
  })
  .strict();
export type ExecutionExceptionCursor = z.infer<typeof executionExceptionCursorSchema>;

export const executionExceptionSchema = z.object({
  id: z.string(),
  kind: z.enum(["attempt", "run", "recovery"]),
  round: z.number().int().positive(),
  attemptNumber: z.number().int().positive().nullable(),
  runId: z.string().nullable(),
  caseName: z.string().nullable(),
  className: z.string().nullable(),
  resultCode: z.string(),
  summary: z.string().max(8192),
  occurredAt: z.string(),
  affectsBatchStatus: z.boolean(),
});
export type ExecutionException = z.infer<typeof executionExceptionSchema>;
export const executionExceptionPageSchema = z.object({
  batchId: z.string(),
  status: batchStatus,
  expectedStatus: batchStatus,
  consistent: z.boolean(),
  abnormalRuns: z.number().int().nonnegative(),
  items: z.array(executionExceptionSchema).max(100),
  nextCursor: z.string().optional(),
});
export type ExecutionExceptionPage = z.infer<typeof executionExceptionPageSchema>;
