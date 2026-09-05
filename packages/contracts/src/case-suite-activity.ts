import { z } from "zod";

export const caseSuiteActivityScopeSchema = z.object({
  projectId: z.string().min(1).max(128),
  projectVersionId: z.string().min(1).max(128),
});

export const caseSuiteExecutionPageQuerySchema = caseSuiteActivityScopeSchema.extend({
  cursor: z.string().min(1).max(512).optional(),
});

export const caseSuiteExecutionStatisticsSchema = z.object({
  suiteId: z.string().min(1),
  executionCount: z.number().int().nonnegative(),
  completedExecutionCount: z.number().int().nonnegative(),
  averagePassRate: z.number().min(0).max(100).nullable(),
  averagePassedCases: z.number().nonnegative().nullable(),
});

export const caseSuiteActivitySummarySchema = z.object({
  windowStartedAt: z.iso.datetime(),
  generatedAt: z.iso.datetime(),
  items: z.array(caseSuiteExecutionStatisticsSchema).max(200),
});

export const caseSuiteRecentExecutionSchema = z.object({
  id: z.string().min(1),
  sequenceNumber: z.number().int().nonnegative(),
  status: z.enum([
    "queued",
    "dispatching",
    "scheduled",
    "running",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  kind: z.enum(["standard", "final_failure_rerun"]),
  totalRuns: z.number().int().nonnegative(),
  succeededRuns: z.number().int().nonnegative(),
  failedRuns: z.number().int().nonnegative(),
  timedOutRuns: z.number().int().nonnegative(),
  cancelledRuns: z.number().int().nonnegative(),
  currentRound: z.number().int().positive(),
  retryLimit: z.number().int().nonnegative(),
  requestedBy: z.string().optional(),
  terminationRequestedAt: z.iso.datetime().optional(),
  scheduledFor: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const caseSuiteRecentExecutionsSchema = z.object({
  items: z.array(caseSuiteRecentExecutionSchema).max(10),
  nextCursor: z.string().max(512).optional(),
});

export type CaseSuiteActivityScope = z.infer<typeof caseSuiteActivityScopeSchema>;
export type CaseSuiteExecutionPageQuery = z.infer<typeof caseSuiteExecutionPageQuerySchema>;
export type CaseSuiteExecutionStatistics = z.infer<typeof caseSuiteExecutionStatisticsSchema>;
export type CaseSuiteActivitySummary = z.infer<typeof caseSuiteActivitySummarySchema>;
export type CaseSuiteRecentExecution = z.infer<typeof caseSuiteRecentExecutionSchema>;
export type CaseSuiteRecentExecutions = z.infer<typeof caseSuiteRecentExecutionsSchema>;
