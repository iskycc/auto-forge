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
  DEFAULT_PROJECT_ID,
  DomainError,
  evaluateRunnerForScheduling,
  MINIMUM_JAVA_MAJOR_VERSION,
  ON_DEMAND_SECRET_CAPABILITY,
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
  type SchedulingEvent,
  type SchedulingEventType,
} from "@autoforge/domain";
import { and, count, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import type { SqliteDatabaseHandle } from "./database";
import {
  adapterEnvironmentAddress,
  executionResourceLimitsForInputs,
  parseProjectAdapterRuntime,
  projectAdapterRequiredCapabilities,
  supportsProjectAdapterRuntime,
  type ProjectAdapterRuntime,
  type RuntimeAssetSnapshot,
} from "./project-adapter-runtime";
import { mapStoredRunner } from "./runner-mapper";
import { decodeRunBatchCursor, encodeRunBatchCursor } from "./run-batch-list";
import {
  assignments,
  caseSources,
  caseVersions,
  executionRuns,
  runAttempts,
  runBatchRunners,
  runBatches,
  runBatchStatusEvents,
  runners,
} from "./schema";

const activeAttemptStatuses = ["assigned", "running"] as const;

export class SqliteRunBatchRepository implements RunBatchRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async create(record: CreateRunBatchRecord): Promise<RunBatchDetails> {
    const queueTimeoutMs = record.queueTimeoutMs ?? 86_400_000;
    const claimTimeoutMs = record.claimTimeoutMs ?? 300_000;
    const executionTimeoutMs = record.executionTimeoutMs ?? 3_600_000;
    const uploadTimeoutMs = record.uploadTimeoutMs ?? 600_000;
    const adapterRuntime = projectAdapterRuntime(
      this.handle,
      record.projectId ?? DEFAULT_PROJECT_ID,
      record.adapter,
      record.runs,
    );
    this.handle.client.transaction(() => {
      this.handle.db
        .insert(runBatches)
        .values({
          id: record.id,
          projectId: record.projectId,
          environmentId: record.environmentId,
          environmentVersionId: record.environmentVersionId,
          suiteId: record.suiteId,
          suiteName: record.suiteName,
          suiteVersion: record.suiteVersion,
          status: "queued",
          retryLimit: record.retryLimit,
          retryMode: record.retryMode ?? "immediate",
          priority: record.priority ?? 0,
          queueTimeoutMs,
          claimTimeoutMs,
          executionTimeoutMs,
          uploadTimeoutMs,
          environmentJson: JSON.stringify(record.environmentVariables),
          secretBindingsJson: JSON.stringify(record.secretBindings ?? []),
          policyJson: record.policy ? JSON.stringify(record.policy) : null,
          adapterRuntimeJson: adapterRuntime ? JSON.stringify(adapterRuntime) : null,
          totalRuns: record.runs.length,
          createdAt: record.createdAt,
          updatedAt: record.createdAt,
        })
        .run();
      this.handle.db
        .insert(runBatchStatusEvents)
        .values({
          id: record.eventId ?? record.id,
          batchId: record.id,
          fromStatus: null,
          toStatus: "queued",
          batchVersion: 1,
          reason: "batch.created",
          recordedAt: record.createdAt,
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
        )
        .run();
      if (record.dispatchJob) {
        this.handle.client
          .prepare(
            `INSERT INTO queue_jobs
             (message_id, run_id, attempt, schema_version, kind, payload_json, priority,
              deduplication_key, status, available_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)`,
          )
          .run(
            record.dispatchJob.messageId,
            record.dispatchJob.runId,
            record.dispatchJob.attempt,
            record.dispatchJob.schemaVersion,
            record.dispatchJob.kind,
            JSON.stringify(record.dispatchJob.payload),
            record.dispatchJob.priority,
            record.dispatchJob.deduplicationKey,
            record.dispatchJob.createdAt,
            record.dispatchJob.createdAt,
            record.dispatchJob.createdAt,
          );
      }
    })();
    return this.requiredBatch(record.id);
  }

  async list(limit: number, projectIds?: readonly string[]): Promise<RunBatch[]> {
    if (projectIds?.length === 0) return [];
    const rows = this.handle.db
      .select()
      .from(runBatches)
      .where(projectIds ? inArray(runBatches.projectId, [...projectIds]) : undefined)
      .orderBy(desc(runBatches.createdAt))
      .limit(limit)
      .all();
    return Promise.all(rows.map((row) => this.mapBatch(row)));
  }

  async listPage(input: RunBatchListQuery) {
    if (input.projectIds?.length === 0) return { items: [] };
    const cursor = decodeRunBatchCursor(input.cursor);
    const conditions = [
      ...(input.projectIds ? [inArray(runBatches.projectId, [...input.projectIds])] : []),
      ...(input.projectId ? [eq(runBatches.projectId, input.projectId)] : []),
      ...(input.suiteId ? [eq(runBatches.suiteId, input.suiteId)] : []),
      ...(input.status ? [eq(runBatches.status, input.status)] : []),
      ...(input.createdAfter ? [gte(runBatches.createdAt, input.createdAfter)] : []),
      ...(input.createdBefore ? [lte(runBatches.createdAt, input.createdBefore)] : []),
      ...(cursor
        ? [
            or(
              lt(runBatches.createdAt, cursor.createdAt),
              and(eq(runBatches.createdAt, cursor.createdAt), lt(runBatches.id, cursor.id)),
            )!,
          ]
        : []),
      ...(input.caseDefinitionId
        ? [
            sql`EXISTS (SELECT 1 FROM execution_runs run WHERE run.batch_id = ${runBatches.id} AND run.case_definition_id = ${input.caseDefinitionId})`,
          ]
        : []),
      ...(input.runnerId
        ? [
            sql`EXISTS (SELECT 1 FROM execution_runs run WHERE run.batch_id = ${runBatches.id} AND run.assigned_runner_id = ${input.runnerId})`,
          ]
        : []),
    ];
    const rows = this.handle.db
      .select()
      .from(runBatches)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(runBatches.createdAt), desc(runBatches.id))
      .limit(input.limit + 1)
      .all();
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
    if (projectIds?.length === 0) return null;
    const batchRow = this.handle.db
      .select()
      .from(runBatches)
      .where(
        projectIds
          ? and(eq(runBatches.id, batchId), inArray(runBatches.projectId, [...projectIds]))
          : eq(runBatches.id, batchId),
      )
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
    const statusHistory = this.handle.db
      .select()
      .from(runBatchStatusEvents)
      .where(eq(runBatchStatusEvents.batchId, batchId))
      .orderBy(runBatchStatusEvents.recordedAt, runBatchStatusEvents.id)
      .all()
      .map(toRunBatchStatusEvent);
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
    return (
      this.handle.client
        .prepare(
          `SELECT id FROM run_batches WHERE status IN ('queued','dispatching')
           ORDER BY priority + MIN(100, MAX(0, CAST(
             (julianday(?) - julianday(created_at)) * 1440 / ? AS INTEGER
           ))) DESC, created_at, id LIMIT ?`,
        )
        .all(now, agingIntervalMinutes, limit) as Array<{ id: string }>
    ).map((row) => row.id);
  }

  async listSchedulableBatchIdsForRunner(
    runnerId: string,
    limit: number,
    now = new Date().toISOString(),
    agingIntervalMinutes = 5,
  ): Promise<string[]> {
    return (
      this.handle.client
        .prepare(
          `SELECT b.id FROM run_batches b JOIN run_batch_runners br ON br.batch_id=b.id
           WHERE br.runner_id=? AND b.status IN ('queued','dispatching')
           ORDER BY b.priority + MIN(100, MAX(0, CAST(
             (julianday(?) - julianday(b.created_at)) * 1440 / ? AS INTEGER
           ))) DESC, b.created_at, b.id LIMIT ?`,
        )
        .all(runnerId, now, agingIntervalMinutes, limit) as Array<{ id: string }>
    ).map((row) => row.id);
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
    const runtimeRow = this.handle.db
      .select({ adapterRuntimeJson: runBatches.adapterRuntimeJson })
      .from(runBatches)
      .where(eq(runBatches.id, batchId))
      .get();
    const adapterRuntime = parseProjectAdapterRuntime(runtimeRow?.adapterRuntimeJson ?? null);
    const candidates = runnerRows
      .map((row) => ({
        runner: mapStoredRunner(row, offlineBefore),
        reservedSlots: reservations.get(row.id) ?? 0,
      }))
      .filter((candidate) =>
        supportsProjectAdapterRuntime(candidate.runner.capabilities, adapterRuntime),
      );
    return {
      batch,
      queuedRuns: batch.runs.filter((run) => run.status === "queued" && (run.heldRound ?? 0) === 0),
      candidates,
      projectActiveRuns: projectActiveRuns(this.handle, batch.projectId),
    };
  }

  async reserveAssignments(input: ReserveSchedulingAssignmentsInput): Promise<number> {
    return this.handle.client.transaction(() => {
      const batchScope = this.handle.db
        .select({
          projectId: runBatches.projectId,
          policyJson: runBatches.policyJson,
          adapterRuntimeJson: runBatches.adapterRuntimeJson,
        })
        .from(runBatches)
        .where(eq(runBatches.id, input.batchId))
        .get();
      if (!batchScope) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
      let remainingProjectSlots = Math.max(
        0,
        (input.projectMaximumConcurrency ?? Number.MAX_SAFE_INTEGER) -
          projectActiveRuns(this.handle, batchScope.projectId),
      );
      const batchConcurrency = batchPolicy(batchScope.policyJson)?.concurrency;
      const adapterRuntime = parseProjectAdapterRuntime(batchScope.adapterRuntimeJson);
      let remainingBatchSlots =
        batchConcurrency === undefined
          ? Number.POSITIVE_INFINITY
          : Math.max(0, batchConcurrency - batchActiveRuns(this.handle, input.batchId));
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
        if (remainingProjectSlots === 0 || remainingBatchSlots === 0) break;
        if (!selectedRunnerIds.has(decision.runnerId)) continue;
        const runnerRow = this.handle.db
          .select()
          .from(runners)
          .where(eq(runners.id, decision.runnerId))
          .get();
        if (!runnerRow) continue;
        const reservations = activeReservations(this.handle, [decision.runnerId]);
        const runner = mapStoredRunner(runnerRow, input.offlineBefore);
        if (!assessRunnerCompatibility(runner).compatible) continue;
        if (!supportsProjectAdapterRuntime(runner.capabilities, adapterRuntime)) continue;
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
              eq(executionRuns.heldRound, 0),
              or(
                isNull(executionRuns.queueDeadlineAt),
                gt(executionRuns.queueDeadlineAt, input.scheduledAt),
              ),
            ),
          )
          .returning({
            attemptCount: executionRuns.attemptCount,
            caseDefinitionId: executionRuns.caseDefinitionId,
            caseVersion: executionRuns.caseVersion,
            className: executionRuns.className,
            parametersJson: executionRuns.parametersJson,
          })
          .get();
        if (!updatedRun) continue;
        const source = this.handle.db
          .select({
            id: caseSources.id,
            sha256: caseSources.sha256,
            sizeBytes: caseSources.sizeBytes,
          })
          .from(caseVersions)
          .innerJoin(caseSources, eq(caseSources.id, caseVersions.sourceId))
          .where(
            and(
              eq(caseVersions.caseDefinitionId, updatedRun.caseDefinitionId),
              eq(caseVersions.version, updatedRun.caseVersion),
            ),
          )
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
          .select({
            environmentJson: runBatches.environmentJson,
            secretBindingsJson: runBatches.secretBindingsJson,
            policyJson: runBatches.policyJson,
            priority: runBatches.priority,
            claimTimeoutMs: runBatches.claimTimeoutMs,
            executionTimeoutMs: runBatches.executionTimeoutMs,
            uploadTimeoutMs: runBatches.uploadTimeoutMs,
          })
          .from(runBatches)
          .where(eq(runBatches.id, input.batchId))
          .get();
        if (!batch) continue;
        const policy = batchPolicy(batch.policyJson);
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
                parameters: stringRecord(updatedRun.parametersJson),
                source,
                ...(adapterRuntime ? { adapterRuntime } : {}),
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
          })
          .run();
        accepted += 1;
        remainingProjectSlots -= 1;
        remainingBatchSlots -= 1;
      }
      updateBatchSchedulingStatus(
        this.handle,
        input.batchId,
        input.scheduledAt,
        input.eventId ?? input.decisions[0]?.assignmentId ?? input.batchId,
      );
      return accepted;
    })();
  }

  async appendSchedulingEvents(
    events: Parameters<RunBatchRepository["appendSchedulingEvents"]>[0],
  ): Promise<void> {
    if (events.length === 0) return;
    // 批量插入放入同一事务，保证一轮调度产生的事件要么整体可见，要么整体回滚。
    this.handle.client.transaction(() => {
      for (const event of events) {
        this.handle.client
          .prepare(
            `INSERT INTO scheduling_events
             (id, batch_id, runner_id, execution_run_id, attempt_id, event_type,
              message, payload_json, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            event.id,
            event.batchId,
            event.runnerId ?? null,
            event.executionRunId ?? null,
            event.attemptId ?? null,
            event.eventType,
            event.message,
            event.payload ? JSON.stringify(event.payload) : null,
            event.recordedAt,
          );
      }
    })();
  }

  async listSchedulingEvents(
    input: Parameters<RunBatchRepository["listSchedulingEvents"]>[0],
  ): ReturnType<RunBatchRepository["listSchedulingEvents"]> {
    const limit = Math.min(Math.max(1, Math.trunc(input.limit)), 500);
    const parameters: Array<string | number> = [input.batchId];
    let filters = "";
    if (input.runnerId !== undefined) {
      parameters.push(input.runnerId);
      filters += " AND runner_id = ?";
    }
    if (input.afterId !== undefined) {
      // 游标用 (recorded_at, id) 元组比较定位，id 为唯一键保证边界不重复、不遗漏。
      parameters.push(input.afterId);
      filters += ` AND (recorded_at, id) > (
        SELECT recorded_at, id FROM scheduling_events WHERE id = ?)`;
    }
    parameters.push(limit);
    const rows = this.handle.client
      .prepare(
        `SELECT id, batch_id, runner_id, execution_run_id, attempt_id, event_type,
                message, payload_json, recorded_at
         FROM scheduling_events
         WHERE batch_id = ?${filters}
         ORDER BY recorded_at ASC, id ASC
         LIMIT ?`,
      )
      .all(...parameters) as Array<{
      id: string;
      batch_id: string;
      runner_id: string | null;
      execution_run_id: string | null;
      attempt_id: string | null;
      event_type: SchedulingEventType;
      message: string;
      payload_json: string | null;
      recorded_at: string;
    }>;
    const items = rows.map(schedulingEventFromRow);
    const last = items.at(-1);
    return {
      items,
      ...(items.length === limit && last ? { nextAfterId: last.id } : {}),
    };
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
    const policy = batchPolicy(row.policyJson);
    const runOutcomes = this.handle.db
      .select({ status: executionRuns.status, terminalOutcome: executionRuns.terminalOutcome })
      .from(executionRuns)
      .where(eq(executionRuns.batchId, row.id))
      .all();
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
      retryMode: row.retryMode,
      currentRound: row.currentRound,
      queueTimeoutMs: row.queueTimeoutMs,
      claimTimeoutMs: row.claimTimeoutMs,
      executionTimeoutMs: row.executionTimeoutMs,
      uploadTimeoutMs: row.uploadTimeoutMs,
      environmentVariables: environmentVariables(row.environmentJson),
      secretBindings: secretBindings(row.secretBindingsJson),
      selectedRunnerIds,
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
  adapterRuntime?: ProjectAdapterRuntime;
  environment: ExecutionEnvironmentVariable[];
  secretBindings: ExecutionEnvironmentSecretBinding[];
  executionTimeoutMs: number;
  uploadTimeoutMs: number;
  policy?: RunBatchExecutionPolicy;
}): ExecutionSpec {
  const artifactPatterns = input.policy?.artifactPatterns ?? ["reports/testng/**"];
  const runtimeInputs = input.adapterRuntime ? runtimeAssetInputs(input.adapterRuntime) : [];
  const executionInputs: ExecutionSpec["inputs"] = [
    {
      inputId: input.source.id,
      kind: "test-jar",
      targetPath: "inputs/tests.jar",
      mediaType: "application/java-archive",
      sizeBytes: input.source.sizeBytes,
      sha256: input.source.sha256,
    },
    ...runtimeInputs,
  ];
  return {
    schemaVersion: 1,
    executor: input.policy?.executor ?? "testng",
    attemptId: input.attemptId,
    executionRunId: input.executionRunId,
    batchId: input.batchId,
    className: input.className,
    methodDescriptors: [],
    parameters: input.parameters,
    ...(input.adapterRuntime
      ? {
          adapter: {
            suiteName: input.adapterRuntime.suiteName,
            testName: input.adapterRuntime.testName,
            environmentAddress: adapterEnvironmentAddress(
              input.adapterRuntime,
              input.executionRunId,
            ),
          },
        }
      : {}),
    inputs: executionInputs,
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
      ...projectAdapterRequiredCapabilities(input.adapterRuntime),
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
    resourceLimits: executionResourceLimitsForInputs(
      executionInputs.map((executionInput) => executionInput.sizeBytes),
      input.adapterRuntime !== undefined,
    ),
  };
}

function projectAdapterRuntime(
  handle: SqliteDatabaseHandle,
  projectId: string,
  adapter: CreateRunBatchRecord["adapter"],
  runs: CreateRunBatchRecord["runs"],
): ProjectAdapterRuntime | undefined {
  const configuration = handle.client
    .prepare(
      `SELECT jdk_asset_id, jar_bundle_asset_id
       FROM project_adapter_configurations WHERE project_id = ?`,
    )
    .get(projectId) as
    | {
        jdk_asset_id: string | null;
        jar_bundle_asset_id: string | null;
      }
    | undefined;
  if (!hasTaskAdapterSettings(adapter)) return undefined;
  const asset = (id: string | null): RuntimeAssetSnapshot | undefined => {
    if (!id) return undefined;
    const row = handle.client
      .prepare(
        `SELECT id, source_type, url, sha256, size_bytes, archive_format
         FROM project_runtime_assets WHERE id = ? AND project_id = ?`,
      )
      .get(id, projectId) as
      | {
          id: string;
          source_type: "upload" | "url";
          url: string | null;
          sha256: string;
          size_bytes: number;
          archive_format: "zip" | "tar.gz";
        }
      | undefined;
    return row
      ? {
          id: row.id,
          sourceType: row.source_type,
          ...(row.url ? { url: row.url } : {}),
          sha256: row.sha256,
          sizeBytes: row.size_bytes,
          archiveFormat: row.archive_format,
        }
      : undefined;
  };
  const jdk = asset(configuration?.jdk_asset_id ?? null);
  const jarBundle = asset(configuration?.jar_bundle_asset_id ?? null);
  if (!jarBundle) {
    throw new DomainError(
      "ADAPTER_DEPENDENCY_ARCHIVE_MISSING",
      "任务已启用 CoTest Adapter，但项目尚未配置完整依赖 JAR 压缩包。",
    );
  }
  return {
    suiteName: adapter?.suiteName ?? "",
    testName: adapter?.testName ?? "",
    environmentAddressByRunId: assignEnvironmentAddresses(
      adapter?.environmentAddresses ?? [],
      runs,
    ),
    fallbackEnvironmentAddress: "",
    ...(jdk ? { jdk } : {}),
    jarBundle,
  };
}

function hasTaskAdapterSettings(adapter: CreateRunBatchRecord["adapter"]): boolean {
  return adapter?.enabled === true;
}

function assignEnvironmentAddresses(
  addresses: readonly string[],
  runs: CreateRunBatchRecord["runs"],
): Record<string, string> {
  if (addresses.length === 0) return {};
  return Object.fromEntries(
    runs.map((run, index) => [run.id, addresses[index % addresses.length]!]),
  );
}

function runtimeAssetInputs(runtime: ProjectAdapterRuntime): ExecutionSpec["inputs"] {
  return [
    ...(runtime.jdk ? [runtimeInput(runtime.jdk, "jdk-archive", "runtime-inputs/jdk")] : []),
    ...(runtime.jarBundle
      ? [runtimeInput(runtime.jarBundle, "jar-bundle", "runtime-inputs/jars")]
      : []),
  ];
}

function runtimeInput(
  asset: RuntimeAssetSnapshot,
  kind: "jdk-archive" | "jar-bundle",
  pathPrefix: string,
): ExecutionSpec["inputs"][number] {
  const suffix = asset.archiveFormat === "zip" ? ".zip" : ".tar.gz";
  return {
    inputId: asset.id,
    kind,
    targetPath: `${pathPrefix}${suffix}`,
    mediaType: asset.archiveFormat === "zip" ? "application/zip" : "application/gzip",
    sizeBytes: asset.sizeBytes,
    sha256: asset.sha256,
    ...(asset.sourceType === "url" && asset.url ? { downloadUrl: asset.url } : {}),
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

function projectActiveRuns(handle: SqliteDatabaseHandle, projectId: string): number {
  const row = handle.client
    .prepare(
      `SELECT count(*) AS count FROM run_attempts a
       JOIN execution_runs r ON r.id=a.execution_run_id
       JOIN run_batches b ON b.id=r.batch_id
       WHERE b.project_id=? AND a.status IN ('assigned','running')`,
    )
    .get(projectId) as { count: number };
  return row.count;
}

function batchActiveRuns(handle: SqliteDatabaseHandle, batchId: string): number {
  const row = handle.client
    .prepare(
      `SELECT count(*) AS count FROM run_attempts a
       JOIN execution_runs r ON r.id=a.execution_run_id
       WHERE r.batch_id=? AND a.status IN ('assigned','running')`,
    )
    .get(batchId) as { count: number };
  return row.count;
}

function updateBatchSchedulingStatus(
  handle: SqliteDatabaseHandle,
  batchId: string,
  updatedAt: string,
  eventId: string,
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
  const batch = handle.db
    .select({ status: runBatches.status, version: runBatches.version })
    .from(runBatches)
    .where(eq(runBatches.id, batchId))
    .get();
  if (!batch) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
  transitionRunBatch(batch.status, status);
  const nextVersion = batch.version + 1;
  const result = handle.db
    .update(runBatches)
    .set({ status, updatedAt, version: nextVersion })
    .where(and(eq(runBatches.id, batchId), eq(runBatches.version, batch.version)))
    .run();
  if (result.changes !== 1) {
    throw new DomainError("RUN_BATCH_VERSION_CONFLICT", "执行批次已被并发修改。");
  }
  if (batch.status !== status) {
    handle.db
      .insert(runBatchStatusEvents)
      .values({
        id: eventId,
        batchId,
        fromStatus: batch.status,
        toStatus: status,
        batchVersion: nextVersion,
        reason: "scheduling.updated",
        recordedAt: updatedAt,
      })
      .run();
  }
}

function toRunBatchStatusEvent(row: typeof runBatchStatusEvents.$inferSelect): RunBatchStatusEvent {
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
    ...(row.terminalReasonCode ? { terminalReasonCode: row.terminalReasonCode } : {}),
    ...(row.cancelRequestedAt ? { cancelRequestedAt: row.cancelRequestedAt } : {}),
    ...(row.heldRound > 0 ? { heldRound: row.heldRound } : {}),
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

// payload_json 解析失败时丢弃 payload 字段：调度事件是诊断流水，
// 单条损坏不应阻断整页读取。
function schedulingEventFromRow(row: {
  id: string;
  batch_id: string;
  runner_id: string | null;
  execution_run_id: string | null;
  attempt_id: string | null;
  event_type: SchedulingEventType;
  message: string;
  payload_json: string | null;
  recorded_at: string;
}): SchedulingEvent {
  const payload = row.payload_json ? parseSchedulingEventPayload(row.payload_json) : undefined;
  return {
    id: row.id,
    batchId: row.batch_id,
    ...(row.runner_id ? { runnerId: row.runner_id } : {}),
    ...(row.execution_run_id ? { executionRunId: row.execution_run_id } : {}),
    ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
    eventType: row.event_type,
    message: row.message,
    ...(payload ? { payload } : {}),
    recordedAt: row.recorded_at,
  };
}

function parseSchedulingEventPayload(json: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
