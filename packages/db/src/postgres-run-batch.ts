import type {
  CreateRunBatchRecord,
  ReserveSchedulingAssignmentsInput,
  RunBatchRepository,
  SchedulingSnapshot,
} from "@autoforge/application";
import { testNgResultDetailsSchema, type ExecutionSpec } from "@autoforge/contracts";
import {
  assessRunnerCompatibility,
  DEFAULT_EXECUTION_RESOURCE_LIMITS,
  DomainError,
  evaluateRunnerForScheduling,
  MINIMUM_JAVA_MAJOR_VERSION,
  ON_DEMAND_SECRET_CAPABILITY,
  REQUIRED_EXECUTION_CAPABILITIES,
  REQUIRED_EXECUTION_LABELS,
  SUPPORTED_TESTNG_VERSION,
  transitionRunBatch,
  type ExecutionEnvironmentVariable,
  type ExecutionEnvironmentSecretBinding,
  type ExecutionRun,
  type RunAttempt,
  type RunBatch,
  type RunBatchDetails,
  type RunBatchStatusEvent,
  type RunBatchStatus,
} from "@autoforge/domain";
import { and, count, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

import type { PostgresDatabaseHandle } from "./postgres-database";
import {
  pgCaseDefinitions,
  pgCaseSources,
  pgExecutionRuns,
  pgAssignments,
  pgRunAttempts,
  pgRunBatchRunners,
  pgRunBatches,
  pgRunBatchStatusEvents,
  pgRunners,
} from "./postgres-schema";
import { mapStoredRunner } from "./runner-mapper";

const activeAttemptStatuses = ["assigned", "running"] as const;

export class PostgresRunBatchRepository implements RunBatchRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  async create(record: CreateRunBatchRecord): Promise<RunBatchDetails> {
    await this.ready();
    const queueTimeoutMs = record.queueTimeoutMs ?? 86_400_000;
    const claimTimeoutMs = record.claimTimeoutMs ?? 300_000;
    const executionTimeoutMs = record.executionTimeoutMs ?? 3_600_000;
    const uploadTimeoutMs = record.uploadTimeoutMs ?? 600_000;
    await this.handle.db.transaction(async (transaction) => {
      await transaction.insert(pgRunBatches).values({
        id: record.id,
        projectId: record.projectId,
        environmentId: record.environmentId,
        environmentVersionId: record.environmentVersionId,
        suiteId: record.suiteId,
        suiteName: record.suiteName,
        suiteVersion: record.suiteVersion,
        status: "queued",
        retryLimit: record.retryLimit,
        queueTimeoutMs,
        claimTimeoutMs,
        executionTimeoutMs,
        uploadTimeoutMs,
        environmentJson: JSON.stringify(record.environmentVariables),
        secretBindingsJson: JSON.stringify(record.secretBindings ?? []),
        totalRuns: record.runs.length,
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
      });
      await transaction.insert(pgRunBatchStatusEvents).values({
        id: record.eventId ?? record.id,
        batchId: record.id,
        fromStatus: null,
        toStatus: "queued",
        batchVersion: 1,
        reason: "batch.created",
        recordedAt: record.createdAt,
      });
      await transaction
        .insert(pgRunBatchRunners)
        .values(record.runnerIds.map((runnerId) => ({ batchId: record.id, runnerId })));
      await transaction.insert(pgExecutionRuns).values(
        record.runs.map((run) => ({
          ...run,
          batchId: record.id,
          status: "queued" as const,
          assignedRunnerId: null,
          attemptCount: 0,
          schedulingScore: null,
          queueDeadlineAt: addMilliseconds(record.createdAt, queueTimeoutMs),
          executionTimeoutMs,
          uploadTimeoutMs,
          createdAt: record.createdAt,
          assignedAt: null,
          updatedAt: record.createdAt,
        })),
      );
      if (record.dispatchJob) {
        await transaction.execute(sql`
          INSERT INTO transactional_outbox
            (message_id, run_id, attempt, schema_version, subject, payload_json,
             deduplication_key, created_at, available_at)
          VALUES
            (${record.dispatchJob.messageId}, ${record.dispatchJob.runId},
             ${record.dispatchJob.attempt}, ${record.dispatchJob.schemaVersion},
             ${"autoforge.jobs.v1.ready"},
             ${JSON.stringify(record.dispatchJob)}::jsonb,
             ${record.dispatchJob.deduplicationKey}, ${record.dispatchJob.createdAt},
             ${record.dispatchJob.createdAt})
        `);
      }
    });
    return this.requiredBatch(record.id);
  }

  async list(limit: number, projectIds?: readonly string[]): Promise<RunBatch[]> {
    await this.ready();
    if (projectIds?.length === 0) return [];
    const rows = await this.handle.db
      .select()
      .from(pgRunBatches)
      .where(projectIds ? inArray(pgRunBatches.projectId, [...projectIds]) : undefined)
      .orderBy(desc(pgRunBatches.createdAt))
      .limit(limit);
    return Promise.all(rows.map((row) => this.mapBatch(row)));
  }

  async get(batchId: string, projectIds?: readonly string[]): Promise<RunBatchDetails | null> {
    await this.ready();
    if (projectIds?.length === 0) return null;
    const [batchRow] = await this.handle.db
      .select()
      .from(pgRunBatches)
      .where(
        projectIds
          ? and(eq(pgRunBatches.id, batchId), inArray(pgRunBatches.projectId, [...projectIds]))
          : eq(pgRunBatches.id, batchId),
      )
      .limit(1);
    if (!batchRow) return null;
    const runRows = await this.handle.db
      .select()
      .from(pgExecutionRuns)
      .where(eq(pgExecutionRuns.batchId, batchId))
      .orderBy(pgExecutionRuns.createdAt, pgExecutionRuns.id);
    const attemptRows =
      runRows.length === 0
        ? []
        : await this.handle.db
            .select()
            .from(pgRunAttempts)
            .where(
              inArray(
                pgRunAttempts.executionRunId,
                runRows.map((run) => run.id),
              ),
            )
            .orderBy(pgRunAttempts.createdAt, pgRunAttempts.id);
    const statusHistory = (
      await this.handle.db
        .select()
        .from(pgRunBatchStatusEvents)
        .where(eq(pgRunBatchStatusEvents.batchId, batchId))
        .orderBy(pgRunBatchStatusEvents.recordedAt, pgRunBatchStatusEvents.id)
    ).map(toRunBatchStatusEvent);
    return {
      ...(await this.mapBatch(batchRow)),
      runs: runRows.map(toExecutionRun),
      attempts: attemptRows.map(toRunAttempt),
      statusHistory,
    };
  }

  async listSchedulableBatchIds(limit: number): Promise<string[]> {
    await this.ready();
    return (
      await this.handle.db
        .select({ id: pgRunBatches.id })
        .from(pgRunBatches)
        .where(inArray(pgRunBatches.status, ["queued", "dispatching"]))
        .orderBy(pgRunBatches.createdAt)
        .limit(limit)
    ).map((row) => row.id);
  }

  async listSchedulableBatchIdsForRunner(runnerId: string, limit: number): Promise<string[]> {
    await this.ready();
    return (
      await this.handle.db
        .select({ id: pgRunBatches.id })
        .from(pgRunBatches)
        .innerJoin(pgRunBatchRunners, eq(pgRunBatchRunners.batchId, pgRunBatches.id))
        .where(
          and(
            eq(pgRunBatchRunners.runnerId, runnerId),
            inArray(pgRunBatches.status, ["queued", "dispatching"]),
          ),
        )
        .orderBy(pgRunBatches.createdAt)
        .limit(limit)
    ).map((row) => row.id);
  }

  async getSchedulingSnapshot(
    batchId: string,
    offlineBefore: string,
  ): Promise<SchedulingSnapshot | null> {
    const batch = await this.get(batchId);
    if (!batch) return null;
    const runnerRows =
      batch.selectedRunnerIds.length === 0
        ? []
        : await this.handle.db
            .select()
            .from(pgRunners)
            .where(inArray(pgRunners.id, batch.selectedRunnerIds));
    const reservations = await this.activeReservations(batch.selectedRunnerIds);
    const candidates = runnerRows.map((row) => ({
      runner: mapStoredRunner(row, offlineBefore),
      reservedSlots: reservations.get(row.id) ?? 0,
    }));
    return {
      batch,
      queuedRuns: batch.runs.filter((run) => run.status === "queued"),
      candidates,
    };
  }

  async reserveAssignments(input: ReserveSchedulingAssignmentsInput): Promise<number> {
    await this.ready();
    return this.handle.db.transaction(async (transaction) => {
      const selectedRunnerIds = new Set(
        (
          await transaction
            .select({ runnerId: pgRunBatchRunners.runnerId })
            .from(pgRunBatchRunners)
            .where(eq(pgRunBatchRunners.batchId, input.batchId))
        ).map((row) => row.runnerId),
      );
      const decisionRunnerIds = [...new Set(input.decisions.map((decision) => decision.runnerId))]
        .filter((runnerId) => selectedRunnerIds.has(runnerId))
        .sort();
      const lockedRunners =
        decisionRunnerIds.length === 0
          ? []
          : await transaction
              .select()
              .from(pgRunners)
              .where(inArray(pgRunners.id, decisionRunnerIds))
              .orderBy(pgRunners.id)
              .for("update");
      const runnerById = new Map(lockedRunners.map((runner) => [runner.id, runner]));
      const reservations =
        decisionRunnerIds.length === 0
          ? new Map<string, number>()
          : new Map(
              (
                await transaction
                  .select({ runnerId: pgRunAttempts.runnerId, value: count() })
                  .from(pgRunAttempts)
                  .where(
                    and(
                      inArray(pgRunAttempts.runnerId, decisionRunnerIds),
                      inArray(pgRunAttempts.status, [...activeAttemptStatuses]),
                    ),
                  )
                  .groupBy(pgRunAttempts.runnerId)
              ).map((row) => [row.runnerId, row.value]),
            );

      let accepted = 0;
      for (const decision of input.decisions) {
        const runnerRow = runnerById.get(decision.runnerId);
        if (!runnerRow) continue;
        const runner = mapStoredRunner(runnerRow, input.offlineBefore);
        if (!assessRunnerCompatibility(runner).compatible) continue;
        const evaluation = evaluateRunnerForScheduling(
          {
            runner,
            reservedSlots: reservations.get(decision.runnerId) ?? 0,
          },
          input.thresholds,
          input.metricsFreshAfter,
        );
        if (!evaluation.eligible || evaluation.score === undefined) continue;
        const [updatedRun] = await transaction
          .update(pgExecutionRuns)
          .set({
            status: "assigned",
            assignedRunnerId: decision.runnerId,
            attemptCount: sql`${pgExecutionRuns.attemptCount} + 1`,
            schedulingScore: evaluation.score,
            assignedAt: input.scheduledAt,
            updatedAt: input.scheduledAt,
          })
          .where(
            and(
              eq(pgExecutionRuns.id, decision.executionRunId),
              eq(pgExecutionRuns.batchId, input.batchId),
              eq(pgExecutionRuns.status, "queued"),
              or(
                isNull(pgExecutionRuns.queueDeadlineAt),
                gt(pgExecutionRuns.queueDeadlineAt, input.scheduledAt),
              ),
            ),
          )
          .returning({
            attemptCount: pgExecutionRuns.attemptCount,
            caseDefinitionId: pgExecutionRuns.caseDefinitionId,
            className: pgExecutionRuns.className,
          });
        if (!updatedRun) continue;
        const [source] = await transaction
          .select({
            id: pgCaseSources.id,
            sha256: pgCaseSources.sha256,
            sizeBytes: pgCaseSources.sizeBytes,
          })
          .from(pgCaseDefinitions)
          .innerJoin(pgCaseSources, eq(pgCaseSources.id, pgCaseDefinitions.sourceId))
          .where(eq(pgCaseDefinitions.id, updatedRun.caseDefinitionId))
          .limit(1);
        if (!source) throw new Error("Cannot schedule a case without its source JAR.");
        await transaction.insert(pgRunAttempts).values({
          id: decision.attemptId,
          executionRunId: decision.executionRunId,
          runnerId: decision.runnerId,
          attemptNumber: updatedRun.attemptCount,
          status: "assigned",
          schedulingScore: evaluation.score,
          createdAt: input.scheduledAt,
        });
        const [batch] = await transaction
          .select({
            environmentJson: pgRunBatches.environmentJson,
            secretBindingsJson: pgRunBatches.secretBindingsJson,
            priority: pgRunBatches.priority,
            claimTimeoutMs: pgRunBatches.claimTimeoutMs,
            executionTimeoutMs: pgRunBatches.executionTimeoutMs,
            uploadTimeoutMs: pgRunBatches.uploadTimeoutMs,
          })
          .from(pgRunBatches)
          .where(eq(pgRunBatches.id, input.batchId))
          .limit(1);
        if (!batch) continue;
        await transaction.insert(pgAssignments).values({
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
              secretBindings: secretBindings(batch.secretBindingsJson),
              executionTimeoutMs: batch.executionTimeoutMs,
              uploadTimeoutMs: batch.uploadTimeoutMs,
            }),
          ),
          availableAt: input.scheduledAt,
          claimDeadlineAt: addMilliseconds(input.scheduledAt, batch.claimTimeoutMs),
          createdAt: input.scheduledAt,
          updatedAt: input.scheduledAt,
        });
        reservations.set(decision.runnerId, (reservations.get(decision.runnerId) ?? 0) + 1);
        accepted += 1;
      }

      const counts = await transaction
        .select({ status: pgExecutionRuns.status, value: count() })
        .from(pgExecutionRuns)
        .where(eq(pgExecutionRuns.batchId, input.batchId))
        .groupBy(pgExecutionRuns.status);
      const byStatus = new Map(counts.map((entry) => [entry.status, entry.value]));
      const queued = byStatus.get("queued") ?? 0;
      const assigned = (byStatus.get("assigned") ?? 0) + (byStatus.get("running") ?? 0);
      const status: RunBatchStatus =
        queued === 0 ? "scheduled" : assigned > 0 ? "dispatching" : "queued";
      const [batchState] = await transaction
        .select({ status: pgRunBatches.status, version: pgRunBatches.version })
        .from(pgRunBatches)
        .where(eq(pgRunBatches.id, input.batchId))
        .for("update");
      if (!batchState) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
      transitionRunBatch(batchState.status, status);
      const nextVersion = batchState.version + 1;
      const [updatedBatch] = await transaction
        .update(pgRunBatches)
        .set({ status, updatedAt: input.scheduledAt, version: nextVersion })
        .where(
          and(eq(pgRunBatches.id, input.batchId), eq(pgRunBatches.version, batchState.version)),
        )
        .returning({ id: pgRunBatches.id });
      if (!updatedBatch) {
        throw new DomainError("RUN_BATCH_VERSION_CONFLICT", "执行批次已被并发修改。");
      }
      if (batchState.status !== status) {
        await transaction.insert(pgRunBatchStatusEvents).values({
          id: input.eventId ?? input.decisions[0]?.assignmentId ?? input.batchId,
          batchId: input.batchId,
          fromStatus: batchState.status,
          toStatus: status,
          batchVersion: nextVersion,
          reason: "scheduling.updated",
          recordedAt: input.scheduledAt,
        });
      }
      return accepted;
    });
  }

  private async ready(): Promise<void> {
    await this.handle.ready;
  }

  private async requiredBatch(batchId: string): Promise<RunBatchDetails> {
    const batch = await this.get(batchId);
    if (!batch) throw new Error(`Run batch ${batchId} does not exist after creation.`);
    return batch;
  }

  private async mapBatch(row: typeof pgRunBatches.$inferSelect): Promise<RunBatch> {
    const [selectedRunners, statusCounts] = await Promise.all([
      this.handle.db
        .select({ runnerId: pgRunBatchRunners.runnerId })
        .from(pgRunBatchRunners)
        .where(eq(pgRunBatchRunners.batchId, row.id))
        .orderBy(pgRunBatchRunners.runnerId),
      this.handle.db
        .select({ status: pgExecutionRuns.status, value: count() })
        .from(pgExecutionRuns)
        .where(eq(pgExecutionRuns.batchId, row.id))
        .groupBy(pgExecutionRuns.status),
    ]);
    const byStatus = new Map(statusCounts.map((entry) => [entry.status, entry.value]));
    const runOutcomes = await this.handle.db
      .select({ status: pgExecutionRuns.status, terminalOutcome: pgExecutionRuns.terminalOutcome })
      .from(pgExecutionRuns)
      .where(eq(pgExecutionRuns.batchId, row.id));
    return {
      id: row.id,
      projectId: row.projectId,
      ...(row.environmentId ? { environmentId: row.environmentId } : {}),
      ...(row.environmentVersionId ? { environmentVersionId: row.environmentVersionId } : {}),
      suiteId: row.suiteId,
      suiteName: row.suiteName,
      suiteVersion: row.suiteVersion,
      status: row.status,
      retryLimit: row.retryLimit,
      queueTimeoutMs: row.queueTimeoutMs,
      claimTimeoutMs: row.claimTimeoutMs,
      executionTimeoutMs: row.executionTimeoutMs,
      uploadTimeoutMs: row.uploadTimeoutMs,
      environmentVariables: environmentVariables(row.environmentJson),
      secretBindings: secretBindings(row.secretBindingsJson),
      selectedRunnerIds: selectedRunners.map((runner) => runner.runnerId),
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
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async activeReservations(runnerIds: string[]): Promise<Map<string, number>> {
    if (runnerIds.length === 0) return new Map();
    return new Map(
      (
        await this.handle.db
          .select({ runnerId: pgRunAttempts.runnerId, value: count() })
          .from(pgRunAttempts)
          .where(
            and(
              inArray(pgRunAttempts.runnerId, runnerIds),
              inArray(pgRunAttempts.status, [...activeAttemptStatuses]),
            ),
          )
          .groupBy(pgRunAttempts.runnerId)
      ).map((row) => [row.runnerId, row.value]),
    );
  }
}

function toRunBatchStatusEvent(
  row: typeof pgRunBatchStatusEvents.$inferSelect,
): RunBatchStatusEvent {
  return {
    id: row.id,
    batchId: row.batchId,
    ...(row.fromStatus ? { fromStatus: row.fromStatus } : {}),
    toStatus: row.toStatus,
    batchVersion: row.batchVersion,
    reason: row.reason,
    recordedAt: row.recordedAt,
  };
}

function executionSpec(input: {
  attemptId: string;
  executionRunId: string;
  batchId: string;
  className: string;
  source: { id: string; sha256: string; sizeBytes: number };
  environment: ExecutionEnvironmentVariable[];
  secretBindings: ExecutionEnvironmentSecretBinding[];
  executionTimeoutMs: number;
  uploadTimeoutMs: number;
}): ExecutionSpec {
  return {
    schemaVersion: 1,
    executor: "testng",
    attemptId: input.attemptId,
    executionRunId: input.executionRunId,
    batchId: input.batchId,
    className: input.className,
    methodDescriptors: [],
    parameters: {},
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
    secretReferences: input.secretBindings,
    runtimeRequirements: {
      os: "linux",
      architectures: ["amd64", "arm64"],
      minimumJavaMajorVersion: MINIMUM_JAVA_MAJOR_VERSION,
      testNgVersion: SUPPORTED_TESTNG_VERSION,
    },
    requiredLabels: [...REQUIRED_EXECUTION_LABELS],
    requiredCapabilities: [
      ...REQUIRED_EXECUTION_CAPABILITIES,
      ...(input.secretBindings.length > 0 ? [ON_DEMAND_SECRET_CAPABILITY] : []),
    ],
    artifactRules: [
      { pattern: "reports/testng/**", required: false, mediaType: "application/xml" },
    ],
    timeoutMs: input.executionTimeoutMs,
    uploadTimeoutMs: input.uploadTimeoutMs,
    resourceLimits: { ...DEFAULT_EXECUTION_RESOURCE_LIMITS },
  };
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(new Date(timestamp).getTime() + milliseconds).toISOString();
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

function secretBindings(json: string): ExecutionEnvironmentSecretBinding[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (value): value is ExecutionEnvironmentSecretBinding =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { name?: unknown }).name === "string" &&
      typeof (value as { secretId?: unknown }).secretId === "string" &&
      typeof (value as { secretVersionId?: unknown }).secretVersionId === "string",
  );
}

function toExecutionRun(row: typeof pgExecutionRuns.$inferSelect): ExecutionRun {
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
    ...(row.terminalReasonCode ? { terminalReasonCode: row.terminalReasonCode } : {}),
    ...(row.cancelRequestedAt ? { cancelRequestedAt: row.cancelRequestedAt } : {}),
    version: row.version,
    createdAt: row.createdAt,
    ...(row.assignedAt ? { assignedAt: row.assignedAt } : {}),
    updatedAt: row.updatedAt,
  };
}

function toRunAttempt(row: typeof pgRunAttempts.$inferSelect): RunAttempt {
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
    ...(row.durationMs === null ? {} : { durationMs: row.durationMs }),
    ...(row.testNgResultJson ? { testNg: storedTestNgResult(row.testNgResultJson, row.id) } : {}),
    createdAt: row.createdAt,
  };
}

function storedTestNgResult(json: string, attemptId: string): NonNullable<RunAttempt["testNg"]> {
  try {
    return testNgResultDetailsSchema.parse(JSON.parse(json));
  } catch (error) {
    throw new DomainError(
      "STORED_TESTNG_RESULT_INVALID",
      `执行尝试 ${attemptId} 的 TestNG 结果无法读取。`,
      { cause: error },
    );
  }
}
