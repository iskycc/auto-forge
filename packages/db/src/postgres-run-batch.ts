import type {
  CreateRunBatchRecord,
  ReserveAssignmentsOutcome,
  ReserveSchedulingAssignmentsInput,
  RunBatchListQuery,
  RunBatchCasePageQuery,
  RunBatchDetailOverview,
  RunBatchRepository,
  SchedulingSnapshot,
} from "@autoforge/application";
import { testNgResultDetailsSchema, type ExecutionSpec } from "@autoforge/contracts";
import {
  artifactMediaType,
  assessRunnerCompatibility,
  DEFAULT_CASE_EXECUTION_TIMEOUT_SECONDS,
  DEFAULT_PROJECT_ID,
  DomainError,
  evaluateRunnerForScheduling,
  MINIMUM_JAVA_MAJOR_VERSION,
  normalizeStoredRetryConcurrencyRules,
  REQUIRED_EXECUTION_LABELS,
  RETRYABLE_RUNNER_FAILURE_RESULT_CODES,
  SUPPORTED_TESTNG_VERSION,
  transitionRunBatch,
  type ExecutionEnvironmentVariable,
  type ExecutionEnvironmentSecretBinding,
  type ExecutionRun,
  type RunAttempt,
  type RunBatch,
  type RunBatchDetails,
  type RunBatchExecutionPolicy,
  type RunBatchRoundRecovery,
  type RunBatchRoundConcurrency,
  type RunBatchRoundSummary,
  type RetryConcurrencyState,
  type RunBatchStatusEvent,
  type RunBatchStatus,
  type SchedulingEvent,
  type SchedulingEventType,
} from "@autoforge/domain";
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";

import type { PostgresDatabaseHandle } from "./postgres-database";
import {
  batchesOf,
  POSTGRES_WRITE_BATCH_SIZE,
  RELATIONAL_ID_QUERY_BATCH_SIZE,
} from "./database-batches";
import {
  adapterEnvironmentAddress,
  executionResourceLimitsForInputs,
  parseProjectAdapterRuntime,
  projectAdapterRequiredCapabilities,
  supportsProjectAdapterRuntime,
  type ProjectAdapterRuntime,
  type RuntimeAssetSnapshot,
} from "./project-adapter-runtime";
import { runnerFailureIdsByExecutionRun } from "./runner-failure-history";
import { insertSchedulingEventDrafts } from "./scheduling-event-insert";
import {
  pgExecutionRuns,
  pgRunAttempts,
  pgRunBatchRunners,
  pgRunBatchRetryConcurrencyStates,
  pgRunBatchRoundConcurrencies,
  pgRunBatches,
  pgRunBatchStatusEvents,
  pgRunners,
  pgProjects,
  pgProjectAdapterConfigurations,
  pgProjectVersionRuntimeAssets,
  pgProjectRuntimeAssets,
} from "./postgres-schema";
import { mapStoredRunner } from "./runner-mapper";
import {
  assertRetryConcurrencyTransition,
  retryConcurrencyActivationDecision,
  retryConcurrencyStateFromRow,
} from "./retry-concurrency-state";
import { decodeRunBatchCursor, encodeRunBatchCursor } from "./run-batch-list";

const activeAttemptStatuses = ["assigned", "running"] as const;
const activeBatchStatuses = ["queued", "dispatching", "scheduled", "running"] as const;
const SCHEDULING_RUN_WINDOW_SIZE = 4_096;

type DatabaseTimestamp = string | Date;

type RoundRecoveryDetailRow = {
  rule_id: string;
  after_round: number;
  next_round: number;
  jenkins_job_url: string;
  wait_minutes: number;
  status: RunBatchRoundRecovery["status"];
  source_build_number: number | null;
  rebuild_number: number | null;
  rebuild_url: string | null;
  activated_at: DatabaseTimestamp | null;
  started_at: DatabaseTimestamp | null;
  finished_at: DatabaseTimestamp | null;
  build_result: string | null;
  error_message: string | null;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
};

type PostgresRoundAggregateRow = {
  round: number | string;
  totalRuns: string;
  executed: string;
  passed: string;
  failed: string;
  timedOut: string;
  cancelled: string;
  active: string;
  startedAt: DatabaseTimestamp | null;
  finishedAt: DatabaseTimestamp | null;
};

const POSTGRES_BATCH_ROUND_CTES = `WITH batch_runs AS (
  SELECT * FROM execution_runs WHERE batch_id=$1
), round_numbers(round) AS (
  SELECT 1
  UNION SELECT current_round FROM run_batches WHERE id=$1
  UNION SELECT attempt.attempt_number FROM run_attempts attempt
        JOIN batch_runs run ON run.id=attempt.execution_run_id
  UNION SELECT held_round FROM batch_runs WHERE held_round>0
), eligible_runs(execution_run_id,round) AS (
  SELECT id,1 FROM batch_runs
  UNION SELECT attempt.execution_run_id,attempt.attempt_number
        FROM run_attempts attempt JOIN batch_runs run ON run.id=attempt.execution_run_id
  UNION SELECT attempt.execution_run_id,attempt.attempt_number+1
        FROM run_attempts attempt JOIN batch_runs run ON run.id=attempt.execution_run_id
        JOIN round_numbers rounds ON rounds.round=attempt.attempt_number+1
        WHERE COALESCE(attempt.outcome,attempt.status) IN ('failed','timed_out')
  UNION SELECT id,held_round FROM batch_runs
        WHERE held_round>0 AND held_round IN (SELECT round FROM round_numbers)
)`;

export class PostgresRunBatchRepository implements RunBatchRepository {
  constructor(
    private readonly handle: PostgresDatabaseHandle,
    private readonly caseExecutionTimeoutSeconds = DEFAULT_CASE_EXECUTION_TIMEOUT_SECONDS,
  ) {}

