import type {
  CreateRunBatchRecord,
  ReserveSchedulingAssignmentsInput,
  RunBatchRepository,
  SchedulingSnapshot,
} from "@autoforge/application";
import type { ExecutionSpec } from "@autoforge/contracts";
import {
  evaluateRunnerForScheduling,
  type ExecutionEnvironmentVariable,
  type ExecutionRun,
  type RunAttempt,
  type RunBatch,
  type RunBatchDetails,
  type RunBatchStatus,
} from "@autoforge/domain";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";

import type { SqliteDatabaseHandle } from "./database";
import { mapStoredRunner } from "./runner-mapper";
import {
  assignments,
  caseDefinitions,
  caseSources,
  executionRuns,
  runAttempts,
  runBatchRunners,
  runBatches,
  runners,
} from "./schema";

const activeAttemptStatuses = ["assigned", "running"] as const;

export class SqliteRunBatchRepository implements RunBatchRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async create(record: CreateRunBatchRecord): Promise<RunBatchDetails> {
    this.handle.client.transaction(() => {
      this.handle.db
        .insert(runBatches)
        .values({
          id: record.id,
          suiteId: record.suiteId,
          suiteName: record.suiteName,
          suiteVersion: record.suiteVersion,
          status: "queued",
          retryLimit: record.retryLimit,
          environmentJson: JSON.stringify(record.environmentVariables),
          totalRuns: record.runs.length,
          createdAt: record.createdAt,
          updatedAt: record.createdAt,
        })
        .run();
      this.handle.db
        .insert(runBatchRunners)
        .values(record.runnerIds.map((runnerId) => ({ batchId: record.id, runnerId })))
        .run();
      this.handle.db
        .insert(executionRuns)
        .values(
          record.runs.map((run) => ({
            ...run,
            batchId: record.id,
            status: "queued" as const,
            assignedRunnerId: null,
            attemptCount: 0,
            schedulingScore: null,
            createdAt: record.createdAt,
            assignedAt: null,
            updatedAt: record.createdAt,
          })),
        )
        .run();
    })();
    return this.requiredBatch(record.id);
  }

  async list(limit: number): Promise<RunBatch[]> {
    const rows = this.handle.db
      .select()
      .from(runBatches)
      .orderBy(desc(runBatches.createdAt))
      .limit(limit)
      .all();
    return Promise.all(rows.map((row) => this.mapBatch(row)));
  }

  async get(batchId: string): Promise<RunBatchDetails | null> {
    const batchRow = this.handle.db
      .select()
      .from(runBatches)
      .where(eq(runBatches.id, batchId))
      .get();
    if (!batchRow) return null;
    const runRows = this.handle.db
      .select()
      .from(executionRuns)
      .where(eq(executionRuns.batchId, batchId))
      .orderBy(executionRuns.createdAt, executionRuns.id)
      .all();
    const attemptRows =
      runRows.length === 0
        ? []
        : this.handle.db
            .select()
            .from(runAttempts)
            .where(
              inArray(
                runAttempts.executionRunId,
                runRows.map((run) => run.id),
              ),
            )
            .orderBy(runAttempts.createdAt, runAttempts.id)
            .all();
    return {
      ...(await this.mapBatch(batchRow)),
      runs: runRows.map(toExecutionRun),
      attempts: attemptRows.map(toRunAttempt),
    };
  }

  async listSchedulableBatchIds(limit: number): Promise<string[]> {
    return this.handle.db
      .select({ id: runBatches.id })
      .from(runBatches)
      .where(inArray(runBatches.status, ["queued", "dispatching"]))
      .orderBy(runBatches.createdAt)
      .limit(limit)
      .all()
      .map((row) => row.id);
  }

  async listSchedulableBatchIdsForRunner(runnerId: string, limit: number): Promise<string[]> {
    return this.handle.db
      .select({ id: runBatches.id })
      .from(runBatches)
      .innerJoin(runBatchRunners, eq(runBatchRunners.batchId, runBatches.id))
      .where(
        and(
          eq(runBatchRunners.runnerId, runnerId),
          inArray(runBatches.status, ["queued", "dispatching"]),
        ),
      )
      .orderBy(runBatches.createdAt)
      .limit(limit)
      .all()
      .map((row) => row.id);
  }

  async getSchedulingSnapshot(
    batchId: string,
    offlineBefore: string,
  ): Promise<SchedulingSnapshot | null> {
    const batch = await this.get(batchId);
    if (!batch) return null;
    const selectedRunnerIds = batch.selectedRunnerIds;
    const runnerRows =
      selectedRunnerIds.length === 0
        ? []
        : this.handle.db.select().from(runners).where(inArray(runners.id, selectedRunnerIds)).all();
    const reservations = activeReservations(this.handle, selectedRunnerIds);
    const candidates = runnerRows
      .map((row) => ({
        runner: mapStoredRunner(row, offlineBefore),
        reservedSlots: reservations.get(row.id) ?? 0,
      }))
      .filter((candidate) => supportsTestNGExecution(candidate.runner.capabilities));
    return {
      batch,
      queuedRuns: batch.runs.filter((run) => run.status === "queued"),
      candidates,
    };
  }

  async reserveAssignments(input: ReserveSchedulingAssignmentsInput): Promise<number> {
    return this.handle.client.transaction(() => {
      const selectedRunnerIds = new Set(
        this.handle.db
          .select({ runnerId: runBatchRunners.runnerId })
          .from(runBatchRunners)
          .where(eq(runBatchRunners.batchId, input.batchId))
          .all()
          .map((row) => row.runnerId),
      );
      let accepted = 0;
      for (const decision of input.decisions) {
        if (!selectedRunnerIds.has(decision.runnerId)) continue;
        const runnerRow = this.handle.db
          .select()
          .from(runners)
          .where(eq(runners.id, decision.runnerId))
          .get();
        if (!runnerRow) continue;
        const reservations = activeReservations(this.handle, [decision.runnerId]);
        const runner = mapStoredRunner(runnerRow, input.offlineBefore);
        if (!supportsTestNGExecution(runner.capabilities)) continue;
        const evaluation = evaluateRunnerForScheduling(
          {
            runner,
            reservedSlots: reservations.get(decision.runnerId) ?? 0,
          },
          input.thresholds,
          input.metricsFreshAfter,
        );
        if (!evaluation.eligible || evaluation.score === undefined) continue;

        const updatedRun = this.handle.db
          .update(executionRuns)
          .set({
            status: "assigned",
            assignedRunnerId: decision.runnerId,
            attemptCount: sql`${executionRuns.attemptCount} + 1`,
            schedulingScore: evaluation.score,
            assignedAt: input.scheduledAt,
            updatedAt: input.scheduledAt,
          })
          .where(
            and(
              eq(executionRuns.id, decision.executionRunId),
              eq(executionRuns.batchId, input.batchId),
              eq(executionRuns.status, "queued"),
            ),
          )
          .returning({
            attemptCount: executionRuns.attemptCount,
            caseDefinitionId: executionRuns.caseDefinitionId,
            className: executionRuns.className,
          })
          .get();
        if (!updatedRun) continue;
        const source = this.handle.db
          .select({
            id: caseSources.id,
            sha256: caseSources.sha256,
            sizeBytes: caseSources.sizeBytes,
          })
          .from(caseDefinitions)
          .innerJoin(caseSources, eq(caseSources.id, caseDefinitions.sourceId))
          .where(eq(caseDefinitions.id, updatedRun.caseDefinitionId))
          .get();
        if (!source) throw new Error("Cannot schedule a case without its source JAR.");
        this.handle.db
          .insert(runAttempts)
          .values({
            id: decision.attemptId,
            executionRunId: decision.executionRunId,
            runnerId: decision.runnerId,
            attemptNumber: updatedRun.attemptCount,
            status: "assigned",
            schedulingScore: evaluation.score,
            createdAt: input.scheduledAt,
          })
          .run();
        const batch = this.handle.db
          .select({ environmentJson: runBatches.environmentJson, priority: runBatches.priority })
          .from(runBatches)
          .where(eq(runBatches.id, input.batchId))
          .get();
        if (!batch) continue;
        this.handle.db
          .insert(assignments)
          .values({
            id: decision.assignmentId,
            attemptId: decision.attemptId,
            executionRunId: decision.executionRunId,
            batchId: input.batchId,
            runnerId: decision.runnerId,
            status: "pending",
            priority: batch.priority,
            executionSpecJson: JSON.stringify(
              executionSpec({
                attemptId: decision.attemptId,
                executionRunId: decision.executionRunId,
                batchId: input.batchId,
                className: updatedRun.className,
                source,
                environment: environmentVariables(batch.environmentJson),
              }),
            ),
            availableAt: input.scheduledAt,
            claimDeadlineAt: addMilliseconds(input.scheduledAt, 5 * 60_000),
            createdAt: input.scheduledAt,
            updatedAt: input.scheduledAt,
          })
          .run();
        accepted += 1;
      }
      updateBatchSchedulingStatus(this.handle, input.batchId, input.scheduledAt);
      return accepted;
    })();
  }

  private async requiredBatch(batchId: string): Promise<RunBatchDetails> {
    const batch = await this.get(batchId);
    if (!batch) throw new Error(`Run batch ${batchId} does not exist after creation.`);
    return batch;
  }

  private async mapBatch(row: typeof runBatches.$inferSelect): Promise<RunBatch> {
    const selectedRunnerIds = this.handle.db
      .select({ runnerId: runBatchRunners.runnerId })
      .from(runBatchRunners)
      .where(eq(runBatchRunners.batchId, row.id))
      .orderBy(runBatchRunners.runnerId)
      .all()
      .map((runner) => runner.runnerId);
    const statusCounts = this.handle.db
      .select({ status: executionRuns.status, value: count() })
      .from(executionRuns)
      .where(eq(executionRuns.batchId, row.id))
      .groupBy(executionRuns.status)
      .all();
    const byStatus = new Map(statusCounts.map((entry) => [entry.status, entry.value]));
    const runOutcomes = this.handle.db
      .select({ status: executionRuns.status, terminalOutcome: executionRuns.terminalOutcome })
      .from(executionRuns)
      .where(eq(executionRuns.batchId, row.id))
      .all();
    return {
      id: row.id,
      suiteId: row.suiteId,
      suiteName: row.suiteName,
      suiteVersion: row.suiteVersion,
      status: row.status,
      retryLimit: row.retryLimit,
      environmentVariables: environmentVariables(row.environmentJson),
      selectedRunnerIds,
      totalRuns: row.totalRuns,
      queuedRuns: byStatus.get("queued") ?? 0,
      assignedRuns: (byStatus.get("assigned") ?? 0) + (byStatus.get("running") ?? 0),
      runningRuns: byStatus.get("running") ?? 0,
      succeededRuns: byStatus.get("succeeded") ?? 0,
      failedRuns: runOutcomes.filter(
        (run) => run.status === "failed" && run.terminalOutcome !== "timed_out",
      ).length,
      timedOutRuns: runOutcomes.filter((run) => run.terminalOutcome === "timed_out").length,
      cancelledRuns: byStatus.get("cancelled") ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

function executionSpec(input: {
  attemptId: string;
  executionRunId: string;
  batchId: string;
  className: string;
  source: { id: string; sha256: string; sizeBytes: number };
  environment: ExecutionEnvironmentVariable[];
}): ExecutionSpec {
  return {
    schemaVersion: 1,
    executor: "testng",
    attemptId: input.attemptId,
    executionRunId: input.executionRunId,
    batchId: input.batchId,
    className: input.className,
    methodDescriptors: [],
    inputs: [
      {
        inputId: input.source.id,
        kind: "test-jar",
        targetPath: "inputs/tests.jar",
        mediaType: "application/java-archive",
        sizeBytes: input.source.sizeBytes,
        sha256: input.source.sha256,
      },
    ],
    environment: input.environment.map((entry) => ({ ...entry, secret: false })),
    requiredLabels: ["java", "testng"],
    requiredCapabilities: ["executor:testng-v1"],
    timeoutMs: 3_600_000,
    uploadTimeoutMs: 600_000,
    resourceLimits: {
      cpuMillicores: 2_000,
      memoryBytes: 2_147_483_648,
      diskBytes: 10_737_418_240,
      processCount: 256,
      logBytes: 1_073_741_824,
      artifactBytes: 10_737_418_240,
    },
  };
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(new Date(timestamp).getTime() + milliseconds).toISOString();
}

function activeReservations(
  handle: SqliteDatabaseHandle,
  runnerIds: string[],
): Map<string, number> {
  if (runnerIds.length === 0) return new Map();
  return new Map(
    handle.db
      .select({ runnerId: runAttempts.runnerId, value: count() })
      .from(runAttempts)
      .where(
        and(
          inArray(runAttempts.runnerId, runnerIds),
          inArray(runAttempts.status, [...activeAttemptStatuses]),
        ),
      )
      .groupBy(runAttempts.runnerId)
      .all()
      .map((row) => [row.runnerId, row.value]),
  );
}

function updateBatchSchedulingStatus(
  handle: SqliteDatabaseHandle,
  batchId: string,
  updatedAt: string,
): void {
  const counts = handle.db
    .select({ status: executionRuns.status, value: count() })
    .from(executionRuns)
    .where(eq(executionRuns.batchId, batchId))
    .groupBy(executionRuns.status)
    .all();
  const byStatus = new Map(counts.map((entry) => [entry.status, entry.value]));
  const queued = byStatus.get("queued") ?? 0;
  const assigned = (byStatus.get("assigned") ?? 0) + (byStatus.get("running") ?? 0);
  const status: RunBatchStatus =
    queued === 0 ? "scheduled" : assigned > 0 ? "dispatching" : "queued";
  handle.db.update(runBatches).set({ status, updatedAt }).where(eq(runBatches.id, batchId)).run();
}

function environmentVariables(json: string): ExecutionEnvironmentVariable[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (value): value is ExecutionEnvironmentVariable =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { name?: unknown }).name === "string" &&
      typeof (value as { value?: unknown }).value === "string",
  );
}

