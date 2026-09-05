import { z } from "zod";

const count = z.number().int().nonnegative();
export const runBatchResultSummarySchema = z.object({
  totalRuns: count,
  passed: count,
  failed: count,
  timedOut: count,
  cancelled: count,
  notExecuted: count,
  passRate: z.number(),
});
export const runBatchCountersSchema = z.object({
  queuedRuns: count,
  assignedRuns: count,
  runningRuns: count,
  succeededRuns: count,
  failedRuns: count,
  timedOutRuns: count,
  cancelledRuns: count,
});
export const batchCountersSnapshotSchema = z
  .array(runBatchCountersSchema.extend({ id: z.string() }))
  .max(200);
export const executionOverviewSnapshotSchema = z.object({
  sourceVersion: count,
  counters: runBatchCountersSchema,
  sourceStatus: z.enum([
    "queued",
    "dispatching",
    "scheduled",
    "running",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  roundSummaries: z.array(
    runBatchResultSummarySchema.omit({ passRate: true }).extend({
      round: count,
      status: z.enum(["running", "completed", "waiting"]),
      executed: count,
      roundPassRate: z.number().nullable(),
      overallPassed: count,
      overallPassRate: z.number(),
      startedAt: z.string().nullable(),
      durationMs: count.nullable(),
    }),
  ),
  allRoundsSummary: runBatchResultSummarySchema,
  finalSummary: runBatchResultSummarySchema,
  roundRecoveries: z.array(
    z.object({
      ruleId: z.string(),
      afterRound: count,
      nextRound: count,
      jenkinsJobUrl: z.string(),
      waitMinutes: count,
      status: z.enum([
        "idle",
        "pending",
        "polling",
        "waiting",
        "releasing",
        "succeeded",
        "failed",
        "cancelled",
      ]),
      sourceBuildNumber: count.optional(),
      rebuildNumber: count.optional(),
      rebuildUrl: z.string().optional(),
      activatedAt: z.string().optional(),
      startedAt: z.string().optional(),
      finishedAt: z.string().optional(),
      buildResult: z.string().optional(),
      errorMessage: z.string().optional(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
  roundConcurrencies: z.array(
    z.object({
      round: count,
      concurrency: count,
      source: z.enum(["base", "inherited_rule", "rule_transition"]),
      ruleId: z.string().optional(),
      previousConcurrency: count.optional(),
      recordedAt: z.string(),
    }),
  ),
  runnerRoundSummaries: z.array(
    z.object({
      round: count,
      runnerId: z.string(),
      executed: count,
      passed: count,
      failed: count,
      lastActivity: z.string(),
    }),
  ),
  runnerFaultIncidents: z.array(
    z.object({
      key: z.string(),
      runnerId: z.string(),
      resultCode: z.string(),
      summary: z.string(),
      count,
      caseNames: z.array(z.string()),
      attemptNumbers: z.array(count),
      lastOccurredAt: z.string(),
    }),
  ),
  participatingRunnerIds: z.array(z.string()),
  finishedAt: z.string(),
});

export const executionCaseKeysSchema = z.object({
  keys: z
    .array(z.object({ runId: z.string(), attemptId: z.string().optional(), round: count }))
    .max(500),
  total: count,
});