  async create(record: CreateRunBatchRecord): Promise<RunBatch> {
    await this.ready();
    const queueTimeoutMs = record.queueTimeoutMs ?? 86_400_000;
    const claimTimeoutMs = record.claimTimeoutMs ?? 300_000;
    const executionTimeoutMs = record.executionTimeoutMs ?? 3_600_000;
    const uploadTimeoutMs = record.uploadTimeoutMs ?? 600_000;
    const scheduledFor = record.scheduledFor ?? record.createdAt;
    const adapterRuntime = record.adapterRuntimeSnapshot
      ? runtimeSnapshotForRuns(record.adapterRuntimeSnapshot, record.runs)
      : await postgresProjectAdapterRuntime(
          this.handle,
          record.projectId ?? DEFAULT_PROJECT_ID,
          record.adapter,
          record.runs,
          record.policy?.projectVersionId,
        );
    let createdRow: typeof pgRunBatches.$inferSelect | undefined;
    await this.handle.db.transaction(async (transaction) => {
      // 展示编号在同一插入语句内取序列（nextval 不参与回滚，空洞不影响展示），
      // RETURNING 直接带回完整批次行，创建完成后无需再往返读取摘要。
      const insertedRows = await transaction
        .insert(pgRunBatches)
        .values({
          id: record.id,
          sequenceNumber: sql<number>`nextval('run_batch_sequence_numbers')`,
          projectId: record.projectId,
          environmentId: record.environmentId,
          environmentVersionId: record.environmentVersionId,
          suiteId: record.suiteId,
          suiteName: record.suiteName,
          suiteVersion: record.suiteVersion,
          batchKind: record.kind ?? "standard",
          parentBatchId: record.parentBatchId,
          sourceExecutionRunId: record.sourceExecutionRunId,
          requestedByUsername: record.requestedBy?.username,
          requestedBySource: record.requestedBy?.source,
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
          scheduledFor,
          createdAt: record.createdAt,
          updatedAt: record.createdAt,
        })
        .returning();
      createdRow = insertedRows[0];
      await transaction.insert(pgRunBatchStatusEvents).values({
        id: record.eventId ?? record.id,
        batchId: record.id,
        fromStatus: null,
        toStatus: "queued",
        batchVersion: 1,
        reason: "batch.created",
        recordedAt: record.createdAt,
      });
      await transaction.insert(pgRunBatchRoundConcurrencies).values({
        batchId: record.id,
        executionRound: 1,
        concurrency: record.policy?.concurrency ?? 4,
        source: "base",
        recordedAt: record.createdAt,
      });
      if (record.runnerIds.length > 0) {
        await transaction
          .insert(pgRunBatchRunners)
          .values(record.runnerIds.map((runnerId) => ({ batchId: record.id, runnerId })));
      }
      for (const recovery of record.roundRecoveries ?? []) {
        await transaction.execute(sql`
          INSERT INTO run_batch_round_recoveries
            (batch_id, rule_id, after_round, next_round, jenkins_job_url,
             api_key_ciphertext, wait_minutes, status, available_at, created_at, updated_at)
          VALUES
            (${record.id}, ${recovery.ruleId}, ${recovery.afterRound},
             ${recovery.afterRound + 1}, ${recovery.jenkinsJobUrl},
             ${recovery.apiKeyCiphertext}, ${recovery.waitMinutes}, 'idle',
             ${record.createdAt}, ${record.createdAt}, ${record.createdAt})
        `);
      }
      const queueDeadlineAt = addMilliseconds(scheduledFor, queueTimeoutMs);
      for (const runs of batchesOf(record.runs, POSTGRES_WRITE_BATCH_SIZE)) {
        // unnest 数组批量写入：逐行 VALUES 绑定参数在数百行规模显著拖慢创建。
        await transaction.execute(sql`
          INSERT INTO execution_runs
            (id, batch_id, case_definition_id, execution_case_definition_id, case_version,
             display_name, class_name, case_type, class_data_json, class_data_size_bytes,
             class_data_sha256, ddt_sr_num, parameters_json, status, attempt_count,
             queue_deadline_at, execution_timeout_ms, upload_timeout_ms, created_at, updated_at)
          SELECT s.id, ${record.id}, s.case_definition_id, s.execution_case_definition_id,
                 s.case_version, s.display_name, s.class_name, s.case_type, s.class_data_json,
                 s.class_data_size_bytes, s.class_data_sha256, s.ddt_sr_num,
                 s.parameters_json, 'queued', 0, ${queueDeadlineAt},
                 ${executionTimeoutMs}, ${uploadTimeoutMs}, ${record.createdAt},
                 ${record.createdAt}
          FROM jsonb_to_recordset(${JSON.stringify(
            runs.map((run) => ({
              id: run.id,
              case_definition_id: run.caseDefinitionId,
              execution_case_definition_id: run.executionCaseDefinitionId ?? run.caseDefinitionId,
              case_version: run.caseVersion,
              display_name: run.displayName,
              class_name: run.className,
              case_type: run.caseType ?? "testng",
              class_data_json: run.classData?.json ?? null,
              class_data_size_bytes: run.classData?.sizeBytes ?? null,
              class_data_sha256: run.classData?.sha256 ?? null,
              ddt_sr_num: run.ddtSrNum ?? null,
              parameters_json: JSON.stringify(run.parameters ?? {}),
            })),
          )}::jsonb)
                 AS s(id text, case_definition_id text, execution_case_definition_id text,
                      case_version integer, display_name text, class_name text, case_type text,
                      class_data_json text, class_data_size_bytes integer, class_data_sha256 text,
                      ddt_sr_num text, parameters_json text)`);
      }
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
             ${scheduledFor})
        `);
      }
    });
    if (!createdRow) {
      throw new Error(`Run batch ${record.id} was not returned after creation.`);
    }
    // 创建即摘要：全部运行处于排队态，计数与选定执行机直接来自创建输入，
    // 与创建后重新读取的行完全一致，省去列表映射的两次往返。
    return this.mapBatchRow(
      createdRow,
      [...record.runnerIds].sort(),
      new Map([["queued", record.runs.length]]),
      undefined,
    );
  }

  async list(
    limit: number,
    projectIds?: readonly string[],
    projectVersionId?: string,
  ): Promise<RunBatch[]> {
    await this.ready();
    if (projectIds?.length === 0) return [];
    const rows = await this.handle.db
      .select()
      .from(pgRunBatches)
      .where(
        and(
          sql`${pgRunBatches.batchKind} <> 'case_log_rerun'`,
          ...(projectIds ? [inArray(pgRunBatches.projectId, [...projectIds])] : []),
          ...(projectVersionId
            ? [
                sql`(${pgRunBatches.policyJson}::jsonb ->> 'projectVersionId') = ${projectVersionId}`,
              ]
            : []),
        ),
      )
      .orderBy(desc(pgRunBatches.createdAt))
      .limit(limit);
    return this.mapBatches(rows);
  }

  async listPage(input: RunBatchListQuery) {
    await this.ready();
    if (input.projectIds?.length === 0) return { items: [] };
    const cursor = decodeRunBatchCursor(input.cursor);
    const conditions = [
      sql`${pgRunBatches.batchKind} <> 'case_log_rerun'`,
      ...(input.projectIds ? [inArray(pgRunBatches.projectId, [...input.projectIds])] : []),
      ...(input.projectId ? [eq(pgRunBatches.projectId, input.projectId)] : []),
      ...(input.projectVersionId
        ? [
            sql`(${pgRunBatches.policyJson}::jsonb ->> 'projectVersionId') = ${input.projectVersionId}`,
          ]
        : []),
      ...(input.suiteId ? [eq(pgRunBatches.suiteId, input.suiteId)] : []),
      ...(input.status ? [eq(pgRunBatches.status, input.status)] : []),
      ...(input.createdAfter ? [gte(pgRunBatches.scheduledFor, input.createdAfter)] : []),
      ...(input.createdBefore ? [lte(pgRunBatches.scheduledFor, input.createdBefore)] : []),
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
    // 页内批次的选定执行机随页查询一次取回（有序数组聚合），列表探针往返
    // 由“页 + 执行机 + 计数预检 + 计数”收敛为“页 + 计数”两次。
    const rows = await this.handle.db
      .select({
        ...getTableColumns(pgRunBatches),
        selectedRunnerIds: sql<string[]>`(SELECT COALESCE(
          array_agg(br.runner_id ORDER BY br.runner_id), ARRAY[]::text[]
        ) FROM run_batch_runners br WHERE br.batch_id = ${pgRunBatches.id})`,
      })
      .from(pgRunBatches)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(pgRunBatches.createdAt), desc(pgRunBatches.id))
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const pageRows = rows.slice(0, input.limit);
    const runnerIdsByBatch = new Map<string, string[]>(
      pageRows.map((row) => [row.id, row.selectedRunnerIds ?? []]),
    );
    const items = await this.mapBatches(pageRows, runnerIdsByBatch);
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
    // attempts 用 batch_id 关联子查询定位，与 SQLite 适配保持同形：大批次（5 万+ run）
    // 下避免巨型 IN 列表，参数数量固定为 1。
    const attemptRows =
      runRows.length === 0
        ? []
        : await this.handle.db
            .select()
            .from(pgRunAttempts)
            .where(
              sql`EXISTS (SELECT 1 FROM execution_runs run WHERE run.id = ${pgRunAttempts.executionRunId} AND run.batch_id = ${batchId})`,
            )
            .orderBy(pgRunAttempts.createdAt, pgRunAttempts.id);
    const statusHistory = (
      await this.handle.db
        .select()
        .from(pgRunBatchStatusEvents)
        .where(eq(pgRunBatchStatusEvents.batchId, batchId))
        .orderBy(pgRunBatchStatusEvents.recordedAt, pgRunBatchStatusEvents.id)
    ).map(toRunBatchStatusEvent);
    const roundRecoveries = await this.handle.pool.query<RoundRecoveryDetailRow>(
      `SELECT rule_id, after_round, next_round, jenkins_job_url, wait_minutes, status,
              source_build_number, rebuild_number, rebuild_url, activated_at, started_at,
              finished_at, build_result, error_message, created_at, updated_at
       FROM run_batch_round_recoveries
       WHERE batch_id = $1
       ORDER BY after_round, rule_id`,
      [batchId],
    );
    const roundConcurrencies = await this.handle.db
      .select()
      .from(pgRunBatchRoundConcurrencies)
      .where(eq(pgRunBatchRoundConcurrencies.batchId, batchId))
      .orderBy(pgRunBatchRoundConcurrencies.executionRound);
    return {
      ...(await this.mapBatch(batchRow)),
      runs: runRows.map(toExecutionRun),
      attempts: attemptRows.map(toRunAttempt),
      roundRecoveries: roundRecoveries.rows.map(toRoundRecoveryDetail),
      roundConcurrencies: roundConcurrencies.map(toRoundConcurrency),
      statusHistory,
    };
  }

  async resolveAttemptRerunSource(attemptId: string) {
    await this.ready();
    const result = await this.handle.pool.query<{
      batchId: string;
      executionRunId: string;
      attemptStatus: RunAttempt["status"];
    }>(
      `SELECT run.batch_id AS "batchId", attempt.execution_run_id AS "executionRunId",
              attempt.status AS "attemptStatus"
       FROM run_attempts attempt
       JOIN execution_runs run ON run.id = attempt.execution_run_id
       WHERE attempt.id = $1`,
      [attemptId],
    );
    return result.rows[0] ?? null;
  }

  async getRerunSnapshot(
    batchId: string,
    selection: { executionRunId?: string; finalFailuresOnly?: boolean },
  ) {
    await this.ready();
    const batch = await this.getSummary(batchId);
    if (!batch) return null;
    const [runtimeRow] = await this.handle.db
      .select({ adapterRuntimeJson: pgRunBatches.adapterRuntimeJson })
      .from(pgRunBatches)
      .where(eq(pgRunBatches.id, batchId))
      .limit(1);
    const runtime = parseProjectAdapterRuntime(runtimeRow?.adapterRuntimeJson ?? null);
    const runSelection = and(
      eq(pgExecutionRuns.batchId, batchId),
      ...(selection.executionRunId ? [eq(pgExecutionRuns.id, selection.executionRunId)] : []),
      ...(selection.finalFailuresOnly ? [finalFailureRunCondition(pgExecutionRuns)] : []),
    );
    const runRows = await this.handle.db
      .select()
      .from(pgExecutionRuns)
      .where(runSelection)
      .orderBy(pgExecutionRuns.createdAt, pgExecutionRuns.id);
    const recoveries = await this.handle.pool.query<{
      ruleId: string;
      afterRound: number;
      jenkinsJobUrl: string;
      apiKeyCiphertext: string;
      waitMinutes: number;
    }>(
      `SELECT rule_id AS "ruleId", after_round AS "afterRound",
              jenkins_job_url AS "jenkinsJobUrl", api_key_ciphertext AS "apiKeyCiphertext",
              wait_minutes AS "waitMinutes"
       FROM run_batch_round_recoveries
       WHERE batch_id = $1 ORDER BY after_round, rule_id`,
      [batchId],
    );
    return {
      batch,
      ...(runtime
        ? {
            adapterRuntime: {
              suiteName: runtime.suiteName,
              testName: runtime.testName,
              environmentAddresses: runRows.map((run) =>
                adapterEnvironmentAddress(runtime, run.id),
              ),
              ...(runtime.jdk ? { jdk: { ...runtime.jdk } } : {}),
              ...(runtime.jarBundle ? { jarBundle: { ...runtime.jarBundle } } : {}),
            },
          }
        : {}),
      roundRecoveries: recoveries.rows,
      runs: runRows.map((run) => ({
        id: run.id,
        caseDefinitionId: run.caseDefinitionId,
        executionCaseDefinitionId: run.executionCaseDefinitionId ?? run.caseDefinitionId,
        caseVersion: run.caseVersion,
        displayName: run.displayName,
        className: run.className,
        caseType: run.caseType,
        ...(run.ddtSrNum ? { ddtSrNum: run.ddtSrNum } : {}),
        ...(run.classDataJson && run.classDataSizeBytes && run.classDataSha256
          ? {
              classData: {
                json: run.classDataJson,
                sizeBytes: run.classDataSizeBytes,
                sha256: run.classDataSha256,
              },
            }
          : {}),
        parameters: stringRecord(run.parametersJson),
      })),
    };
  }

  async listCaseLogRerunBatches(
    parentBatchId: string,
    sourceExecutionRunId: string,
    limit: number,
  ): Promise<RunBatchDetails[]> {
    await this.ready();
    const rows = await this.handle.db
      .select({ id: pgRunBatches.id })
      .from(pgRunBatches)
      .where(
        and(
          eq(pgRunBatches.batchKind, "case_log_rerun"),
          eq(pgRunBatches.parentBatchId, parentBatchId),
          eq(pgRunBatches.sourceExecutionRunId, sourceExecutionRunId),
        ),
      )
      .orderBy(pgRunBatches.createdAt, pgRunBatches.id)
      .limit(Math.min(Math.max(1, limit), 500));
    const batches = await Promise.all(rows.map(({ id }) => this.get(id)));
    return batches.filter((batch): batch is RunBatchDetails => batch !== null);
  }

  async listAttemptsForExecutionRun(executionRunId: string): Promise<RunAttempt[]> {
    await this.ready();
    const rows = await this.handle.db
      .select()
      .from(pgRunAttempts)
      .where(eq(pgRunAttempts.executionRunId, executionRunId))
      .orderBy(pgRunAttempts.createdAt, pgRunAttempts.id);
    return rows.map(toRunAttempt);
  }

  async getSummary(batchId: string, projectIds?: readonly string[]): Promise<RunBatch | null> {
    await this.ready();
    if (projectIds?.length === 0) return null;
    const [row] = await this.handle.db
      .select()
      .from(pgRunBatches)
      .where(
        projectIds
          ? and(eq(pgRunBatches.id, batchId), inArray(pgRunBatches.projectId, [...projectIds]))
          : eq(pgRunBatches.id, batchId),
      )
      .limit(1);
    return row ? this.mapBatch(row) : null;
  }

  async getDetailOverview(
    batchId: string,
    projectIds?: readonly string[],
  ): Promise<RunBatchDetailOverview | null> {
    await this.ready();
    const batch = await this.getSummary(batchId, projectIds);
    if (!batch) return null;
    const [
      roundResult,
      firstPassResult,
      recoveryResult,
      concurrencyRows,
      runnerResult,
      faultResult,
      participatingResult,
    ] = await Promise.all([
      this.handle.pool.query<PostgresRoundAggregateRow>(
        `${POSTGRES_BATCH_ROUND_CTES}
           SELECT rounds.round,
                  COUNT(eligible.execution_run_id) AS "totalRuns",
                  COUNT(attempt.id) AS executed,
                  COUNT(*) FILTER (WHERE COALESCE(attempt.outcome,attempt.status)='succeeded') AS passed,
                  COUNT(*) FILTER (WHERE COALESCE(attempt.outcome,attempt.status)='failed') AS failed,
                  COUNT(*) FILTER (WHERE COALESCE(attempt.outcome,attempt.status)='timed_out') AS "timedOut",
                  COUNT(*) FILTER (WHERE COALESCE(attempt.outcome,attempt.status)='cancelled') AS cancelled,
                  COUNT(*) FILTER (WHERE attempt.status IN ('assigned','running')) AS active,
                  MIN(COALESCE(attempt.started_at,attempt.created_at)) AS "startedAt",
                  MAX(attempt.finished_at) AS "finishedAt"
           FROM round_numbers rounds
           LEFT JOIN eligible_runs eligible ON eligible.round=rounds.round
           LEFT JOIN run_attempts attempt
             ON attempt.execution_run_id=eligible.execution_run_id
            AND attempt.attempt_number=rounds.round
           GROUP BY rounds.round ORDER BY rounds.round`,
        [batchId],
      ),
      this.handle.pool.query<{ firstRound: number; count: string }>(
        `SELECT MIN(attempt_number) AS "firstRound",COUNT(*) AS count FROM (
             SELECT attempt.execution_run_id,MIN(attempt.attempt_number) AS attempt_number
             FROM run_attempts attempt JOIN execution_runs run ON run.id=attempt.execution_run_id
             WHERE run.batch_id=$1 AND COALESCE(attempt.outcome,attempt.status)='succeeded'
             GROUP BY attempt.execution_run_id
           ) first_pass GROUP BY attempt_number ORDER BY attempt_number`,
        [batchId],
      ),
      this.handle.pool.query<RoundRecoveryDetailRow>(
        `SELECT rule_id,after_round,next_round,jenkins_job_url,wait_minutes,status,
                  source_build_number,rebuild_number,rebuild_url,activated_at,started_at,
                  finished_at,build_result,error_message,created_at,updated_at
           FROM run_batch_round_recoveries WHERE batch_id=$1 ORDER BY after_round,rule_id`,
        [batchId],
      ),
      this.handle.db
        .select()
        .from(pgRunBatchRoundConcurrencies)
        .where(eq(pgRunBatchRoundConcurrencies.batchId, batchId))
        .orderBy(pgRunBatchRoundConcurrencies.executionRound),
      this.handle.pool.query<{
        round: number;
        runnerId: string;
        executed: string;
        passed: string;
        failed: string;
        lastActivity: DatabaseTimestamp;
      }>(
        `SELECT attempt.attempt_number AS round,attempt.runner_id AS "runnerId",
                  COUNT(*) AS executed,
                  COUNT(*) FILTER (WHERE COALESCE(attempt.outcome,attempt.status)='succeeded') AS passed,
                  COUNT(*) FILTER (WHERE COALESCE(attempt.outcome,attempt.status) IN ('failed','timed_out')) AS failed,
                  MAX(COALESCE(attempt.finished_at,attempt.started_at,attempt.created_at)) AS "lastActivity"
           FROM run_attempts attempt JOIN execution_runs run ON run.id=attempt.execution_run_id
           WHERE run.batch_id=$1 GROUP BY attempt.attempt_number,attempt.runner_id
           ORDER BY attempt.attempt_number,attempt.runner_id`,
        [batchId],
      ),
      this.handle.pool.query<{
        runnerId: string;
        resultCode: string;
        summary: string;
        count: string;
        attemptNumbers: number[];
        caseNames: string | null;
        lastOccurredAt: DatabaseTimestamp;
      }>(
        `WITH faults AS (
             SELECT attempt.runner_id AS runner_id,attempt.result_code AS result_code,
                    COALESCE(NULLIF(BTRIM(attempt.result_summary),''),'执行机未提供错误描述。') AS summary,
                    attempt.attempt_number,run.display_name AS case_name,
                    COALESCE(attempt.finished_at,attempt.started_at,attempt.created_at) AS occurred_at
             FROM run_attempts attempt JOIN execution_runs run ON run.id=attempt.execution_run_id
             WHERE run.batch_id=$1 AND attempt.result_code=ANY($2::text[])
           ), grouped AS (
             SELECT runner_id,result_code,summary,COUNT(*) AS count,
                    ARRAY_AGG(DISTINCT attempt_number ORDER BY attempt_number) AS attempt_numbers,
                    MAX(occurred_at) AS last_occurred_at
             FROM faults GROUP BY runner_id,result_code,summary
             ORDER BY count DESC,last_occurred_at DESC LIMIT 100
           ), name_candidates AS (
             SELECT runner_id,result_code,summary,case_name,MAX(occurred_at) AS last_occurred_at
             FROM faults GROUP BY runner_id,result_code,summary,case_name
           ), ranked_names AS (
             SELECT *,ROW_NUMBER() OVER (
               PARTITION BY runner_id,result_code,summary ORDER BY last_occurred_at DESC,case_name
             ) AS name_rank FROM name_candidates
           ), names AS (
             SELECT runner_id,result_code,summary,
                    STRING_AGG(case_name,E'\n' ORDER BY last_occurred_at DESC,case_name) AS case_names
             FROM ranked_names WHERE name_rank<=20 GROUP BY runner_id,result_code,summary
           )
           SELECT grouped.runner_id AS "runnerId",grouped.result_code AS "resultCode",
                  grouped.summary,grouped.count,grouped.attempt_numbers AS "attemptNumbers",
                  grouped.last_occurred_at AS "lastOccurredAt",names.case_names AS "caseNames"
           FROM grouped LEFT JOIN names USING (runner_id,result_code,summary)
           ORDER BY grouped.count DESC,grouped.last_occurred_at DESC`,
        [batchId, [...RETRYABLE_RUNNER_FAILURE_RESULT_CODES]],
      ),
      this.handle.pool.query<{ runnerId: string }>(
        `SELECT DISTINCT attempt.runner_id AS "runnerId"
           FROM run_attempts attempt JOIN execution_runs run ON run.id=attempt.execution_run_id
           WHERE run.batch_id=$1 ORDER BY attempt.runner_id`,
        [batchId],
      ),
    ]);
    const roundRows = roundResult.rows.map(normalizePostgresRoundRow);
    const roundSummaries = mapPostgresRoundSummaries(
      batch,
      roundRows,
      firstPassResult.rows.map((row) => ({
        firstRound: Number(row.firstRound),
        count: Number(row.count),
      })),
    );
    const roundRecoveries = recoveryResult.rows.map(toRoundRecoveryDetail);
    return {
      batch,
      roundSummaries,
      allRoundsSummary: postgresAllRoundsSummary(roundSummaries),
      finalSummary: postgresFinalSummaryFromBatch(batch),
      roundRecoveries,
      roundConcurrencies: concurrencyRows.map(toRoundConcurrency),
      runnerRoundSummaries: runnerResult.rows.map((row) => ({
        round: Number(row.round),
        runnerId: row.runnerId,
        executed: Number(row.executed),
        passed: Number(row.passed),
        failed: Number(row.failed),
        lastActivity: isoTimestamp(row.lastActivity),
      })),
      runnerFaultIncidents: faultResult.rows.map((row) => ({
        key: `${row.runnerId}\u0000${row.resultCode}\u0000${row.summary}`,
        runnerId: row.runnerId,
        resultCode: row.resultCode,
        summary: row.summary,
        count: Number(row.count),
        caseNames: row.caseNames?.split("\n") ?? [],
        attemptNumbers: row.attemptNumbers.map(Number),
        lastOccurredAt: isoTimestamp(row.lastOccurredAt),
      })),
      participatingRunnerIds: participatingResult.rows.map(({ runnerId }) => runnerId),
      finishedAt: latestPostgresBatchActivity(batch.updatedAt, roundRows, recoveryResult.rows),
    };
  }

  async listCasePage(input: RunBatchCasePageQuery) {
    await this.ready();
    const batch = await this.getSummary(input.batchId, input.projectIds);
    if (!batch) return null;
    const query = postgresCasePageQuery(input);
    const result = await this.handle.pool.query<{
      runId: string;
      attemptId: string | null;
      round: number;
      total: string;
    }>(query.sqlText, query.parameters);
    if (result.rows.length === 0) return { items: [], total: 0 };
    const runIds = [...new Set(result.rows.map((row) => row.runId))];
    const attemptIds = result.rows.flatMap((row) => (row.attemptId ? [row.attemptId] : []));
    const [runRows, attemptRows] = await Promise.all([
      this.handle.db.select().from(pgExecutionRuns).where(inArray(pgExecutionRuns.id, runIds)),
      attemptIds.length === 0
        ? Promise.resolve([])
        : this.handle.db.select().from(pgRunAttempts).where(inArray(pgRunAttempts.id, attemptIds)),
    ]);
    const runsById = new Map(runRows.map((row) => [row.id, toExecutionRun(row)]));
    const attemptsById = new Map(attemptRows.map((row) => [row.id, toRunAttempt(row)]));
    return {
      items: result.rows.flatMap((key) => {
        const run = runsById.get(key.runId);
        if (!run) return [];
        const attempt = key.attemptId ? attemptsById.get(key.attemptId) : undefined;
        return [{ run, ...(attempt ? { attempt } : {}), round: Number(key.round) }];
      }),
      total: Number(result.rows[0]?.total ?? 0),
    };
  }

  async listReusableBatchIdsForRunner(
    runnerId: string,
    batchIds: readonly string[],
  ): Promise<string[]> {
    await this.ready();
    if (batchIds.length === 0) return [];
    return (
      await this.handle.db
        .select({ id: pgRunBatches.id })
        .from(pgRunBatches)
        .innerJoin(pgRunBatchRunners, eq(pgRunBatchRunners.batchId, pgRunBatches.id))
        .where(
          and(
            eq(pgRunBatchRunners.runnerId, runnerId),
            inArray(pgRunBatches.id, [...batchIds]),
            inArray(pgRunBatches.status, ["queued", "dispatching", "scheduled", "running"]),
            isNull(pgRunBatches.cancelRequestedAt),
          ),
        )
    ).map((row) => row.id);
  }

  async listSchedulableBatchIds(
    limit: number,
    now = new Date().toISOString(),
    agingIntervalMinutes = 5,
  ): Promise<string[]> {
    await this.ready();
    const result = await this.handle.pool.query<{ id: string }>(
      `SELECT id FROM run_batches
       WHERE status IN ('queued','dispatching','running') AND cancel_requested_at IS NULL
         AND scheduled_for <= $1
       ORDER BY priority + LEAST(100, GREATEST(0, FLOOR(
         EXTRACT(EPOCH FROM ($1::timestamptz-scheduled_for::timestamptz)) / 60 / $2
       ))) DESC, scheduled_for, id LIMIT $3`,
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
       WHERE br.runner_id=$1 AND b.status IN ('queued','dispatching','running')
         AND b.cancel_requested_at IS NULL AND b.scheduled_for <= $2
       ORDER BY b.priority + LEAST(100, GREATEST(0, FLOOR(
         EXTRACT(EPOCH FROM ($2::timestamptz-b.scheduled_for::timestamptz)) / 60 / $3
       ))) DESC, b.scheduled_for, b.id LIMIT $4`,
      [runnerId, now, agingIntervalMinutes, limit],
    );
    return result.rows.map((row) => row.id);
  }

