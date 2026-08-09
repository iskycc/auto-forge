import type {
  CreateRunBatchRecord,
  ReserveSchedulingAssignmentsInput,
  RunBatchRepository,
  SchedulingSnapshot,
} from "@autoforge/application";
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
import { executionRuns, runAttempts, runBatchRunners, runBatches, runners } from "./schema";

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
    return {
      batch,
      queuedRuns: batch.runs.filter((run) => run.status === "queued"),
      candidates: runnerRows.map((row) => ({
        runner: mapStoredRunner(row, offlineBefore),
        reservedSlots: reservations.get(row.id) ?? 0,
      })),
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
        const evaluation = evaluateRunnerForScheduling(
          {
            runner: mapStoredRunner(runnerRow, input.offlineBefore),
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
          .returning({ attemptCount: executionRuns.attemptCount })
          .get();
        if (!updatedRun) continue;
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
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
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
    createdAt: row.createdAt,
  };
}