function supportsTestNGExecution(capabilities: readonly string[]): boolean {
  return capabilities.includes("executor:testng-v1");
}

function toExecutionRun(row: typeof executionRuns.$inferSelect): ExecutionRun {
  return {
    id: row.id,
    batchId: row.batchId,
    caseDefinitionId: row.caseDefinitionId,
    caseVersion: row.caseVersion,
    displayName: row.displayName,
    className: row.className,
    status: row.status,
    ...(row.assignedRunnerId ? { assignedRunnerId: row.assignedRunnerId } : {}),
    attemptCount: row.attemptCount,
    ...(row.schedulingScore === null ? {} : { schedulingScore: row.schedulingScore }),
    ...(row.terminalOutcome ? { terminalOutcome: row.terminalOutcome } : {}),
    ...(row.cancelRequestedAt ? { cancelRequestedAt: row.cancelRequestedAt } : {}),
    version: row.version,
    createdAt: row.createdAt,
    ...(row.assignedAt ? { assignedAt: row.assignedAt } : {}),
    updatedAt: row.updatedAt,
  };
}

function toRunAttempt(row: typeof runAttempts.$inferSelect): RunAttempt {
  return {
    id: row.id,
    executionRunId: row.executionRunId,
    runnerId: row.runnerId,
    attemptNumber: row.attemptNumber,
    status: row.status,
    schedulingScore: row.schedulingScore,
    version: row.version,
    ...(row.startedAt ? { startedAt: row.startedAt } : {}),
    ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
    ...(row.outcome ? { outcome: row.outcome } : {}),
    ...(row.resultCode ? { resultCode: row.resultCode } : {}),
    ...(row.resultSummary ? { resultSummary: row.resultSummary } : {}),
    createdAt: row.createdAt,
  };
}