  async getSchedulingSnapshot(
    batchId: string,
    offlineBefore: string,
    maximumQueuedRuns = SCHEDULING_RUN_WINDOW_SIZE,
  ): Promise<SchedulingSnapshot | null> {
    const batch = await this.getSummary(batchId);
    if (!batch) return null;
    const queuedRows = batch.terminationRequestedAt
      ? []
      : await this.handle.db
          .select()
          .from(pgExecutionRuns)
          .where(
            and(
              eq(pgExecutionRuns.batchId, batchId),
              eq(pgExecutionRuns.status, "queued"),
              eq(pgExecutionRuns.heldRound, 0),
            ),
          )
          .orderBy(pgExecutionRuns.createdAt, pgExecutionRuns.id)
          .limit(Math.min(SCHEDULING_RUN_WINDOW_SIZE, Math.max(1, maximumQueuedRuns)));
    const queuedRunIds = queuedRows.map((run) => run.id);
    const attemptRows = [];
    for (const ids of batchesOf(queuedRunIds, RELATIONAL_ID_QUERY_BATCH_SIZE)) {
      attemptRows.push(
        ...(await this.handle.db
          .select()
          .from(pgRunAttempts)
          .where(inArray(pgRunAttempts.executionRunId, ids))),
      );
    }
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
         WHERE b.project_id=$1
           AND b.status IN ('queued','dispatching','scheduled','running')
           AND r.status IN ('assigned','running')
           AND a.status IN ('assigned','running')`,
        [batch.projectId],
      ),
    ]);
    const retryContextValue = await retryContext(this.handle, batch);
    const [runtimeRow] = await this.handle.db
      .select({ adapterRuntimeJson: pgRunBatches.adapterRuntimeJson })
      .from(pgRunBatches)
      .where(eq(pgRunBatches.id, batchId))
      .limit(1);
    const adapterRuntime = parseProjectAdapterRuntime(runtimeRow?.adapterRuntimeJson ?? null);
    const [retryConcurrencyStateRow] = await this.handle.db
      .select()
      .from(pgRunBatchRetryConcurrencyStates)
      .where(eq(pgRunBatchRetryConcurrencyStates.batchId, batchId))
      .limit(1);
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
      queuedRuns: queuedRows.map(toExecutionRun),
      candidates,
      runnerFailureIdsByRun: runnerFailureIdsByExecutionRun(attemptRows.map(toRunAttempt)),
      projectActiveRuns: Number(activeProjectRuns.rows[0]?.count ?? 0),
      ...(retryConcurrencyStateRow
        ? { retryConcurrencyState: retryConcurrencyStateFromRow(retryConcurrencyStateRow) }
        : {}),
      retryContext: retryContextValue,
    };
  }

  async activateRetryConcurrency(
    input: Parameters<RunBatchRepository["activateRetryConcurrency"]>[0],
  ): Promise<RetryConcurrencyState | null> {
    await this.ready();
    return this.handle.db.transaction(async (transaction) => {
      const [batch] = await transaction
        .select({ currentRound: pgRunBatches.currentRound, policyJson: pgRunBatches.policyJson })
        .from(pgRunBatches)
        .where(eq(pgRunBatches.id, input.batchId))
        .for("update");
      if (!batch) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
      const [storedRow] = await transaction
        .select()
        .from(pgRunBatchRetryConcurrencyStates)
        .where(eq(pgRunBatchRetryConcurrencyStates.batchId, input.batchId))
        .limit(1);
      const storedState = storedRow ? retryConcurrencyStateFromRow(storedRow) : undefined;
      const activation = retryConcurrencyActivationDecision(storedState, batch.currentRound, input);
      if (activation.outcome === "stale") return null;
      if (activation.outcome === "unchanged") return activation.state;
      assertRetryConcurrencyTransition(
        batchPolicy(batch.policyJson),
        input.executionRound,
        input.state,
      );
      await transaction
        .insert(pgRunBatchRetryConcurrencyStates)
        .values({ batchId: input.batchId, ...input.state, updatedAt: input.updatedAt })
        .onConflictDoUpdate({
          target: pgRunBatchRetryConcurrencyStates.batchId,
          set: { ...input.state, updatedAt: input.updatedAt },
        });
      return input.state;
    });
  }

  async recordRoundConcurrency(
    input: Parameters<RunBatchRepository["recordRoundConcurrency"]>[0],
  ): Promise<"created" | "existing"> {
    await this.ready();
    return this.handle.db.transaction(async (transaction) => {
      const [existing] = await transaction
        .select({
          batchId: pgRunBatchRoundConcurrencies.batchId,
          concurrency: pgRunBatchRoundConcurrencies.concurrency,
          source: pgRunBatchRoundConcurrencies.source,
          ruleId: pgRunBatchRoundConcurrencies.ruleId,
        })
        .from(pgRunBatchRoundConcurrencies)
        .where(
          and(
            eq(pgRunBatchRoundConcurrencies.batchId, input.batchId),
            eq(pgRunBatchRoundConcurrencies.executionRound, input.round),
          ),
        )
        .for("update");
      if (existing) {
        if (input.transitionEvent && !sameRoundConcurrencyTransition(existing, input)) {
          await transaction
            .update(pgRunBatchRoundConcurrencies)
            .set({
              concurrency: input.concurrency,
              source: "rule_transition",
              ruleId: input.ruleId,
              previousConcurrency: input.previousConcurrency,
              recordedAt: input.recordedAt,
            })
            .where(
              and(
                eq(pgRunBatchRoundConcurrencies.batchId, input.batchId),
                eq(pgRunBatchRoundConcurrencies.executionRound, input.round),
              ),
            );
          await transaction.execute(sql`
            INSERT INTO scheduling_events
              (id, batch_id, event_type, message, payload_json, recorded_at)
            VALUES
              (${input.transitionEvent.id}, ${input.batchId},
               'retry_concurrency_changed', ${input.transitionEvent.message},
               ${JSON.stringify(input.transitionEvent.payload)}::jsonb, ${input.recordedAt})
            ON CONFLICT (id) DO NOTHING
          `);
        }
        return "existing";
      }
      const inserted = await transaction
        .insert(pgRunBatchRoundConcurrencies)
        .values({
          batchId: input.batchId,
          executionRound: input.round,
          concurrency: input.concurrency,
          source: input.source,
          ruleId: input.ruleId,
          previousConcurrency: input.previousConcurrency,
          recordedAt: input.recordedAt,
        })
        .onConflictDoNothing()
        .returning({ batchId: pgRunBatchRoundConcurrencies.batchId });
      if (inserted.length === 0) {
        const [concurrent] = await transaction
          .select({
            concurrency: pgRunBatchRoundConcurrencies.concurrency,
            source: pgRunBatchRoundConcurrencies.source,
            ruleId: pgRunBatchRoundConcurrencies.ruleId,
          })
          .from(pgRunBatchRoundConcurrencies)
          .where(
            and(
              eq(pgRunBatchRoundConcurrencies.batchId, input.batchId),
              eq(pgRunBatchRoundConcurrencies.executionRound, input.round),
            ),
          )
          .limit(1);
        if (
          input.transitionEvent &&
          concurrent &&
          !sameRoundConcurrencyTransition(concurrent, input)
        ) {
          await transaction
            .update(pgRunBatchRoundConcurrencies)
            .set({
              concurrency: input.concurrency,
              source: "rule_transition",
              ruleId: input.ruleId,
              previousConcurrency: input.previousConcurrency,
              recordedAt: input.recordedAt,
            })
            .where(
              and(
                eq(pgRunBatchRoundConcurrencies.batchId, input.batchId),
                eq(pgRunBatchRoundConcurrencies.executionRound, input.round),
              ),
            );
          await transaction.execute(sql`
            INSERT INTO scheduling_events
              (id, batch_id, event_type, message, payload_json, recorded_at)
            VALUES
              (${input.transitionEvent.id}, ${input.batchId},
               'retry_concurrency_changed', ${input.transitionEvent.message},
               ${JSON.stringify(input.transitionEvent.payload)}::jsonb, ${input.recordedAt})
            ON CONFLICT (id) DO NOTHING
          `);
        }
        return "existing";
      }
      if (input.transitionEvent) {
        await transaction.execute(sql`
          INSERT INTO scheduling_events
            (id, batch_id, event_type, message, payload_json, recorded_at)
          VALUES
            (${input.transitionEvent.id}, ${input.batchId},
             'retry_concurrency_changed', ${input.transitionEvent.message},
             ${JSON.stringify(input.transitionEvent.payload)}::jsonb, ${input.recordedAt})
        `);
      }
      return "created";
    });
  }

  async hasSchedulableRuns(batchId: string): Promise<boolean> {
    await this.ready();
    const result = await this.handle.pool.query<{ value: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM execution_runs
         WHERE batch_id = $1 AND status = 'queued' AND held_round = 0
       ) AS value`,
      [batchId],
    );
    return Boolean(result.rows[0]?.value);
  }

  async reserveAssignments(
    input: ReserveSchedulingAssignmentsInput,
  ): Promise<ReserveAssignmentsOutcome> {
    await this.ready();
    return this.handle.db.transaction(async (transaction) => {
      const [lockedBatch] = await transaction
        .select({
          projectId: pgRunBatches.projectId,
          policyJson: pgRunBatches.policyJson,
          adapterRuntimeJson: pgRunBatches.adapterRuntimeJson,
          terminationRequestedAt: pgRunBatches.cancelRequestedAt,
          environmentJson: pgRunBatches.environmentJson,
          secretBindingsJson: pgRunBatches.secretBindingsJson,
          priority: pgRunBatches.priority,
          claimTimeoutMs: pgRunBatches.claimTimeoutMs,
          executionTimeoutMs: pgRunBatches.executionTimeoutMs,
          uploadTimeoutMs: pgRunBatches.uploadTimeoutMs,
        })
        .from(pgRunBatches)
        .where(eq(pgRunBatches.id, input.batchId))
        .for("update");
      if (!lockedBatch) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
      if (lockedBatch.terminationRequestedAt) return { reserved: 0, acceptedAttemptIds: [] };
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
      const policy = batchPolicy(lockedBatch.policyJson);
      const [retryConcurrencyState] = await transaction
        .select({ concurrency: pgRunBatchRetryConcurrencyStates.concurrency })
        .from(pgRunBatchRetryConcurrencyStates)
        .where(eq(pgRunBatchRetryConcurrencyStates.batchId, input.batchId))
        .limit(1);
      const batchConcurrency = retryConcurrencyState?.concurrency ?? policy?.concurrency;
      const adapterRuntime = parseProjectAdapterRuntime(lockedBatch.adapterRuntimeJson);
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

      // 决策过滤完全在内存中按序进行（槽位扣减、运行机资格与资源评估），
      // 只有被接受的决策进入后续批量写入；单事务内每类写入各一条语句。
      const acceptedDecisions: Array<
        ReserveSchedulingAssignmentsInput["decisions"][number] & { score: number }
      > = [];
      for (const decision of input.decisions) {
        if (remainingProjectSlots === 0 || remainingBatchSlots === 0) break;
        const runnerRow = runnerById.get(decision.runnerId);
        if (!runnerRow) continue;
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
        acceptedDecisions.push({ ...decision, score: evaluation.score });
        reservations.set(decision.runnerId, (reservations.get(decision.runnerId) ?? 0) + 1);
        remainingProjectSlots -= 1;
        remainingBatchSlots -= 1;
      }

      let accepted = 0;
      const acceptedAttemptIds: string[] = [];
      if (acceptedDecisions.length > 0) {
        // 批量条件迁移：仅仍排队的 run 可被分配。被并发调度轮抢先的 run 不产生
        // attempt；其槽位本轮视为已消耗（下一调度轮自愈），保证语句有界且不回滚。
        // 大批量写入用 unnest 数组参数：每行展开的 VALUES 参数会让语句绑定开销
        // 随行数线性放大（500 行实测比等量 unnest 慢一个数量级）。
        const updatedRuns = await transaction.execute<{
          id: string;
          attempt_count: number;
          case_definition_id: string;
          execution_case_definition_id: string | null;
          case_version: number;
          class_name: string;
          parameters_json: string;
          class_data_size_bytes: number | null;
          class_data_sha256: string | null;
        }>(sql`
          UPDATE execution_runs run
          SET status = 'assigned',
              assigned_runner_id = decision.runner_id,
              attempt_count = run.attempt_count + 1,
              scheduling_score = decision.score,
              assigned_at = ${input.scheduledAt},
              updated_at = ${input.scheduledAt}
          FROM jsonb_to_recordset(${JSON.stringify(
            acceptedDecisions.map((decision) => ({
              run_id: decision.executionRunId,
              runner_id: decision.runnerId,
              score: decision.score,
            })),
          )}::jsonb) AS decision(run_id text, runner_id text, score float8)
          WHERE run.id = decision.run_id
            AND run.batch_id = ${input.batchId}
            AND run.status = 'queued'
            AND run.held_round = 0
            AND (run.queue_deadline_at IS NULL OR run.queue_deadline_at > ${input.scheduledAt})
          RETURNING run.id, run.attempt_count, run.case_definition_id, run.case_version,
                    run.execution_case_definition_id, run.class_name, run.parameters_json,
                    run.class_data_size_bytes, run.class_data_sha256`);
        const updatedRunById = new Map(updatedRuns.rows.map((row) => [row.id, row]));
        const reservedDecisions = acceptedDecisions.filter((decision) =>
          updatedRunById.has(decision.executionRunId),
        );
        if (reservedDecisions.length > 0) {
          // 一次性预取全部用例版本的来源 JAR，避免逐决策查询。
          const uniqueCaseVersions = [
            ...new Map(
              reservedDecisions.map((decision) => {
                const run = updatedRunById.get(decision.executionRunId)!;
                return [
                  `${run.execution_case_definition_id ?? run.case_definition_id}:${run.case_version}`,
                  {
                    caseDefinitionId: run.execution_case_definition_id ?? run.case_definition_id,
                    caseVersion: run.case_version,
                  },
                ] as const;
              }),
            ).values(),
          ];
          const sources = await transaction.execute<{
            case_definition_id: string;
            version: number;
            id: string;
            sha256: string;
            size_bytes: string | number;
          }>(sql`
            SELECT cv.case_definition_id, cv.version, cs.id, cs.sha256, cs.size_bytes
            FROM case_versions cv
            JOIN case_sources cs ON cs.id = cv.source_id
            JOIN jsonb_to_recordset(${JSON.stringify(
              uniqueCaseVersions.map((pair) => ({
                case_definition_id: pair.caseDefinitionId,
                version: pair.caseVersion,
              })),
            )}::jsonb) AS pairs(case_definition_id text, version integer)
              ON cv.case_definition_id = pairs.case_definition_id
             AND cv.version = pairs.version`);
          const sourceByCase = new Map(
            sources.rows.map((row) => [
              `${row.case_definition_id}:${row.version}`,
              { id: row.id, sha256: row.sha256, sizeBytes: Number(row.size_bytes) },
            ]),
          );
          const attemptRows = [];
          const assignmentRows = [];
          for (const decision of reservedDecisions) {
            const run = updatedRunById.get(decision.executionRunId)!;
            const source = sourceByCase.get(
              `${run.execution_case_definition_id ?? run.case_definition_id}:${run.case_version}`,
            );
            if (!source) throw new Error("Cannot schedule a case without its source JAR.");
            attemptRows.push({
              id: decision.attemptId,
              executionRunId: decision.executionRunId,
              runnerId: decision.runnerId,
              attemptNumber: run.attempt_count,
              status: "assigned" as const,
              schedulingScore: decision.score,
              createdAt: input.scheduledAt,
            });
            assignmentRows.push({
              id: decision.assignmentId,
              attemptId: decision.attemptId,
              executionRunId: decision.executionRunId,
              batchId: input.batchId,
              runnerId: decision.runnerId,
              status: "pending" as const,
              priority: lockedBatch.priority,
              executionSpecJson: JSON.stringify(
                executionSpec({
                  attemptId: decision.attemptId,
                  executionRunId: decision.executionRunId,
                  batchId: input.batchId,
                  className: run.class_name,
                  parameters: stringRecord(run.parameters_json),
                  source,
                  ...(run.class_data_size_bytes && run.class_data_sha256
                    ? {
                        classData: {
                          sizeBytes: Number(run.class_data_size_bytes),
                          sha256: run.class_data_sha256,
                        },
                      }
                    : {}),
                  ...(adapterRuntime ? { adapterRuntime } : {}),
                  environment: environmentVariables(lockedBatch.environmentJson),
                  secretBindings: secretBindings(lockedBatch.secretBindingsJson),
                  executionTimeoutMs: lockedBatch.executionTimeoutMs,
                  uploadTimeoutMs: lockedBatch.uploadTimeoutMs,
                  caseTimeoutSeconds: this.caseExecutionTimeoutSeconds,
                  ...(policy ? { policy } : {}),
                }),
              ),
              availableAt: input.scheduledAt,
              claimDeadlineAt: addMilliseconds(input.scheduledAt, lockedBatch.claimTimeoutMs),
              createdAt: input.scheduledAt,
              updatedAt: input.scheduledAt,
            });
          }
          for (const rows of batchesOf(attemptRows, POSTGRES_WRITE_BATCH_SIZE)) {
            await transaction.execute(sql`
              INSERT INTO run_attempts
                (id, execution_run_id, runner_id, attempt_number, status, scheduling_score, created_at)
              SELECT s.id, s.execution_run_id, s.runner_id, s.attempt_number, 'assigned',
                     s.scheduling_score, ${input.scheduledAt}
              FROM jsonb_to_recordset(${JSON.stringify(
                rows.map((row) => ({
                  id: row.id,
                  execution_run_id: row.executionRunId,
                  runner_id: row.runnerId,
                  attempt_number: row.attemptNumber,
                  scheduling_score: row.schedulingScore,
                })),
              )}::jsonb)
                     AS s(id text, execution_run_id text, runner_id text, attempt_number integer,
                          scheduling_score float8)`);
          }
          for (const rows of batchesOf(assignmentRows, POSTGRES_WRITE_BATCH_SIZE)) {
            await transaction.execute(sql`
              INSERT INTO assignments
                (id, attempt_id, execution_run_id, batch_id, runner_id, status, priority,
                 execution_spec_json, available_at, claim_deadline_at, created_at, updated_at)
              SELECT s.id, s.attempt_id, s.execution_run_id, ${input.batchId}, s.runner_id,
                     'pending', s.priority, s.execution_spec_json, ${input.scheduledAt},
                     ${addMilliseconds(input.scheduledAt, lockedBatch.claimTimeoutMs)},
                     ${input.scheduledAt}, ${input.scheduledAt}
              FROM jsonb_to_recordset(${JSON.stringify(
                rows.map((row) => ({
                  id: row.id,
                  attempt_id: row.attemptId,
                  execution_run_id: row.executionRunId,
                  runner_id: row.runnerId,
                  priority: row.priority,
                  execution_spec_json: row.executionSpecJson,
                })),
              )}::jsonb)
                     AS s(id text, attempt_id text, execution_run_id text, runner_id text,
                          priority integer, execution_spec_json text)`);
          }
          accepted = reservedDecisions.length;
          acceptedAttemptIds.push(...reservedDecisions.map((decision) => decision.attemptId));
        }
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
      return { reserved: accepted, acceptedAttemptIds };
    });
  }

  async appendSchedulingEvents(
    events: Parameters<RunBatchRepository["appendSchedulingEvents"]>[0],
  ): Promise<void> {
    if (events.length === 0) return;
    await this.ready();
    await insertSchedulingEventDrafts(this.handle.pool, events);
  }

  async listSchedulingEvents(
    input: Parameters<RunBatchRepository["listSchedulingEvents"]>[0],
  ): ReturnType<RunBatchRepository["listSchedulingEvents"]> {
    await this.ready();
    const limit = Math.min(Math.max(1, Math.trunc(input.limit)), 500);
    if (input.afterId !== undefined && (input.beforeId !== undefined || input.latest === true)) {
      throw new TypeError("Scheduling event cursors cannot mix forward and backward reads.");
    }
    const backwards = input.beforeId !== undefined || input.latest === true;
    const parameters: Array<string | number> = [input.batchId];
    let filters = "";
    if (input.runnerId !== undefined) {
      parameters.push(input.runnerId);
      filters += ` AND runner_id = $${parameters.length}`;
    }
    if (input.afterId !== undefined) {
      // 游标用 (recorded_at, id) 元组比较定位，id 为唯一键保证边界不重复、不遗漏。
      parameters.push(input.afterId);
      filters += ` AND (recorded_at, id) > (
        SELECT recorded_at, id FROM scheduling_events WHERE id = $${parameters.length})`;
    }
    if (input.beforeId !== undefined) {
      parameters.push(input.beforeId);
      filters += ` AND (recorded_at, id) < (
        SELECT recorded_at, id FROM scheduling_events WHERE id = $${parameters.length})`;
    }
    parameters.push(limit);
    const result = await this.handle.pool.query<{
      id: string;
      batch_id: string;
      runner_id: string | null;
      execution_run_id: string | null;
      attempt_id: string | null;
      event_type: SchedulingEventType;
      message: string;
      payload_json: string | null;
      recorded_at: string;
    }>(
      `SELECT id, batch_id, runner_id, execution_run_id, attempt_id, event_type,
              message, payload_json, recorded_at
       FROM scheduling_events
       WHERE batch_id = $1${filters}
       ORDER BY recorded_at ${backwards ? "DESC" : "ASC"}, id ${backwards ? "DESC" : "ASC"}
       LIMIT $${parameters.length}`,
      parameters,
    );
    const items = result.rows.map(schedulingEventFromRow);
    if (backwards) items.reverse();
    const cursor = backwards ? items.at(0) : items.at(-1);
    return {
      items,
      ...(items.length === limit && cursor
        ? backwards
          ? { nextBeforeId: cursor.id }
          : { nextAfterId: cursor.id }
        : {}),
    };
  }

  private async ready(): Promise<void> {
    await this.handle.ready;
  }

  private async mapBatch(row: typeof pgRunBatches.$inferSelect): Promise<RunBatch> {
    const [batch] = await this.mapBatches([row]);
    if (!batch) throw new Error(`Cannot map run batch ${row.id}.`);
    return batch;
  }

  /** 列表页按绑定参数上限分批读取关联计数，查询量不再随批次数线性增长。 */
  private async mapBatches(
    rows: Array<typeof pgRunBatches.$inferSelect>,
    preloadedRunnerIds?: Map<string, string[]>,
  ): Promise<RunBatch[]> {
    if (rows.length === 0) return [];
    const batchIds = rows.map((row) => row.id);
    let runnerIdsByBatch = preloadedRunnerIds;
    if (!runnerIdsByBatch) {
      const selectedRunnerRows = (
        await Promise.all(
          batchesOf(batchIds, RELATIONAL_ID_QUERY_BATCH_SIZE).map((ids) =>
            this.handle.db
              .select({ batchId: pgRunBatchRunners.batchId, runnerId: pgRunBatchRunners.runnerId })
              .from(pgRunBatchRunners)
              .where(inArray(pgRunBatchRunners.batchId, ids))
              .orderBy(pgRunBatchRunners.batchId, pgRunBatchRunners.runnerId),
          ),
        )
      ).flat();
      runnerIdsByBatch = new Map<string, string[]>();
      for (const runner of selectedRunnerRows) {
        const ids = runnerIdsByBatch.get(runner.batchId) ?? [];
        ids.push(runner.runnerId);
        runnerIdsByBatch.set(runner.batchId, ids);
      }
    }
    const { statusRows, outcomeRows } = await this.batchRunCounts(batchIds);
    const statusByBatch = new Map<string, Map<string, number>>();
    for (const entry of statusRows) {
      const counts = statusByBatch.get(entry.batchId) ?? new Map<string, number>();
      counts.set(entry.status, entry.value);
      statusByBatch.set(entry.batchId, counts);
    }
    const outcomesByBatch = new Map(outcomeRows.map((entry) => [entry.batchId, entry]));
    return rows.map((row) =>
      this.mapBatchRow(
        row,
        runnerIdsByBatch.get(row.id) ?? [],
        statusByBatch.get(row.id) ?? new Map(),
        outcomesByBatch.get(row.id),
      ),
    );
  }

  private mapBatchRow(
    row: typeof pgRunBatches.$inferSelect,
    selectedRunnerIds: string[],
    byStatus: Map<string, number>,
    outcomeCount: FinalOutcomeCounts | undefined,
  ): RunBatch {
    const policy = batchPolicy(row.policyJson);
    return {
      id: row.id,
      sequenceNumber: row.sequenceNumber,
      projectId: row.projectId,
      ...(row.environmentId ? { environmentId: row.environmentId } : {}),
      ...(row.environmentVersionId ? { environmentVersionId: row.environmentVersionId } : {}),
      suiteId: row.suiteId,
      suiteName: row.suiteName,
      suiteVersion: row.suiteVersion,
      kind: row.batchKind,
      ...(row.parentBatchId ? { parentBatchId: row.parentBatchId } : {}),
      ...(row.sourceExecutionRunId ? { sourceExecutionRunId: row.sourceExecutionRunId } : {}),
      ...(row.requestedByUsername && row.requestedBySource
        ? {
            requestedBy: {
              username: row.requestedByUsername,
              source: row.requestedBySource,
            },
          }
        : {}),
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
      succeededRuns: Number(outcomeCount?.succeeded ?? byStatus.get("succeeded") ?? 0),
      failedRuns: Number(outcomeCount?.failed ?? 0),
      timedOutRuns: Number(outcomeCount?.timedOut ?? 0),
      cancelledRuns: Number(outcomeCount?.cancelled ?? byStatus.get("cancelled") ?? 0),
      ...(row.cancelRequestedAt ? { terminationRequestedAt: row.cancelRequestedAt } : {}),
      version: row.version,
      scheduledFor: row.scheduledFor,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * 状态计数与最终结果计数合并为单条重试安全查询：按“总结”规则（成功优先、
   * attempt_number 倒序）为每个 run 挑选决定结果的 attempt，再按批次状态与
   * 最终结果分组。attempt_count > 1 的 run 才可能有多条 attempt 竞争结果；
   * 无重试批次（探针热路径）的 CTE 因此是空扫描，不再随在途 attempt 更新
   * 反复扫描 run_attempts。与 SQLite 仓储的无重试快速路径语义一致。
   */
  private async batchRunCounts(batchIds: readonly string[]): Promise<{
    statusRows: Array<{ batchId: string; status: string; value: number }>;
    outcomeRows: FinalOutcomeCounts[];
  }> {
    if (batchIds.length === 0) return { statusRows: [], outcomeRows: [] };
    const mergedRows = (
      await Promise.all(
        batchesOf(batchIds, RELATIONAL_ID_QUERY_BATCH_SIZE).map((ids) =>
          this.handle.pool.query<{
            batchId: string;
            status: string;
            finalOutcome: string | null;
            value: string;
          }>(
            `WITH ranked_attempts AS (
               SELECT attempt.execution_run_id,
                      COALESCE(attempt.outcome, attempt.status) AS attempt_outcome,
                      ROW_NUMBER() OVER (
                        PARTITION BY attempt.execution_run_id
                        ORDER BY CASE WHEN COALESCE(attempt.outcome, attempt.status) = 'succeeded'
                                      THEN 0 ELSE 1 END,
                                 attempt.attempt_number DESC
                      ) AS outcome_rank
               FROM run_attempts attempt
               WHERE attempt.execution_run_id IN (
                 SELECT id FROM execution_runs
                 WHERE batch_id = ANY($1::text[]) AND attempt_count > 1
               )
             )
             SELECT run.batch_id AS "batchId",
                    run.status AS status,
                    COALESCE(selected.attempt_outcome,
                      run.terminal_outcome,
                      CASE WHEN run.status IN ('succeeded','failed','cancelled')
                           THEN run.status END
                    ) AS "finalOutcome",
                    count(*)::text AS value
             FROM execution_runs run
             LEFT JOIN ranked_attempts selected
               ON selected.execution_run_id = run.id AND selected.outcome_rank = 1
             WHERE run.batch_id = ANY($1::text[])
             GROUP BY 1, 2, 3`,
            [ids],
          ),
        ),
      )
    )
      .flat()
      .flatMap((result) => result.rows);
    const statusAggregates = new Map<string, Map<string, number>>();
    const outcomeAggregates = new Map<
      string,
      { succeeded: number; failed: number; timedOut: number; cancelled: number }
    >();
    for (const row of mergedRows) {
      const value = Number(row.value);
      const statuses = statusAggregates.get(row.batchId) ?? new Map<string, number>();
      statuses.set(row.status, (statuses.get(row.status) ?? 0) + value);
      statusAggregates.set(row.batchId, statuses);
      if (row.finalOutcome === null) continue;
      const outcomes = outcomeAggregates.get(row.batchId) ?? {
        succeeded: 0,
        failed: 0,
        timedOut: 0,
        cancelled: 0,
      };
      if (row.finalOutcome === "succeeded") outcomes.succeeded += value;
      else if (row.finalOutcome === "failed") outcomes.failed += value;
      else if (row.finalOutcome === "timed_out") outcomes.timedOut += value;
      else if (row.finalOutcome === "cancelled") outcomes.cancelled += value;
      outcomeAggregates.set(row.batchId, outcomes);
    }
    return {
      statusRows: [...statusAggregates.entries()].flatMap(([batchId, statuses]) =>
        [...statuses.entries()].map(([status, value]) => ({ batchId, status, value })),
      ),
      outcomeRows: [...outcomeAggregates.entries()].map(([batchId, outcomes]) => ({
        batchId,
        ...outcomes,
      })),
    };
  }

  private async activeReservations(runnerIds: string[]): Promise<Map<string, number>> {
    if (runnerIds.length === 0) return new Map();
    return new Map(
      (
        await this.handle.db
          .select({ runnerId: pgRunAttempts.runnerId, value: count() })
          .from(pgRunAttempts)
          .innerJoin(pgExecutionRuns, eq(pgExecutionRuns.id, pgRunAttempts.executionRunId))
          .innerJoin(pgRunBatches, eq(pgRunBatches.id, pgExecutionRuns.batchId))
          .where(
            and(
              inArray(pgRunAttempts.runnerId, runnerIds),
              inArray(pgRunAttempts.status, [...activeAttemptStatuses]),
              inArray(pgExecutionRuns.status, [...activeAttemptStatuses]),
              inArray(pgRunBatches.status, [...activeBatchStatuses]),
            ),
          )
          .groupBy(pgRunAttempts.runnerId)
      ).map((row) => [row.runnerId, row.value]),
    );
  }
}

type NormalizedPostgresRoundRow = Omit<
  SqliteCompatibleRoundAggregate,
  "startedAt" | "finishedAt"
> & {
  startedAt: string | null;
  finishedAt: string | null;
};

type SqliteCompatibleRoundAggregate = {
  round: number;
  totalRuns: number;
  executed: number;
  passed: number;
  failed: number;
  timedOut: number;
  cancelled: number;
  active: number;
  startedAt: string | null;
  finishedAt: string | null;
};

function normalizePostgresRoundRow(row: PostgresRoundAggregateRow): NormalizedPostgresRoundRow {
  return {
    round: Number(row.round),
    totalRuns: Number(row.totalRuns),
    executed: Number(row.executed),
    passed: Number(row.passed),
    failed: Number(row.failed),
    timedOut: Number(row.timedOut),
    cancelled: Number(row.cancelled),
    active: Number(row.active),
    startedAt: row.startedAt ? isoTimestamp(row.startedAt) : null,
    finishedAt: row.finishedAt ? isoTimestamp(row.finishedAt) : null,
  };
}

function mapPostgresRoundSummaries(
  batch: RunBatch,
  rows: readonly NormalizedPostgresRoundRow[],
  firstPassRows: readonly { firstRound: number; count: number }[],
): RunBatchRoundSummary[] {
  let overallPassed = 0;
  const firstPassByRound = new Map(firstPassRows.map((row) => [row.firstRound, row.count]));
  return rows.map((row) => {
    overallPassed += firstPassByRound.get(row.round) ?? 0;
    const completed = row.passed + row.failed + row.timedOut + row.cancelled;
    const status = postgresRoundAggregateStatus(batch, row);
    return {
      round: row.round,
      status,
      totalRuns: row.totalRuns,
      executed: row.executed,
      passed: row.passed,
      failed: row.failed,
      timedOut: row.timedOut,
      cancelled: row.cancelled,
      notExecuted: Math.max(0, row.totalRuns - row.executed),
      roundPassRate: completed === 0 ? null : Math.round((row.passed / completed) * 100),
      overallPassed,
      overallPassRate:
        batch.totalRuns === 0 ? 0 : Math.round((overallPassed / batch.totalRuns) * 100),
      startedAt: row.startedAt,
      durationMs:
        status === "running" || !row.startedAt || !row.finishedAt
          ? null
          : Math.max(0, Date.parse(row.finishedAt) - Date.parse(row.startedAt)),
    };
  });
}

function postgresRoundAggregateStatus(
  batch: RunBatch,
  row: NormalizedPostgresRoundRow,
): RunBatchRoundSummary["status"] {
  if (row.active > 0) return "running";
  if (
    ["succeeded", "failed", "cancelled"].includes(batch.status) ||
    row.round < batch.currentRound
  ) {
    return "completed";
  }
  if (batch.retryMode === "immediate") {
    if (row.executed === 0) return "waiting";
    return row.executed < row.totalRuns ? "running" : "completed";
  }
  if (row.round > batch.currentRound || row.executed === 0) return "waiting";
  return row.executed < row.totalRuns ? "running" : "completed";
}

function postgresAllRoundsSummary(summaries: readonly RunBatchRoundSummary[]) {
  const values = summaries.reduce(
    (total, row) => ({
      totalRuns: total.totalRuns + row.totalRuns,
      passed: total.passed + row.passed,
      failed: total.failed + row.failed,
      timedOut: total.timedOut + row.timedOut,
      cancelled: total.cancelled + row.cancelled,
      notExecuted: total.notExecuted + row.notExecuted,
    }),
    { totalRuns: 0, passed: 0, failed: 0, timedOut: 0, cancelled: 0, notExecuted: 0 },
  );
  return {
    ...values,
    passRate: values.totalRuns === 0 ? 0 : Math.round((values.passed / values.totalRuns) * 100),
  };
}

function postgresFinalSummaryFromBatch(batch: RunBatch) {
  const terminal =
    batch.succeededRuns + batch.failedRuns + batch.timedOutRuns + batch.cancelledRuns;
  return {
    totalRuns: batch.totalRuns,
    passed: batch.succeededRuns,
    failed: batch.failedRuns,
    timedOut: batch.timedOutRuns,
    cancelled: batch.cancelledRuns,
    notExecuted: Math.max(0, batch.totalRuns - terminal),
    passRate: batch.totalRuns === 0 ? 0 : Math.round((batch.succeededRuns / batch.totalRuns) * 100),
  };
}

function latestPostgresBatchActivity(
  updatedAt: string,
  rounds: readonly NormalizedPostgresRoundRow[],
  recoveries: readonly RoundRecoveryDetailRow[],
): string {
  let latest = updatedAt;
  const candidates = [
    ...rounds.map((row) => row.finishedAt),
    ...recoveries.map((recovery) => isoTimestamp(recovery.updated_at)),
  ];
  for (const candidate of candidates) {
    if (candidate && Date.parse(candidate) > Date.parse(latest)) latest = candidate;
  }
  return latest;
}

function postgresCasePageQuery(input: RunBatchCasePageQuery): {
  sqlText: string;
  parameters: unknown[];
} {
  const parameters: unknown[] = [input.batchId];
  let scopeCte: string;
  if (input.scope === "summary") {
    scopeCte = `, ranked_attempts AS (
      SELECT attempt.id,attempt.execution_run_id,attempt.attempt_number,
             ROW_NUMBER() OVER (
               PARTITION BY attempt.execution_run_id
               ORDER BY CASE WHEN COALESCE(attempt.outcome,attempt.status)='succeeded' THEN 0 ELSE 1 END,
                        attempt.attempt_number DESC
             ) AS rank
      FROM run_attempts attempt JOIN batch_runs run ON run.id=attempt.execution_run_id
    ), scope_rows AS (
      SELECT run.id AS execution_run_id,COALESCE(attempt.attempt_number,1) AS round,
             attempt.id AS attempt_id
      FROM batch_runs run LEFT JOIN ranked_attempts attempt
        ON attempt.execution_run_id=run.id AND attempt.rank=1
    )`;
  } else {
    const roundPlaceholder =
      input.scope === "all" ? undefined : pushPostgresParameter(parameters, input.scope);
    scopeCte = `, scope_rows AS (
      SELECT eligible.execution_run_id,eligible.round,attempt.id AS attempt_id
      FROM eligible_runs eligible LEFT JOIN run_attempts attempt
        ON attempt.execution_run_id=eligible.execution_run_id
       AND attempt.attempt_number=eligible.round
      ${roundPlaceholder ? `WHERE eligible.round=${roundPlaceholder}` : ""}
    )`;
  }
  const where: string[] = [];
  if (input.status === "pending") where.push("scope.attempt_id IS NULL");
  else if (input.status) {
    where.push(`attempt.status=${pushPostgresParameter(parameters, input.status)}`);
  }
  if (input.query?.trim()) {
    where.push(
      `LOWER(run.display_name || ' ' || run.class_name) LIKE ${pushPostgresParameter(parameters, `%${escapePostgresLike(input.query.trim().toLowerCase())}%`)} ESCAPE '\\'`,
    );
  }
  const direction = input.direction === "desc" ? "DESC" : "ASC";
  const sortExpression = {
    none: "run.created_at ASC,run.id ASC,scope.round ASC",
    name: `run.display_name ${direction},run.id ${direction},scope.round ${direction}`,
    status: `CASE COALESCE(attempt.status,'pending')
      WHEN 'succeeded' THEN 0 WHEN 'failed' THEN 1 WHEN 'timed_out' THEN 2
      WHEN 'cancelled' THEN 3 WHEN 'running' THEN 4 WHEN 'assigned' THEN 5 ELSE 6 END ${direction},
      run.display_name ${direction}`,
    runner: `COALESCE(attempt.runner_id,run.assigned_runner_id,'') ${direction},run.display_name ${direction}`,
    duration: `CASE WHEN attempt.duration_ms IS NULL THEN 1 ELSE 0 END ASC,attempt.duration_ms ${direction},run.display_name ${direction}`,
  }[input.sort];
  const limit = pushPostgresParameter(parameters, input.limit);
  const offset = pushPostgresParameter(parameters, input.offset);
  return {
    sqlText: `${POSTGRES_BATCH_ROUND_CTES}${scopeCte}
      SELECT scope.execution_run_id AS "runId",scope.attempt_id AS "attemptId",scope.round,
             COUNT(*) OVER () AS total
      FROM scope_rows scope JOIN batch_runs run ON run.id=scope.execution_run_id
      LEFT JOIN run_attempts attempt ON attempt.id=scope.attempt_id
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${sortExpression} LIMIT ${limit} OFFSET ${offset}`,
    parameters,
  };
}

function pushPostgresParameter(parameters: unknown[], value: unknown): string {
  parameters.push(value);
  return `$${parameters.length}`;
}

function escapePostgresLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

function toRoundRecoveryDetail(row: RoundRecoveryDetailRow): RunBatchRoundRecovery {
  return {
    ruleId: row.rule_id,
    afterRound: row.after_round,
    nextRound: row.next_round,
    jenkinsJobUrl: row.jenkins_job_url,
    waitMinutes: row.wait_minutes,
    status: row.status,
    ...(row.source_build_number === null ? {} : { sourceBuildNumber: row.source_build_number }),
    ...(row.rebuild_number === null ? {} : { rebuildNumber: row.rebuild_number }),
    ...(row.rebuild_url === null ? {} : { rebuildUrl: row.rebuild_url }),
    ...(row.activated_at === null ? {} : { activatedAt: isoTimestamp(row.activated_at) }),
    ...(row.started_at === null ? {} : { startedAt: isoTimestamp(row.started_at) }),
    ...(row.finished_at === null ? {} : { finishedAt: isoTimestamp(row.finished_at) }),
    ...(row.build_result === null ? {} : { buildResult: row.build_result }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

function toRoundConcurrency(
  row: typeof pgRunBatchRoundConcurrencies.$inferSelect,
): RunBatchRoundConcurrency {
  return {
    round: row.executionRound,
    concurrency: row.concurrency,
    source: row.source,
    ...(row.ruleId ? { ruleId: row.ruleId } : {}),
    ...(row.previousConcurrency === null ? {} : { previousConcurrency: row.previousConcurrency }),
    recordedAt: isoTimestamp(row.recordedAt),
  };
}

function sameRoundConcurrencyTransition(
  current: { concurrency: number; source: string; ruleId: string | null },
  input: { concurrency: number; ruleId?: string },
): boolean {
  return (
    current.source === "rule_transition" &&
    current.ruleId === (input.ruleId ?? null) &&
    current.concurrency === input.concurrency
  );
}

function finalFailureRunCondition(table: typeof pgExecutionRuns) {
  return sql`COALESCE(
    (SELECT COALESCE(attempt.outcome, attempt.status)
       FROM run_attempts attempt
      WHERE attempt.execution_run_id = ${table.id}
      ORDER BY CASE WHEN COALESCE(attempt.outcome, attempt.status) = 'succeeded'
                    THEN 0 ELSE 1 END,
               attempt.attempt_number DESC
      LIMIT 1),
    ${table.terminalOutcome},
    CASE WHEN ${table.status} IN ('succeeded','failed','cancelled') THEN ${table.status} END
  ) IN ('failed','timed_out')`;
}

function isoTimestamp(value: DatabaseTimestamp): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type FinalOutcomeCounts = {
  batchId: string;
  succeeded: number;
  failed: number;
  timedOut: number;
  cancelled: number;
};

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
      ...(typeof record.projectVersionId === "string" && record.projectVersionId
        ? { projectVersionId: record.projectVersionId }
        : {}),
      runnerLabels: Array.isArray(record.runnerLabels)
        ? record.runnerLabels.filter((label): label is string => typeof label === "string")
        : [],
      artifactPatterns: Array.isArray(record.artifactPatterns)
        ? record.artifactPatterns.filter(
            (pattern): pattern is string => typeof pattern === "string",
          )
        : ["reports/testng/**"],
      retryConcurrencyRules: retryConcurrencyRules(record.retryConcurrencyRules),
    };
  } catch {
    return undefined;
  }
}

function retryConcurrencyRules(
  value: unknown,
): NonNullable<RunBatchExecutionPolicy["retryConcurrencyRules"]> {
  return normalizeStoredRetryConcurrencyRules(value);
}

async function retryContext(
  handle: PostgresDatabaseHandle,
  batch: RunBatch,
): Promise<NonNullable<SchedulingSnapshot["retryContext"]>> {
  const remainingResult = await handle.pool.query<{ value: string }>(
    `SELECT COUNT(*) AS value FROM execution_runs
     WHERE batch_id = $1 AND (
       status IN ('assigned', 'running') OR (status = 'queued' AND held_round = 0)
     )`,
    [batch.id],
  );
  const remainingRuns = Number(remainingResult.rows[0]?.value ?? 0);
  if (batch.currentRound <= 1) {
    return { executionRound: batch.currentRound, previousRoundPassRate: null, remainingRuns };
  }
  const previousResult = await handle.pool.query<{ passed: string; completed: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE a.status = 'succeeded') AS passed,
       COUNT(*) FILTER (WHERE a.status IN ('succeeded','failed','timed_out','cancelled')) AS completed
     FROM run_attempts a JOIN execution_runs r ON r.id = a.execution_run_id
     WHERE r.batch_id = $1 AND a.attempt_number = $2`,
    [batch.id, batch.currentRound - 1],
  );
  const previous = previousResult.rows[0];
  const completed = Number(previous?.completed ?? 0);
  return {
    executionRound: batch.currentRound,
    previousRoundPassRate:
      completed === 0 ? null : Math.round((Number(previous?.passed ?? 0) / completed) * 100),
    remainingRuns,
  };
}

function executionSpec(input: {
  attemptId: string;
  executionRunId: string;
  batchId: string;
  className: string;
  parameters: Record<string, string>;
  source: { id: string; sha256: string; sizeBytes: number };
  classData?: { sizeBytes: number; sha256: string };
  adapterRuntime?: ProjectAdapterRuntime;
  environment: ExecutionEnvironmentVariable[];
  secretBindings: ExecutionEnvironmentSecretBinding[];
  executionTimeoutMs: number;
  uploadTimeoutMs: number;
  caseTimeoutSeconds: number;
  policy?: RunBatchExecutionPolicy;
}): ExecutionSpec {
  // 产物开关属于批次策略快照；Full worker 不再用启动时配置二次覆盖它。
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
    ...(input.classData
      ? [
          {
            inputId: `class-data-${input.executionRunId}`,
            kind: "class-data" as const,
            targetPath: `inputs/class-data/${input.executionRunId}.json`,
            mediaType: "application/json" as const,
            sizeBytes: input.classData.sizeBytes,
            sha256: input.classData.sha256,
          },
        ]
      : []),
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
            caseTimeoutSeconds: input.caseTimeoutSeconds,
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

async function postgresProjectAdapterRuntime(
  handle: PostgresDatabaseHandle,
  projectId: string,
  adapter: CreateRunBatchRecord["adapter"],
  runs: CreateRunBatchRecord["runs"],
  projectVersionId?: string,
): Promise<ProjectAdapterRuntime | undefined> {
  if (!hasTaskAdapterSettings(adapter)) return undefined;
  const [configuration] = await handle.db
    .select()
    .from(pgProjectAdapterConfigurations)
    .where(eq(pgProjectAdapterConfigurations.projectId, projectId))
    .limit(1);
  const [versionConfiguration] = projectVersionId
    ? await handle.db
        .select()
        .from(pgProjectVersionRuntimeAssets)
        .where(
          and(
            eq(pgProjectVersionRuntimeAssets.projectVersionId, projectVersionId),
            eq(pgProjectVersionRuntimeAssets.projectId, projectId),
          ),
        )
        .limit(1)
    : [];
  const selectedJdkId = projectVersionId
    ? versionConfiguration?.jdkAssetId
    : configuration?.jdkAssetId;
  const selectedJarBundleId = projectVersionId
    ? versionConfiguration?.jarBundleAssetId
    : configuration?.jarBundleAssetId;
  const assetIds = [selectedJdkId, selectedJarBundleId].filter((assetId): assetId is string =>
    Boolean(assetId),
  );
  const assets = assetIds.length
    ? await handle.db
        .select()
        .from(pgProjectRuntimeAssets)
        .where(
          and(
            eq(pgProjectRuntimeAssets.projectId, projectId),
            inArray(pgProjectRuntimeAssets.id, assetIds),
          ),
        )
    : [];
  const assetSnapshot = (assetId: string | null): RuntimeAssetSnapshot | undefined => {
    const asset = assets.find((candidate) => candidate.id === assetId);
    return asset
      ? {
          id: asset.id,
          sourceType: asset.sourceType,
          ...(asset.url ? { url: asset.url } : {}),
          sha256: asset.sha256,
          sizeBytes: asset.sizeBytes,
          archiveFormat: asset.archiveFormat,
        }
      : undefined;
  };
  const jdk = assetSnapshot(selectedJdkId ?? null);
  const jarBundle = assetSnapshot(selectedJarBundleId ?? null);
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

function runtimeSnapshotForRuns(
  snapshot: NonNullable<CreateRunBatchRecord["adapterRuntimeSnapshot"]>,
  runs: CreateRunBatchRecord["runs"],
): ProjectAdapterRuntime {
  return {
    suiteName: snapshot.suiteName,
    testName: snapshot.testName,
    environmentAddressByRunId: assignEnvironmentAddresses(snapshot.environmentAddresses, runs),
    fallbackEnvironmentAddress: "",
    ...(snapshot.jdk ? { jdk: { ...snapshot.jdk } } : {}),
    ...(snapshot.jarBundle ? { jarBundle: { ...snapshot.jarBundle } } : {}),
  };
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
    caseType: row.caseType,
    ...(row.ddtSrNum ? { ddtSrNum: row.ddtSrNum } : {}),
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
