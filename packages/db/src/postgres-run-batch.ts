import type {
  CreateRunBatchRecord,
  ReserveSchedulingAssignmentsInput,
  RunBatchListQuery,
  RunBatchRepository,
  SchedulingSnapshot,
} from "@autoforge/application";
import { testNgResultDetailsSchema, type ExecutionSpec } from "@autoforge/contracts";
import {
  artifactMediaType,
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
  type RunBatchExecutionPolicy,
  type RunBatchStatusEvent,
  type RunBatchStatus,
} from "@autoforge/domain";
import { and, count, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import type { PostgresDatabaseHandle } from "./postgres-database";
import {
  pgCaseSources,
  pgCaseVersions,
  pgExecutionRuns,
  pgAssignments,
  pgRunAttempts,
  pgRunBatchRunners,
  pgRunBatches,
  pgRunBatchStatusEvents,
  pgRunners,
  pgProjects,
} from "./postgres-schema";
import { mapStoredRunner } from "./runner-mapper";
import { decodeRunBatchCursor, encodeRunBatchCursor } from "./run-batch-list";

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
        priority: record.priority ?? 0,
        queueTimeoutMs,
        claimTimeoutMs,
        executionTimeoutMs,
        uploadTimeoutMs,
        environmentJson: JSON.stringify(record.environmentVariables),
        secretBindingsJson: JSON.stringify(record.secretBindings ?? []),
        policyJson: record.policy ? JSON.stringify(record.policy) : null,
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
          parametersJson: JSON.stringify(run.parameters ?? {}),
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

  async listPage(input: RunBatchListQuery) {
    await this.ready();
    if (input.projectIds?.length === 0) return { items: [] };
    const cursor = decodeRunBatchCursor(input.cursor);
    const conditions = [
      ...(input.projectIds ? [inArray(pgRunBatches.projectId, [...input.projectIds])] : []),
      ...(input.projectId ? [eq(pgRunBatches.projectId, input.projectId)] : []),
      ...(input.suiteId ? [eq(pgRunBatches.suiteId, input.suiteId)] : []),
      ...(input.status ? [eq(pgRunBatches.status, input.status)] : []),
      ...(input.createdAfter ? [gte(pgRunBatches.createdAt, input.createdAfter)] : []),
      ...(input.createdBefore ? [lte(pgRunBatches.createdAt, input.createdBefore)] : []),
      ...(cursor
        ? [
            or(
              lt(pgRunBatches.createdAt, cursor.createdAt),
              and(eq(pgRunBatches.createdAt, cursor.createdAt), lt(pgRunBatches.id, cursor.id)),
            )!,
          ]
        : []),
      ...(input.caseDefinitionId
        ? [
            sql`EXISTS (SELECT 1 FROM execution_runs run WHERE run.batch_id = ${pgRunBatches.id} AND run.case_definition_id = ${input.caseDefinitionId})`,
          ]
        : []),
      ...(input.runnerId
        ? [
            sql`EXISTS (SELECT 1 FROM execution_runs run WHERE run.batch_id = ${pgRunBatches.id} AND run.assigned_runner_id = ${input.runnerId})`,
          ]
        : []),
    ];
    const rows = await this.handle.db
      .select()
      .from(pgRunBatches)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(pgRunBatches.createdAt), desc(pgRunBatches.id))
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const pageRows = rows.slice(0, input.limit);
    const items = await Promise.all(pageRows.map((row) => this.mapBatch(row)));
    const last = pageRows.at(-1);
    return {
      items,
      ...(hasMore && last
        ? { nextCursor: encodeRunBatchCursor({ createdAt: last.createdAt, id: last.id }) }
        : {}),
    };
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

  async listSchedulableBatchIds(
    limit: number,
    now = new Date().toISOString(),
    agingIntervalMinutes = 5,
  ): Promise<string[]> {
    await this.ready();
    const result = await this.handle.pool.query<{ id: string }>(
      `SELECT id FROM run_batches WHERE status IN ('queued','dispatching')
       ORDER BY priority + LEAST(100, GREATEST(0, FLOOR(
         EXTRACT(EPOCH FROM ($1::timestamptz-created_at::timestamptz)) / 60 / $2
       ))) DESC, created_at, id LIMIT $3`,
      [now, agingIntervalMinutes, limit],
    );
    return result.rows.map((row) => row.id);
  }

  async listSchedulableBatchIdsForRunner(
    runnerId: string,
    limit: number,
    now = new Date().toISOString(),
    agingIntervalMinutes = 5,
  ): Promise<string[]> {
    await this.ready();
    const result = await this.handle.pool.query<{ id: string }>(
      `SELECT b.id FROM run_batches b JOIN run_batch_runners br ON br.batch_id=b.id
       WHERE br.runner_id=$1 AND b.status IN ('queued','dispatching')
       ORDER BY b.priority + LEAST(100, GREATEST(0, FLOOR(
         EXTRACT(EPOCH FROM ($2::timestamptz-b.created_at::timestamptz)) / 60 / $3
       ))) DESC, b.created_at, b.id LIMIT $4`,
      [runnerId, now, agingIntervalMinutes, limit],
    );
    return result.rows.map((row) => row.id);
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
    const [reservations, activeProjectRuns] = await Promise.all([
      this.activeReservations(batch.selectedRunnerIds),
      this.handle.pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM run_attempts a
         JOIN execution_runs r ON r.id=a.execution_run_id
         JOIN run_batches b ON b.id=r.batch_id
         WHERE b.project_id=$1 AND a.status IN ('assigned','running')`,
        [batch.projectId],
      ),
    ]);
    const candidates = runnerRows.map((row) => ({
      runner: mapStoredRunner(row, offlineBefore),
      reservedSlots: reservations.get(row.id) ?? 0,
    }));
    return {
      batch,
      queuedRuns: batch.runs.filter((run) => run.status === "queued"),
      candidates,
      projectActiveRuns: Number(activeProjectRuns.rows[0]?.count ?? 0),
    };
  }

  async reserveAssignments(input: ReserveSchedulingAssignmentsInput): Promise<number> {
    await this.ready();
    return this.handle.db.transaction(async (transaction) => {
      const [lockedBatch] = await transaction
        .select({ projectId: pgRunBatches.projectId, policyJson: pgRunBatches.policyJson })
        .from(pgRunBatches)
        .where(eq(pgRunBatches.id, input.batchId))
        .for("update");
      if (!lockedBatch) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
      await transaction
        .select({ id: pgProjects.id })
        .from(pgProjects)
        .where(eq(pgProjects.id, lockedBatch.projectId))
        .for("update");
      const [projectActive, batchActive] = await Promise.all([
        transaction
          .select({ value: count() })
          .from(pgRunAttempts)
          .innerJoin(pgExecutionRuns, eq(pgExecutionRuns.id, pgRunAttempts.executionRunId))
          .innerJoin(pgRunBatches, eq(pgRunBatches.id, pgExecutionRuns.batchId))
          .where(
            and(
              eq(pgRunBatches.projectId, lockedBatch.projectId),
              inArray(pgRunAttempts.status, [...activeAttemptStatuses]),
            ),
          ),
        transaction
          .select({ value: count() })
          .from(pgRunAttempts)
          .innerJoin(pgExecutionRuns, eq(pgExecutionRuns.id, pgRunAttempts.executionRunId))
          .where(
            and(
              eq(pgExecutionRuns.batchId, input.batchId),
              inArray(pgRunAttempts.status, [...activeAttemptStatuses]),
            ),
          ),
      ]);
      let remainingProjectSlots = Math.max(
        0,
        (input.projectMaximumConcurrency ?? Number.MAX_SAFE_INTEGER) -
          Number(projectActive[0]?.value ?? 0),
      );
      const batchConcurrency = batchPolicy(lockedBatch.policyJson)?.concurrency;
      let remainingBatchSlots =
        batchConcurrency === undefined
          ? Number.POSITIVE_INFINITY
          : Math.max(0, batchConcurrency - Number(batchActive[0]?.value ?? 0));
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
        if (remainingProjectSlots === 0 || remainingBatchSlots === 0) break;
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
            caseVersion: pgExecutionRuns.caseVersion,
            className: pgExecutionRuns.className,
            parametersJson: pgExecutionRuns.parametersJson,
          });
        if (!updatedRun) continue;
        const [source] = await transaction
          .select({
            id: pgCaseSources.id,
            sha256: pgCaseSources.sha256,
            sizeBytes: pgCaseSources.sizeBytes,
          })
          .from(pgCaseVersions)
          .innerJoin(pgCaseSources, eq(pgCaseSources.id, pgCaseVersions.sourceId))
          .where(
            and(
              eq(pgCaseVersions.caseDefinitionId, updatedRun.caseDefinitionId),
              eq(pgCaseVersions.version, updatedRun.caseVersion),
            ),
          )
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
            policyJson: pgRunBatches.policyJson,
            priority: pgRunBatches.priority,
            claimTimeoutMs: pgRunBatches.claimTimeoutMs,
            executionTimeoutMs: pgRunBatches.executionTimeoutMs,
            uploadTimeoutMs: pgRunBatches.uploadTimeoutMs,
          })
          .from(pgRunBatches)
          .where(eq(pgRunBatches.id, input.batchId))
          .limit(1);
        if (!batch) continue;
        const policy = batchPolicy(batch.policyJson);
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
              parameters: stringRecord(updatedRun.parametersJson),
              source,
              environment: environmentVariables(batch.environmentJson),
              secretBindings: secretBindings(batch.secretBindingsJson),
              executionTimeoutMs: batch.executionTimeoutMs,
              uploadTimeoutMs: batch.uploadTimeoutMs,
              ...(policy ? { policy } : {}),
            }),
          ),
          availableAt: input.scheduledAt,
          claimDeadlineAt: addMilliseconds(input.scheduledAt, batch.claimTimeoutMs),
          createdAt: input.scheduledAt,
          updatedAt: input.scheduledAt,
        });
        reservations.set(decision.runnerId, (reservations.get(decision.runnerId) ?? 0) + 1);
        remainingProjectSlots -= 1;
        remainingBatchSlots -= 1;
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
    const policy = batchPolicy(row.policyJson);
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
      priority: row.priority,
      retryLimit: row.retryLimit,
      queueTimeoutMs: row.queueTimeoutMs,
      claimTimeoutMs: row.claimTimeoutMs,
      executionTimeoutMs: row.executionTimeoutMs,
      uploadTimeoutMs: row.uploadTimeoutMs,
      environmentVariables: environmentVariables(row.environmentJson),
      secretBindings: secretBindings(row.secretBindingsJson),
      selectedRunnerIds: selectedRunners.map((runner) => runner.runnerId),
      ...(policy ? { policy } : {}),
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

// policy_json 为 NULL（历史数据）时返回 undefined，保留旧行为。
function batchPolicy(json: string | null): RunBatchExecutionPolicy | undefined {
  if (!json) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const concurrency = record.concurrency;
    return {
      executor: record.executor === "testng-container" ? "testng-container" : "testng",
      concurrency:
        typeof concurrency === "number" && Number.isInteger(concurrency) && concurrency >= 1
          ? concurrency
          : 4,
      runnerLabels: Array.isArray(record.runnerLabels)
        ? record.runnerLabels.filter((label): label is string => typeof label === "string")
        : [],
      artifactPatterns: Array.isArray(record.artifactPatterns)
        ? record.artifactPatterns.filter(
            (pattern): pattern is string => typeof pattern === "string",
          )
        : ["reports/testng/**"],
    };
  } catch {
    return undefined;
  }
}

function executionSpec(input: {
  attemptId: string;
  executionRunId: string;
  batchId: string;
  className: string;
  parameters: Record<string, string>;
  source: { id: string; sha256: string; sizeBytes: number };
  environment: ExecutionEnvironmentVariable[];
  secretBindings: ExecutionEnvironmentSecretBinding[];
  executionTimeoutMs: number;
  uploadTimeoutMs: number;
  policy?: RunBatchExecutionPolicy;
}): ExecutionSpec {
  const artifactPatterns = input.policy?.artifactPatterns ?? ["reports/testng/**"];
  return {
    schemaVersion: 1,
    executor: input.policy?.executor ?? "testng",
    attemptId: input.attemptId,
    executionRunId: input.executionRunId,
    batchId: input.batchId,
    className: input.className,
    methodDescriptors: [],
    parameters: input.parameters,
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
    requiredLabels: [...REQUIRED_EXECUTION_LABELS, ...(input.policy?.runnerLabels ?? [])],
    requiredCapabilities: [
      ...REQUIRED_EXECUTION_CAPABILITIES,
      ...(input.policy?.executor === "testng-container" ? ["executor:testng-container-v1"] : []),
      ...(input.secretBindings.length > 0 ? [ON_DEMAND_SECRET_CAPABILITY] : []),
    ],
    artifactRules: artifactPatterns.map((pattern) => ({
      pattern,
      required: false,
      mediaType: artifactMediaType(pattern),
    })),
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

function stringRecord(json: string): Record<string, string> {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
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
