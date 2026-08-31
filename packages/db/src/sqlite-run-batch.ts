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
import { and, count, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import { runSqliteWriteTransaction, type SqliteDatabaseHandle } from "./database";
import {
  batchesOf,
  RELATIONAL_ID_QUERY_BATCH_SIZE,
  RELATIONAL_WRITE_BATCH_SIZE,
} from "./database-batches";
import {
  adapterEnvironmentAddress,
  adapterEnvironmentAddressFromExecutionSpec,
  executionResourceLimitsForInputs,
  parseProjectAdapterRuntime,
  projectAdapterRequiredCapabilities,
  supportsProjectAdapterRuntime,
  type ProjectAdapterRuntime,
  type RuntimeAssetSnapshot,
} from "./project-adapter-runtime";
import { mapStoredRunner } from "./runner-mapper";
import {
  assertRetryConcurrencyTransition,
  retryConcurrencyActivationDecision,
  retryConcurrencyStateFromRow,
} from "./retry-concurrency-state";
import {
  runnerFailureIdsByExecutionRun,
  runnerHistoryIdsByExecutionRun,
} from "./runner-failure-history";
import { decodeRunBatchCursor, encodeRunBatchCursor } from "./run-batch-list";
import {
  assignments,
  caseSources,
  caseVersions,
  executionRuns,
  runAttempts,
  runBatchRunners,
  runBatchRetryConcurrencyStates,
  runBatchRoundConcurrencies,
  runBatches,
  runBatchStatusEvents,
  runners,
} from "./schema";

const activeAttemptStatuses = ["assigned", "running"] as const;
const activeBatchStatuses = ["queued", "dispatching", "scheduled", "running"] as const;
const SCHEDULING_RUN_WINDOW_SIZE = 4_096;

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
  activated_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  build_result: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

type SqliteRoundAggregateRow = {
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

type SqliteRunnerFaultRow = {
  runnerId: string;
  resultCode: string;
  summary: string;
  count: number;
  attemptNumbers: string;
  caseNames: string | null;
  lastOccurredAt: string;
};

const SQLITE_BATCH_ROUND_CTES = `WITH batch_runs AS (
  SELECT * FROM execution_runs WHERE batch_id=?
), round_numbers(round) AS (
  SELECT 1
  UNION SELECT current_round FROM run_batches WHERE id=?
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

export class SqliteRunBatchRepository implements RunBatchRepository {
  constructor(
    private readonly handle: SqliteDatabaseHandle,
    private readonly caseExecutionTimeoutSeconds = DEFAULT_CASE_EXECUTION_TIMEOUT_SECONDS,
  ) {}

  async create(record: CreateRunBatchRecord): Promise<RunBatch> {
    const queueTimeoutMs = record.queueTimeoutMs ?? 86_400_000;
    const claimTimeoutMs = record.claimTimeoutMs ?? 300_000;
    const executionTimeoutMs = record.executionTimeoutMs ?? 3_600_000;
    const uploadTimeoutMs = record.uploadTimeoutMs ?? 600_000;
    const scheduledFor = record.scheduledFor ?? record.createdAt;
    const adapterRuntime = record.adapterRuntimeSnapshot
      ? runtimeSnapshotForRuns(record.adapterRuntimeSnapshot, record.runs)
      : projectAdapterRuntime(
          this.handle,
          record.projectId ?? DEFAULT_PROJECT_ID,
          record.adapter,
          record.runs,
          record.policy?.projectVersionId,
        );
    runSqliteWriteTransaction(this.handle, () => {
      // SQLite 单写者下，同一事务内取 MAX+1 即为全局唯一递增编号。
      const nextSequence = (
        this.handle.client
          .prepare("SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next FROM run_batches")
          .get() as { next: number }
      ).next;
      this.handle.db
        .insert(runBatches)
        .values({
          id: record.id,
          sequenceNumber: nextSequence,
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
        .run();
      this.handle.db
        .insert(runBatchRoundConcurrencies)
        .values({
          batchId: record.id,
          executionRound: 1,
          concurrency: record.policy?.concurrency ?? 4,
          source: "base",
          recordedAt: record.createdAt,
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
      if (record.runnerIds.length > 0) {
        this.handle.db
          .insert(runBatchRunners)
          .values(record.runnerIds.map((runnerId) => ({ batchId: record.id, runnerId })))
          .run();
      }
      for (const recovery of record.roundRecoveries ?? []) {
        this.handle.client
          .prepare(
            `INSERT INTO run_batch_round_recoveries
             (batch_id, rule_id, after_round, next_round, jenkins_job_url,
              api_key_ciphertext, wait_minutes, status, available_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?)`,
          )
          .run(
            record.id,
            recovery.ruleId,
            recovery.afterRound,
            recovery.afterRound + 1,
            recovery.jenkinsJobUrl,
            recovery.apiKeyCiphertext,
            recovery.waitMinutes,
            record.createdAt,
            record.createdAt,
            record.createdAt,
          );
      }
      for (const runs of batchesOf(record.runs, RELATIONAL_WRITE_BATCH_SIZE)) {
        this.handle.db
          .insert(executionRuns)
          .values(
            runs.map((run) => ({
              id: run.id,
              caseDefinitionId: run.caseDefinitionId,
              executionCaseDefinitionId: run.executionCaseDefinitionId ?? run.caseDefinitionId,
              caseVersion: run.caseVersion,
              displayName: run.displayName,
              className: run.className,
              caseType: run.caseType ?? "testng",
              classDataJson: run.classData?.json ?? null,
              classDataSizeBytes: run.classData?.sizeBytes ?? null,
              classDataSha256: run.classData?.sha256 ?? null,
              ddtSrNum: run.ddtSrNum ?? null,
              parametersJson: JSON.stringify(run.parameters ?? {}),
              batchId: record.id,
              status: "queued" as const,
              assignedRunnerId: null,
              attemptCount: 0,
              schedulingScore: null,
              queueDeadlineAt: addMilliseconds(scheduledFor, queueTimeoutMs),
              executionTimeoutMs,
              uploadTimeoutMs,
              createdAt: record.createdAt,
              assignedAt: null,
              updatedAt: record.createdAt,
            })),
          )
          .run();
      }
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
            scheduledFor,
            record.dispatchJob.createdAt,
            record.dispatchJob.createdAt,
          );
      }
    });
    return this.requiredBatchSummary(record.id);
  }

  async list(
    limit: number,
    projectIds?: readonly string[],
    projectVersionId?: string,
  ): Promise<RunBatch[]> {
    if (projectIds?.length === 0) return [];
    const rows = this.handle.db
      .select()
      .from(runBatches)
      .where(
        and(
          sql`${runBatches.batchKind} <> 'case_log_rerun'`,
          ...(projectIds ? [inArray(runBatches.projectId, [...projectIds])] : []),
          ...(projectVersionId
            ? [
                sql`json_extract(${runBatches.policyJson}, '$.projectVersionId') = ${projectVersionId}`,
              ]
            : []),
        ),
      )
      .orderBy(desc(runBatches.createdAt))
      .limit(limit)
      .all();
    return this.mapBatches(rows);
  }

  async listPage(input: RunBatchListQuery) {
    if (input.projectIds?.length === 0) return { items: [] };
    const cursor = decodeRunBatchCursor(input.cursor);
    const conditions = [
      sql`${runBatches.batchKind} <> 'case_log_rerun'`,
      ...(input.projectIds ? [inArray(runBatches.projectId, [...input.projectIds])] : []),
      ...(input.projectId ? [eq(runBatches.projectId, input.projectId)] : []),
      ...(input.projectVersionId
        ? [
            sql`json_extract(${runBatches.policyJson}, '$.projectVersionId') = ${input.projectVersionId}`,
          ]
        : []),
      ...(input.suiteId ? [eq(runBatches.suiteId, input.suiteId)] : []),
      ...(input.status ? [eq(runBatches.status, input.status)] : []),
      ...(input.createdAfter ? [gte(runBatches.scheduledFor, input.createdAfter)] : []),
      ...(input.createdBefore ? [lte(runBatches.scheduledFor, input.createdBefore)] : []),
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
    const items = await this.mapBatches(pageRows);
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
    // attempts 用 batch_id 关联子查询定位：大批次（5 万+ run）下 inArray 会超出
    // SQLite 绑定变量上限，子查询把参数数量固定为 1。
    const attemptRows =
      runRows.length === 0
        ? []
        : this.handle.db
            .select()
            .from(runAttempts)
            .where(
              sql`EXISTS (SELECT 1 FROM execution_runs run WHERE run.id = ${runAttempts.executionRunId} AND run.batch_id = ${batchId})`,
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
    const roundRecoveries = this.handle.client
      .prepare(
        `SELECT rule_id, after_round, next_round, jenkins_job_url, wait_minutes, status,
                source_build_number, rebuild_number, rebuild_url, activated_at, started_at,
                finished_at, build_result, error_message, created_at, updated_at
         FROM run_batch_round_recoveries
         WHERE batch_id = ?
         ORDER BY after_round, rule_id`,
      )
      .all(batchId) as RoundRecoveryDetailRow[];
    const roundConcurrencies = this.handle.db
      .select()
      .from(runBatchRoundConcurrencies)
      .where(eq(runBatchRoundConcurrencies.batchId, batchId))
      .orderBy(runBatchRoundConcurrencies.executionRound)
      .all();
    return {
      ...(await this.mapBatch(batchRow)),
      runs: runRows.map(toExecutionRun),
      attempts: attemptRows.map(toRunAttempt),
      roundRecoveries: roundRecoveries.map(toRoundRecoveryDetail),
      roundConcurrencies: roundConcurrencies.map(toRoundConcurrency),
      statusHistory,
    };
  }

  async resolveAttemptRerunSource(attemptId: string) {
    const row = this.handle.client
      .prepare(
        `SELECT run.batch_id AS batchId, attempt.execution_run_id AS executionRunId,
                attempt.status AS attemptStatus
         FROM run_attempts attempt
         JOIN execution_runs run ON run.id = attempt.execution_run_id
         WHERE attempt.id = ?`,
      )
      .get(attemptId) as
      | {
          batchId: string;
          executionRunId: string;
          attemptStatus: RunAttempt["status"];
        }
      | undefined;
    return row ?? null;
  }

  async getRerunSnapshot(
    batchId: string,
    selection: { executionRunId?: string; finalFailuresOnly?: boolean },
  ) {
    const batch = await this.getSummary(batchId);
    if (!batch) return null;
    const runtimeRow = this.handle.db
      .select({ adapterRuntimeJson: runBatches.adapterRuntimeJson })
      .from(runBatches)
      .where(eq(runBatches.id, batchId))
      .get();
    const runtime = parseProjectAdapterRuntime(runtimeRow?.adapterRuntimeJson ?? null);
    const previousAdapterEnvironmentAddress =
      runtime && selection.executionRunId
        ? previousCaseLogAdapterEnvironmentAddress(
            this.handle,
            batchId,
            selection.executionRunId,
            runtime,
          )
        : undefined;
    const runSelection = and(
      eq(executionRuns.batchId, batchId),
      ...(selection.executionRunId ? [eq(executionRuns.id, selection.executionRunId)] : []),
      ...(selection.finalFailuresOnly ? [finalFailureRunCondition(executionRuns)] : []),
    );
    const runRows = this.handle.db
      .select()
      .from(executionRuns)
      .where(runSelection)
      .orderBy(executionRuns.createdAt, executionRuns.id)
      .all();
    const recoveries = this.handle.client
      .prepare(
        `SELECT rule_id AS ruleId, after_round AS afterRound,
                jenkins_job_url AS jenkinsJobUrl, api_key_ciphertext AS apiKeyCiphertext,
                wait_minutes AS waitMinutes
         FROM run_batch_round_recoveries
         WHERE batch_id = ? ORDER BY after_round, rule_id`,
      )
      .all(batchId) as Array<{
      ruleId: string;
      afterRound: number;
      jenkinsJobUrl: string;
      apiKeyCiphertext: string;
      waitMinutes: number;
    }>;
    return {
      batch,
      ...(runtime
        ? {
            adapterRuntime: {
              suiteName: runtime.suiteName,
              testName: runtime.testName,
              environmentAddresses: [...runtime.environmentAddresses],
              ...(runtime.jdk ? { jdk: { ...runtime.jdk } } : {}),
              ...(runtime.jarBundle ? { jarBundle: { ...runtime.jarBundle } } : {}),
            },
          }
        : {}),
      ...(previousAdapterEnvironmentAddress
        ? { caseLogRerunRotation: { previousAdapterEnvironmentAddress } }
        : {}),
      roundRecoveries: recoveries,
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
    const rows = this.handle.db
      .select({ id: runBatches.id })
      .from(runBatches)
      .where(
        and(
          eq(runBatches.batchKind, "case_log_rerun"),
          eq(runBatches.parentBatchId, parentBatchId),
          eq(runBatches.sourceExecutionRunId, sourceExecutionRunId),
        ),
      )
      .orderBy(runBatches.createdAt, runBatches.id)
      .limit(Math.min(Math.max(1, limit), 500))
      .all();
    const batches = await Promise.all(rows.map(({ id }) => this.get(id)));
    return batches.filter((batch): batch is RunBatchDetails => batch !== null);
  }

  async listAttemptsForExecutionRun(executionRunId: string): Promise<RunAttempt[]> {
    return this.handle.db
      .select()
      .from(runAttempts)
      .where(eq(runAttempts.executionRunId, executionRunId))
      .orderBy(runAttempts.createdAt, runAttempts.id)
      .all()
      .map(toRunAttempt);
  }

  async getSummary(batchId: string, projectIds?: readonly string[]): Promise<RunBatch | null> {
    if (projectIds?.length === 0) return null;
    const row = this.handle.db
      .select()
      .from(runBatches)
      .where(
        projectIds
          ? and(eq(runBatches.id, batchId), inArray(runBatches.projectId, [...projectIds]))
          : eq(runBatches.id, batchId),
      )
      .get();
    return row ? this.mapBatch(row) : null;
  }

  async getDetailOverview(
    batchId: string,
    projectIds?: readonly string[],
  ): Promise<RunBatchDetailOverview | null> {
    const batch = await this.getSummary(batchId, projectIds);
    if (!batch) return null;
    const roundRows = this.handle.client
      .prepare(
        `${SQLITE_BATCH_ROUND_CTES}
         SELECT rounds.round,
                COUNT(eligible.execution_run_id) AS totalRuns,
                COUNT(attempt.id) AS executed,
                SUM(CASE WHEN COALESCE(attempt.outcome, attempt.status)='succeeded' THEN 1 ELSE 0 END) AS passed,
                SUM(CASE WHEN COALESCE(attempt.outcome, attempt.status)='failed' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN COALESCE(attempt.outcome, attempt.status)='timed_out' THEN 1 ELSE 0 END) AS timedOut,
                SUM(CASE WHEN COALESCE(attempt.outcome, attempt.status)='cancelled' THEN 1 ELSE 0 END) AS cancelled,
                SUM(CASE WHEN attempt.status IN ('assigned','running') THEN 1 ELSE 0 END) AS active,
                MIN(COALESCE(attempt.started_at,attempt.created_at)) AS startedAt,
                MAX(attempt.finished_at) AS finishedAt
         FROM round_numbers rounds
         LEFT JOIN eligible_runs eligible ON eligible.round=rounds.round
         LEFT JOIN run_attempts attempt
           ON attempt.execution_run_id=eligible.execution_run_id
          AND attempt.attempt_number=rounds.round
         GROUP BY rounds.round ORDER BY rounds.round`,
      )
      .all(batchId, batchId) as SqliteRoundAggregateRow[];
    const firstPassRows = this.handle.client
      .prepare(
        `SELECT MIN(attempt.attempt_number) AS firstRound, COUNT(*) AS count
         FROM (
           SELECT execution_run_id, MIN(attempt_number) AS attempt_number
           FROM run_attempts
           WHERE COALESCE(outcome,status)='succeeded'
             AND EXISTS (SELECT 1 FROM execution_runs run
                         WHERE run.id=run_attempts.execution_run_id AND run.batch_id=?)
           GROUP BY execution_run_id
         ) attempt GROUP BY attempt.attempt_number ORDER BY attempt.attempt_number`,
      )
      .all(batchId) as Array<{ firstRound: number; count: number }>;
    const roundSummaries = mapRoundSummaries(batch, roundRows, firstPassRows);
    const roundRecoveries = this.handle.client
      .prepare(
        `SELECT rule_id, after_round, next_round, jenkins_job_url, wait_minutes, status,
                source_build_number, rebuild_number, rebuild_url, activated_at, started_at,
                finished_at, build_result, error_message, created_at, updated_at
         FROM run_batch_round_recoveries WHERE batch_id=? ORDER BY after_round,rule_id`,
      )
      .all(batchId) as RoundRecoveryDetailRow[];
    const roundConcurrencies = this.handle.db
      .select()
      .from(runBatchRoundConcurrencies)
      .where(eq(runBatchRoundConcurrencies.batchId, batchId))
      .orderBy(runBatchRoundConcurrencies.executionRound)
      .all()
      .map(toRoundConcurrency);
    const runnerRoundSummaries = this.handle.client
      .prepare(
        `SELECT attempt.attempt_number AS round,attempt.runner_id AS runnerId,
                COUNT(*) AS executed,
                SUM(CASE WHEN COALESCE(attempt.outcome,attempt.status)='succeeded' THEN 1 ELSE 0 END) AS passed,
                SUM(CASE WHEN COALESCE(attempt.outcome,attempt.status) IN ('failed','timed_out') THEN 1 ELSE 0 END) AS failed,
                MAX(COALESCE(attempt.finished_at,attempt.started_at,attempt.created_at)) AS lastActivity
         FROM run_attempts attempt JOIN execution_runs run ON run.id=attempt.execution_run_id
         WHERE run.batch_id=? GROUP BY attempt.attempt_number,attempt.runner_id
         ORDER BY attempt.attempt_number,attempt.runner_id`,
      )
      .all(batchId) as Array<{
      round: number;
      runnerId: string;
      executed: number;
      passed: number;
      failed: number;
      lastActivity: string;
    }>;
    const runnerFaultIncidents = this.runnerFaultIncidents(batchId);
    const participatingRunnerIds = (
      this.handle.client
        .prepare(
          `SELECT DISTINCT attempt.runner_id AS runnerId
           FROM run_attempts attempt JOIN execution_runs run ON run.id=attempt.execution_run_id
           WHERE run.batch_id=? ORDER BY attempt.runner_id`,
        )
        .all(batchId) as Array<{ runnerId: string }>
    ).map(({ runnerId }) => runnerId);
    const finalSummary = finalSummaryFromBatch(batch);
    return {
      batch,
      roundSummaries,
      allRoundsSummary: allRoundsSummary(roundSummaries),
      finalSummary,
      roundRecoveries: roundRecoveries.map(toRoundRecoveryDetail),
      roundConcurrencies,
      runnerRoundSummaries,
      runnerFaultIncidents,
      participatingRunnerIds,
      finishedAt: latestBatchActivity(batch.updatedAt, roundRows, roundRecoveries),
    };
  }

  async listCasePage(input: RunBatchCasePageQuery) {
    const batch = await this.getSummary(input.batchId, input.projectIds);
    if (!batch) return null;
    const { sqlText, parameters } = sqliteCasePageQuery(input);
    const keys = this.handle.client.prepare(sqlText).all(...parameters) as Array<{
      runId: string;
      attemptId: string | null;
      round: number;
      total: number;
    }>;
    if (keys.length === 0) return { items: [], total: 0 };
    const runIds = [...new Set(keys.map((row) => row.runId))];
    const attemptIds = keys.flatMap((row) => (row.attemptId ? [row.attemptId] : []));
    const runRows = this.handle.db
      .select()
      .from(executionRuns)
      .where(inArray(executionRuns.id, runIds))
      .all();
    const attemptRows =
      attemptIds.length === 0
        ? []
        : this.handle.db
            .select()
            .from(runAttempts)
            .where(inArray(runAttempts.id, attemptIds))
            .all();
    const runsById = new Map(runRows.map((row) => [row.id, toExecutionRun(row)]));
    const attemptsById = new Map(attemptRows.map((row) => [row.id, toRunAttempt(row)]));
    return {
      items: keys.flatMap((key) => {
        const run = runsById.get(key.runId);
        if (!run) return [];
        const attempt = key.attemptId ? attemptsById.get(key.attemptId) : undefined;
        return [{ run, ...(attempt ? { attempt } : {}), round: key.round }];
      }),
      total: keys[0]?.total ?? 0,
    };
  }

  private runnerFaultIncidents(batchId: string) {
    if (RETRYABLE_RUNNER_FAILURE_RESULT_CODES.length === 0) return [];
    const placeholders = RETRYABLE_RUNNER_FAILURE_RESULT_CODES.map(() => "?").join(",");
    const rows = this.handle.client
      .prepare(
        `WITH faults AS (
           SELECT attempt.runner_id AS runnerId,attempt.result_code AS resultCode,
                  COALESCE(NULLIF(TRIM(attempt.result_summary),''),'执行机未提供错误描述。') AS summary,
                  attempt.attempt_number AS attemptNumber,run.display_name AS caseName,
                  COALESCE(attempt.finished_at,attempt.started_at,attempt.created_at) AS occurredAt
           FROM run_attempts attempt JOIN execution_runs run ON run.id=attempt.execution_run_id
           WHERE run.batch_id=? AND attempt.result_code IN (${placeholders})
         ), grouped AS (
           SELECT runnerId,resultCode,summary,COUNT(*) AS count,
                  GROUP_CONCAT(DISTINCT attemptNumber) AS attemptNumbers,
                  MAX(occurredAt) AS lastOccurredAt
           FROM faults GROUP BY runnerId,resultCode,summary
           ORDER BY count DESC,lastOccurredAt DESC LIMIT 100
         ), name_candidates AS (
           SELECT runnerId,resultCode,summary,caseName,MAX(occurredAt) AS lastOccurredAt
           FROM faults GROUP BY runnerId,resultCode,summary,caseName
         ), ranked_names AS (
           SELECT *,ROW_NUMBER() OVER (
             PARTITION BY runnerId,resultCode,summary ORDER BY lastOccurredAt DESC,caseName
           ) AS nameRank FROM name_candidates
         ), names AS (
           SELECT runnerId,resultCode,summary,GROUP_CONCAT(caseName,CHAR(10)) AS caseNames
           FROM ranked_names WHERE nameRank<=20 GROUP BY runnerId,resultCode,summary
         )
         SELECT grouped.*,names.caseNames FROM grouped LEFT JOIN names
           ON names.runnerId=grouped.runnerId AND names.resultCode=grouped.resultCode
          AND names.summary=grouped.summary
         ORDER BY grouped.count DESC,grouped.lastOccurredAt DESC`,
      )
      .all(batchId, ...RETRYABLE_RUNNER_FAILURE_RESULT_CODES) as SqliteRunnerFaultRow[];
    return rows.map((row) => ({
      key: `${row.runnerId}\u0000${row.resultCode}\u0000${row.summary}`,
      runnerId: row.runnerId,
      resultCode: row.resultCode,
      summary: row.summary,
      count: row.count,
      caseNames: row.caseNames?.split("\n") ?? [],
      attemptNumbers: row.attemptNumbers.split(",").map(Number).filter(Number.isFinite),
      lastOccurredAt: row.lastOccurredAt,
    }));
  }

  async listReusableBatchIdsForRunner(
    runnerId: string,
    batchIds: readonly string[],
  ): Promise<string[]> {
    if (batchIds.length === 0) return [];
    return this.handle.db
      .select({ id: runBatches.id })
      .from(runBatches)
      .innerJoin(runBatchRunners, eq(runBatchRunners.batchId, runBatches.id))
      .where(
        and(
          eq(runBatchRunners.runnerId, runnerId),
          inArray(runBatches.id, [...batchIds]),
          inArray(runBatches.status, ["queued", "dispatching", "scheduled", "running"]),
          isNull(runBatches.cancelRequestedAt),
        ),
      )
      .all()
      .map((row) => row.id);
  }

  async listSchedulableBatchIds(
    limit: number,
    now = new Date().toISOString(),
    agingIntervalMinutes = 5,
  ): Promise<string[]> {
    return (
      this.handle.client
        .prepare(
          `SELECT id FROM run_batches
           WHERE status IN ('queued','dispatching','running') AND cancel_requested_at IS NULL
             AND scheduled_for <= ?
             AND EXISTS (
               SELECT 1 FROM execution_runs run
               WHERE run.batch_id = run_batches.id
                 AND run.status = 'queued' AND run.held_round = 0
             )
           ORDER BY priority + MIN(100, MAX(0, CAST(
             (julianday(?) - julianday(scheduled_for)) * 1440 / ? AS INTEGER
           ))) DESC, scheduled_for, id LIMIT ?`,
        )
        .all(now, now, agingIntervalMinutes, limit) as Array<{ id: string }>
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
           WHERE br.runner_id=? AND b.status IN ('queued','dispatching','running')
             AND b.cancel_requested_at IS NULL AND b.scheduled_for <= ?
             AND EXISTS (
               SELECT 1 FROM execution_runs run
               WHERE run.batch_id = b.id
                 AND run.status = 'queued' AND run.held_round = 0
             )
           ORDER BY b.priority + MIN(100, MAX(0, CAST(
             (julianday(?) - julianday(b.scheduled_for)) * 1440 / ? AS INTEGER
           ))) DESC, b.scheduled_for, b.id LIMIT ?`,
        )
        .all(runnerId, now, now, agingIntervalMinutes, limit) as Array<{ id: string }>
    ).map((row) => row.id);
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
      : this.handle.db
          .select()
          .from(executionRuns)
          .where(
            and(
              eq(executionRuns.batchId, batchId),
              eq(executionRuns.status, "queued"),
              eq(executionRuns.heldRound, 0),
            ),
          )
          .orderBy(executionRuns.createdAt, executionRuns.id)
          .limit(Math.min(SCHEDULING_RUN_WINDOW_SIZE, Math.max(1, maximumQueuedRuns)))
          .all();
    const queuedRunIds = queuedRows.map((run) => run.id);
    const attemptRows = batchesOf(queuedRunIds, RELATIONAL_ID_QUERY_BATCH_SIZE).flatMap((ids) =>
      this.handle.db
        .select()
        .from(runAttempts)
        .where(inArray(runAttempts.executionRunId, ids))
        .all(),
    );
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
    const retryConcurrencyStateRow = this.handle.db
      .select()
      .from(runBatchRetryConcurrencyStates)
      .where(eq(runBatchRetryConcurrencyStates.batchId, batchId))
      .get();
    const candidates = runnerRows
      .map((row) => ({
        runner: mapStoredRunner(row, offlineBefore),
        reservedSlots: reservations.get(row.id) ?? 0,
      }))
      .filter((candidate) =>
        supportsProjectAdapterRuntime(candidate.runner.capabilities, adapterRuntime),
      );
    const attempts = attemptRows.map(toRunAttempt);
    const previousFamilyRunnerId =
      batch.kind === "case_log_rerun" && batch.parentBatchId && batch.sourceExecutionRunId
        ? previousCaseLogRunnerId(this.handle, batch.parentBatchId, batch.sourceExecutionRunId)
        : undefined;
    const runnerHistoryByRun = previousFamilyRunnerId
      ? Object.fromEntries(queuedRunIds.map((runId) => [runId, [previousFamilyRunnerId]]))
      : runnerHistoryIdsByExecutionRun(attempts);
    return {
      batch,
      queuedRuns: queuedRows.map(toExecutionRun),
      candidates,
      runnerFailureIdsByRun: runnerFailureIdsByExecutionRun(attempts),
      runnerHistoryByRun,
      projectActiveRuns: projectActiveRuns(this.handle, batch.projectId),
      ...(retryConcurrencyStateRow
        ? { retryConcurrencyState: retryConcurrencyStateFromRow(retryConcurrencyStateRow) }
        : {}),
      retryContext: retryContext(this.handle, batch),
    };
  }

  async activateRetryConcurrency(
    input: Parameters<RunBatchRepository["activateRetryConcurrency"]>[0],
  ): Promise<RetryConcurrencyState | null> {
    return runSqliteWriteTransaction(this.handle, () => {
      const batch = this.handle.db
        .select({ currentRound: runBatches.currentRound, policyJson: runBatches.policyJson })
        .from(runBatches)
        .where(eq(runBatches.id, input.batchId))
        .get();
      if (!batch) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
      const storedRow = this.handle.db
        .select()
        .from(runBatchRetryConcurrencyStates)
        .where(eq(runBatchRetryConcurrencyStates.batchId, input.batchId))
        .get();
      const storedState = storedRow ? retryConcurrencyStateFromRow(storedRow) : undefined;
      const activation = retryConcurrencyActivationDecision(storedState, batch.currentRound, input);
      if (activation.outcome === "stale") return null;
      if (activation.outcome === "unchanged") return activation.state;
      assertRetryConcurrencyTransition(
        batchPolicy(batch.policyJson),
        input.executionRound,
        input.state,
      );
      this.handle.db
        .insert(runBatchRetryConcurrencyStates)
        .values({ batchId: input.batchId, ...input.state, updatedAt: input.updatedAt })
        .onConflictDoUpdate({
          target: runBatchRetryConcurrencyStates.batchId,
          set: { ...input.state, updatedAt: input.updatedAt },
        })
        .run();
      return input.state;
    });
  }

  async recordRoundConcurrency(
    input: Parameters<RunBatchRepository["recordRoundConcurrency"]>[0],
  ): Promise<"created" | "existing"> {
    return runSqliteWriteTransaction(this.handle, () => {
      const existing = this.handle.db
        .select({
          batchId: runBatchRoundConcurrencies.batchId,
          concurrency: runBatchRoundConcurrencies.concurrency,
          source: runBatchRoundConcurrencies.source,
          ruleId: runBatchRoundConcurrencies.ruleId,
        })
        .from(runBatchRoundConcurrencies)
        .where(
          and(
            eq(runBatchRoundConcurrencies.batchId, input.batchId),
            eq(runBatchRoundConcurrencies.executionRound, input.round),
          ),
        )
        .get();
      if (existing) {
        if (input.transitionEvent && !sameRoundConcurrencyTransition(existing, input)) {
          this.handle.db
            .update(runBatchRoundConcurrencies)
            .set({
              concurrency: input.concurrency,
              source: "rule_transition",
              ruleId: input.ruleId,
              previousConcurrency: input.previousConcurrency,
              recordedAt: input.recordedAt,
            })
            .where(
              and(
                eq(runBatchRoundConcurrencies.batchId, input.batchId),
                eq(runBatchRoundConcurrencies.executionRound, input.round),
              ),
            )
            .run();
          this.handle.client
            .prepare(
              `INSERT INTO scheduling_events
                (id, batch_id, event_type, message, payload_json, recorded_at)
               VALUES (?, ?, 'retry_concurrency_changed', ?, ?, ?)
               ON CONFLICT(id) DO NOTHING`,
            )
            .run(
              input.transitionEvent.id,
              input.batchId,
              input.transitionEvent.message,
              JSON.stringify(input.transitionEvent.payload),
              input.recordedAt,
            );
        }
        return "existing";
      }
      this.handle.db
        .insert(runBatchRoundConcurrencies)
        .values({
          batchId: input.batchId,
          executionRound: input.round,
          concurrency: input.concurrency,
          source: input.source,
          ruleId: input.ruleId,
          previousConcurrency: input.previousConcurrency,
          recordedAt: input.recordedAt,
        })
        .run();
      if (input.transitionEvent) {
        this.handle.client
          .prepare(
            `INSERT INTO scheduling_events
              (id, batch_id, event_type, message, payload_json, recorded_at)
             VALUES (?, ?, 'retry_concurrency_changed', ?, ?, ?)`,
          )
          .run(
            input.transitionEvent.id,
            input.batchId,
            input.transitionEvent.message,
            JSON.stringify(input.transitionEvent.payload),
            input.recordedAt,
          );
      }
      return "created";
    });
  }

  async hasSchedulableRuns(batchId: string): Promise<boolean> {
    const row = this.handle.client
      .prepare(
        `SELECT EXISTS(
           SELECT 1 FROM execution_runs
           WHERE batch_id = ? AND status = 'queued' AND held_round = 0
         ) AS value`,
      )
      .get(batchId) as { value: number } | undefined;
    return Boolean(row?.value);
  }

  async reserveAssignments(
    input: ReserveSchedulingAssignmentsInput,
  ): Promise<ReserveAssignmentsOutcome> {
    return runSqliteWriteTransaction(this.handle, () => {
      const batchScope = this.handle.db
        .select({
          projectId: runBatches.projectId,
          policyJson: runBatches.policyJson,
          adapterRuntimeJson: runBatches.adapterRuntimeJson,
          terminationRequestedAt: runBatches.cancelRequestedAt,
          environmentJson: runBatches.environmentJson,
          secretBindingsJson: runBatches.secretBindingsJson,
          priority: runBatches.priority,
          claimTimeoutMs: runBatches.claimTimeoutMs,
          executionTimeoutMs: runBatches.executionTimeoutMs,
          uploadTimeoutMs: runBatches.uploadTimeoutMs,
        })
        .from(runBatches)
        .where(eq(runBatches.id, input.batchId))
        .get();
      if (!batchScope) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
      if (batchScope.terminationRequestedAt) return { reserved: 0, acceptedAttemptIds: [] };
      let remainingProjectSlots = Math.max(
        0,
        (input.projectMaximumConcurrency ?? Number.MAX_SAFE_INTEGER) -
          projectActiveRuns(this.handle, batchScope.projectId),
      );
      const adapterRuntime = parseProjectAdapterRuntime(batchScope.adapterRuntimeJson);
      const policy = batchPolicy(batchScope.policyJson);
      const retryConcurrencyState = this.handle.db
        .select({ concurrency: runBatchRetryConcurrencyStates.concurrency })
        .from(runBatchRetryConcurrencyStates)
        .where(eq(runBatchRetryConcurrencyStates.batchId, input.batchId))
        .get();
      const batchConcurrency = retryConcurrencyState?.concurrency ?? policy?.concurrency;
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
      const decisionRunnerIds = [
        ...new Set(
          input.decisions
            .map((decision) => decision.runnerId)
            .filter((runnerId) => selectedRunnerIds.has(runnerId)),
        ),
      ];
      const runnerRows =
        decisionRunnerIds.length === 0
          ? []
          : this.handle.db
              .select()
              .from(runners)
              .where(inArray(runners.id, decisionRunnerIds))
              .all();
      const runnerById = new Map(runnerRows.map((runner) => [runner.id, runner]));
      const reservations = activeReservations(this.handle, decisionRunnerIds);
      const liveAvailableSlotsByRunner = new Map(
        (input.runnerLiveCapacities ?? []).map((capacity) => [
          capacity.runnerId,
          capacity.availableSlots,
        ]),
      );
      const decisionRunIds = input.decisions.map((decision) => decision.executionRunId);
      const executionInputRows = batchesOf(decisionRunIds, RELATIONAL_ID_QUERY_BATCH_SIZE).flatMap(
        (ids) =>
          this.handle.db
            .select({
              id: executionRuns.id,
              caseDefinitionId: executionRuns.caseDefinitionId,
              caseVersion: executionRuns.caseVersion,
              className: executionRuns.className,
              parametersJson: executionRuns.parametersJson,
              classDataSizeBytes: executionRuns.classDataSizeBytes,
              classDataSha256: executionRuns.classDataSha256,
              sourceId: caseSources.id,
              sourceSha256: caseSources.sha256,
              sourceSizeBytes: caseSources.sizeBytes,
            })
            .from(executionRuns)
            .innerJoin(
              caseVersions,
              and(
                sql`${caseVersions.caseDefinitionId} = COALESCE(${executionRuns.executionCaseDefinitionId}, ${executionRuns.caseDefinitionId})`,
                eq(caseVersions.version, executionRuns.caseVersion),
              ),
            )
            .innerJoin(caseSources, eq(caseSources.id, caseVersions.sourceId))
            .where(and(eq(executionRuns.batchId, input.batchId), inArray(executionRuns.id, ids)))
            .all(),
      );
      const executionInputByRunId = new Map(executionInputRows.map((row) => [row.id, row]));
      // 决策过滤完全在内存中按序进行（槽位扣减与运行机资格），随后一条条件
      // UPDATE 批量推进全部被接受的 run，再分批插入 attempt 与 assignment。被并发
      // 调度轮抢先的 run 不产生 attempt；其槽位本轮视为已消耗（下一调度轮自愈），
      // 保证语句有界且不回滚。
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
        const liveAvailableSlots = liveAvailableSlotsByRunner.get(decision.runnerId);
        const evaluation = evaluateRunnerForScheduling(
          {
            runner,
            reservedSlots: reservations.get(decision.runnerId) ?? 0,
            ...(liveAvailableSlots === undefined ? {} : { liveAvailableSlots }),
          },
          input.thresholds,
          input.metricsFreshAfter,
        );
        if (!evaluation.eligible || evaluation.score === undefined) continue;
        if (!executionInputByRunId.has(decision.executionRunId)) continue;
        acceptedDecisions.push({ ...decision, score: evaluation.score });
        reservations.set(decision.runnerId, (reservations.get(decision.runnerId) ?? 0) + 1);
        remainingProjectSlots -= 1;
        remainingBatchSlots -= 1;
      }
      let accepted = 0;
      const acceptedAttemptIds: string[] = [];
      for (const decisionChunk of batchesOf(acceptedDecisions, RELATIONAL_WRITE_BATCH_SIZE)) {
        const updatedRows = this.handle.client
          .prepare(
            `UPDATE execution_runs
             SET status = 'assigned',
                 assigned_runner_id = decision.column2,
                 attempt_count = attempt_count + 1,
                 scheduling_score = decision.column3,
                 assigned_at = ?,
                 updated_at = ?
             FROM (VALUES ${decisionChunk.map(() => "(?, ?, ?)").join(", ")}) AS decision
             WHERE execution_runs.id = decision.column1
               AND execution_runs.batch_id = ?
               AND execution_runs.status = 'queued'
               AND execution_runs.held_round = 0
               AND (execution_runs.queue_deadline_at IS NULL
                    OR execution_runs.queue_deadline_at > ?)
             RETURNING id, attempt_count`,
          )
          .all(
            input.scheduledAt,
            input.scheduledAt,
            ...decisionChunk.flatMap((decision) => [
              decision.executionRunId,
              decision.runnerId,
              decision.score,
            ]),
            input.batchId,
            input.scheduledAt,
          ) as Array<{ id: string; attempt_count: number }>;
        const attemptCountByRunId = new Map(updatedRows.map((row) => [row.id, row.attempt_count]));
        const reservedDecisions = decisionChunk.filter((decision) =>
          attemptCountByRunId.has(decision.executionRunId),
        );
        if (reservedDecisions.length === 0) continue;
        const environment = environmentVariables(batchScope.environmentJson);
        const secretBindingsList = secretBindings(batchScope.secretBindingsJson);
        const claimDeadlineAt = addMilliseconds(input.scheduledAt, batchScope.claimTimeoutMs);
        this.handle.db
          .insert(runAttempts)
          .values(
            reservedDecisions.map((decision) => ({
              id: decision.attemptId,
              executionRunId: decision.executionRunId,
              runnerId: decision.runnerId,
              attemptNumber: attemptCountByRunId.get(decision.executionRunId)!,
              status: "assigned" as const,
              schedulingScore: decision.score,
              createdAt: input.scheduledAt,
            })),
          )
          .run();
        this.handle.db
          .insert(assignments)
          .values(
            reservedDecisions.map((decision) => {
              const executionInput = executionInputByRunId.get(decision.executionRunId)!;
              return {
                id: decision.assignmentId,
                attemptId: decision.attemptId,
                executionRunId: decision.executionRunId,
                batchId: input.batchId,
                runnerId: decision.runnerId,
                status: "pending" as const,
                priority: batchScope.priority,
                executionSpecJson: JSON.stringify(
                  executionSpec({
                    attemptId: decision.attemptId,
                    executionRunId: decision.executionRunId,
                    attemptNumber: attemptCountByRunId.get(decision.executionRunId)!,
                    batchId: input.batchId,
                    className: executionInput.className,
                    parameters: stringRecord(executionInput.parametersJson),
                    source: {
                      id: executionInput.sourceId,
                      sha256: executionInput.sourceSha256,
                      sizeBytes: executionInput.sourceSizeBytes,
                    },
                    ...(executionInput.classDataSizeBytes && executionInput.classDataSha256
                      ? {
                          classData: {
                            sizeBytes: executionInput.classDataSizeBytes,
                            sha256: executionInput.classDataSha256,
                          },
                        }
                      : {}),
                    ...(adapterRuntime ? { adapterRuntime } : {}),
                    environment,
                    secretBindings: secretBindingsList,
                    executionTimeoutMs: batchScope.executionTimeoutMs,
                    uploadTimeoutMs: batchScope.uploadTimeoutMs,
                    caseTimeoutSeconds: this.caseExecutionTimeoutSeconds,
                    ...(policy ? { policy } : {}),
                  }),
                ),
                availableAt: input.scheduledAt,
                claimDeadlineAt,
                createdAt: input.scheduledAt,
                updatedAt: input.scheduledAt,
              };
            }),
          )
          .run();
        accepted += reservedDecisions.length;
        acceptedAttemptIds.push(...reservedDecisions.map((decision) => decision.attemptId));
      }
      updateBatchSchedulingStatus(
        this.handle,
        input.batchId,
        input.scheduledAt,
        input.eventId ?? input.decisions[0]?.assignmentId ?? input.batchId,
      );
      return { reserved: accepted, acceptedAttemptIds };
    });
  }

  async appendSchedulingEvents(
    events: Parameters<RunBatchRepository["appendSchedulingEvents"]>[0],
  ): Promise<void> {
    if (events.length === 0) return;
    // 批量插入放入同一事务，保证一轮调度产生的事件要么整体可见，要么整体回滚。
    runSqliteWriteTransaction(this.handle, () => {
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
    });
  }

  async listSchedulingEvents(
    input: Parameters<RunBatchRepository["listSchedulingEvents"]>[0],
  ): ReturnType<RunBatchRepository["listSchedulingEvents"]> {
    const limit = Math.min(Math.max(1, Math.trunc(input.limit)), 500);
    if (input.afterId !== undefined && (input.beforeId !== undefined || input.latest === true)) {
      throw new TypeError("Scheduling event cursors cannot mix forward and backward reads.");
    }
    const backwards = input.beforeId !== undefined || input.latest === true;
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
    if (input.beforeId !== undefined) {
      parameters.push(input.beforeId);
      filters += ` AND (recorded_at, id) < (
        SELECT recorded_at, id FROM scheduling_events WHERE id = ?)`;
    }
    parameters.push(limit);
    const rows = this.handle.client
      .prepare(
        `SELECT id, batch_id, runner_id, execution_run_id, attempt_id, event_type,
                message, payload_json, recorded_at
         FROM scheduling_events
         WHERE batch_id = ?${filters}
         ORDER BY recorded_at ${backwards ? "DESC" : "ASC"}, id ${backwards ? "DESC" : "ASC"}
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

  private async requiredBatchSummary(batchId: string): Promise<RunBatch> {
    const batch = await this.getSummary(batchId);
    if (!batch) throw new Error(`Run batch ${batchId} does not exist after creation.`);
    return batch;
  }

  private async mapBatch(row: typeof runBatches.$inferSelect): Promise<RunBatch> {
    const [batch] = await this.mapBatches([row]);
    if (!batch) throw new Error(`Cannot map run batch ${row.id}.`);
    return batch;
  }

  /** 列表页一次读取整页关联计数，避免每个批次追加三次查询。 */
  private async mapBatches(rows: Array<typeof runBatches.$inferSelect>): Promise<RunBatch[]> {
    if (rows.length === 0) return [];
    const batchIds = rows.map((row) => row.id);
    const selectedRunnerRows = batchesOf(batchIds, RELATIONAL_ID_QUERY_BATCH_SIZE).flatMap((ids) =>
      this.handle.db
        .select({ batchId: runBatchRunners.batchId, runnerId: runBatchRunners.runnerId })
        .from(runBatchRunners)
        .where(inArray(runBatchRunners.batchId, ids))
        .orderBy(runBatchRunners.batchId, runBatchRunners.runnerId)
        .all(),
    );
    const { statusRows, outcomeRows } = this.batchRunCounts(batchIds);
    const runnerIdsByBatch = new Map<string, string[]>();
    for (const runner of selectedRunnerRows) {
      const ids = runnerIdsByBatch.get(runner.batchId) ?? [];
      ids.push(runner.runnerId);
      runnerIdsByBatch.set(runner.batchId, ids);
    }
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
    row: typeof runBatches.$inferSelect,
    selectedRunnerIds: string[],
    byStatus: Map<string, number>,
    outcomeCounts: FinalOutcomeCounts | undefined,
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
      succeededRuns: Number(outcomeCounts?.succeeded ?? byStatus.get("succeeded") ?? 0),
      failedRuns: Number(outcomeCounts?.failed ?? 0),
      timedOutRuns: Number(outcomeCounts?.timedOut ?? 0),
      cancelledRuns: Number(outcomeCounts?.cancelled ?? byStatus.get("cancelled") ?? 0),
      ...(row.cancelRequestedAt ? { terminationRequestedAt: row.cancelRequestedAt } : {}),
      version: row.version,
      scheduledFor: row.scheduledFor,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * attempt 选择与领域总结保持一致：每个 run 曾成功则成功，否则取最高轮次。
   * 从未产生 attempt 的排队超时等终态回退 run 结果；聚合留在数据库内。
   */
  /**
   * 状态计数与最终结果计数共享同一次 run/attempt 扫描。无重试批次（列表探针
   * 热点）合并为单条查询；仅当存在重试 run 时退回窗口排序路径并保留两次查询。
   */
  private batchRunCounts(batchIds: readonly string[]): {
    statusRows: Array<{ batchId: string; status: string; value: number }>;
    outcomeRows: FinalOutcomeCounts[];
  } {
    if (batchIds.length === 0) return { statusRows: [], outcomeRows: [] };
    const placeholders = batchIds.map(() => "?").join(",");
    const retried = this.handle.client
      .prepare(
        `SELECT EXISTS(
           SELECT 1 FROM execution_runs
           WHERE batch_id IN (${placeholders}) AND attempt_count > 1
         ) AS value`,
      )
      .get(...batchIds) as { value: number } | undefined;
    if (retried?.value) {
      const statusRows = batchesOf(batchIds, RELATIONAL_ID_QUERY_BATCH_SIZE).flatMap((ids) =>
        this.handle.db
          .select({
            batchId: executionRuns.batchId,
            status: executionRuns.status,
            value: count(),
          })
          .from(executionRuns)
          .where(inArray(executionRuns.batchId, ids))
          .groupBy(executionRuns.batchId, executionRuns.status)
          .all(),
      );
      const outcomeRows = batchesOf(batchIds, RELATIONAL_ID_QUERY_BATCH_SIZE).flatMap((ids) =>
        this.windowedFinalOutcomeCounts(ids),
      );
      return { statusRows, outcomeRows };
    }
    // 无重试快速路径：每个 run 至多一条 attempt，LEFT JOIN 不会放大行数；
    // 状态计数与最终结果计数在同一分组结果上聚合，扫描从两次降为一次。
    const mergedRows = batchesOf(batchIds, RELATIONAL_ID_QUERY_BATCH_SIZE).flatMap(
      (ids) =>
        this.handle.client
          .prepare(
            `SELECT run.batch_id AS batchId,
                    run.status AS status,
                    COALESCE(attempt.outcome,
                      CASE WHEN attempt.status IN ('succeeded','failed','cancelled','timed_out')
                           THEN attempt.status END,
                      run.terminal_outcome,
                      CASE WHEN run.status IN ('succeeded','failed','cancelled')
                           THEN run.status END
                    ) AS finalOutcome,
                    count(*) AS value
             FROM execution_runs run
             LEFT JOIN run_attempts attempt ON attempt.execution_run_id = run.id
             WHERE run.batch_id IN (${ids.map(() => "?").join(",")})
             GROUP BY 1, 2, 3`,
          )
          .all(...ids) as Array<{
          batchId: string;
          status: string;
          finalOutcome: string | null;
          value: number;
        }>,
    );
    const statusAggregates = new Map<string, Map<string, number>>();
    const outcomeAggregates = new Map<
      string,
      { succeeded: number; failed: number; timedOut: number; cancelled: number }
    >();
    for (const row of mergedRows) {
      const statuses = statusAggregates.get(row.batchId) ?? new Map<string, number>();
      statuses.set(row.status, (statuses.get(row.status) ?? 0) + row.value);
      statusAggregates.set(row.batchId, statuses);
      if (row.finalOutcome === null) continue;
      const outcomes = outcomeAggregates.get(row.batchId) ?? {
        succeeded: 0,
        failed: 0,
        timedOut: 0,
        cancelled: 0,
      };
      if (row.finalOutcome === "succeeded") outcomes.succeeded += row.value;
      else if (row.finalOutcome === "failed") outcomes.failed += row.value;
      else if (row.finalOutcome === "timed_out") outcomes.timedOut += row.value;
      else if (row.finalOutcome === "cancelled") outcomes.cancelled += row.value;
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

  /** 重试批次的最终结果：按成功优先、轮次倒序挑选决定结果的 attempt。 */
  private windowedFinalOutcomeCounts(batchIds: readonly string[]): FinalOutcomeCounts[] {
    if (batchIds.length === 0) return [];
    const placeholders = batchIds.map(() => "?").join(",");
    return this.handle.client
      .prepare(
        `WITH ranked_attempts AS (
           SELECT run.batch_id, attempt.execution_run_id,
                  COALESCE(attempt.outcome, attempt.status) AS final_outcome,
                  ROW_NUMBER() OVER (
                    PARTITION BY attempt.execution_run_id
                    ORDER BY CASE WHEN COALESCE(attempt.outcome, attempt.status) = 'succeeded'
                                      THEN 0 ELSE 1 END,
                             attempt.attempt_number DESC
                  ) AS outcome_rank
           FROM run_attempts attempt
           JOIN execution_runs run ON run.id = attempt.execution_run_id
           WHERE run.batch_id IN (${placeholders})
         ), selected_outcomes AS (
           SELECT execution_run_id, final_outcome
           FROM ranked_attempts WHERE outcome_rank = 1
         ), run_outcomes AS (
           SELECT run.batch_id,
                  COALESCE(selected.final_outcome, run.terminal_outcome,
                    CASE WHEN run.status IN ('succeeded','failed','cancelled')
                         THEN run.status END) AS final_outcome
           FROM execution_runs run
           LEFT JOIN selected_outcomes selected ON selected.execution_run_id = run.id
           WHERE run.batch_id IN (${placeholders})
         )
         SELECT batch_id AS batchId,
                SUM(CASE WHEN final_outcome = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
                SUM(CASE WHEN final_outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN final_outcome = 'timed_out' THEN 1 ELSE 0 END) AS timedOut,
                SUM(CASE WHEN final_outcome = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
         FROM run_outcomes GROUP BY batch_id`,
      )
      .all(...batchIds, ...batchIds) as FinalOutcomeCounts[];
  }
}

function mapRoundSummaries(
  batch: RunBatch,
  rows: readonly SqliteRoundAggregateRow[],
  firstPassRows: readonly { firstRound: number; count: number }[],
): RunBatchRoundSummary[] {
  let overallPassed = 0;
  const firstPassByRound = new Map(firstPassRows.map((row) => [row.firstRound, row.count]));
  return rows.map((row) => {
    overallPassed += firstPassByRound.get(row.round) ?? 0;
    const completed = row.passed + row.failed + row.timedOut + row.cancelled;
    const status = roundAggregateStatus(batch, row);
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

function roundAggregateStatus(
  batch: RunBatch,
  row: SqliteRoundAggregateRow,
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

function allRoundsSummary(summaries: readonly RunBatchRoundSummary[]) {
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

function finalSummaryFromBatch(batch: RunBatch) {
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

function latestBatchActivity(
  updatedAt: string,
  rounds: readonly SqliteRoundAggregateRow[],
  recoveries: readonly RoundRecoveryDetailRow[],
): string {
  let latest = updatedAt;
  for (const candidate of [
    ...rounds.map((row) => row.finishedAt),
    ...recoveries.map((recovery) => recovery.updated_at),
  ]) {
    if (candidate && Date.parse(candidate) > Date.parse(latest)) latest = candidate;
  }
  return latest;
}

function sqliteCasePageQuery(input: RunBatchCasePageQuery): {
  sqlText: string;
  parameters: Array<string | number>;
} {
  const parameters: Array<string | number> = [input.batchId, input.batchId];
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
    scopeCte = `, scope_rows AS (
      SELECT eligible.execution_run_id,eligible.round,attempt.id AS attempt_id
      FROM eligible_runs eligible LEFT JOIN run_attempts attempt
        ON attempt.execution_run_id=eligible.execution_run_id
       AND attempt.attempt_number=eligible.round
      ${input.scope === "all" ? "" : "WHERE eligible.round=?"}
    )`;
    if (input.scope !== "all") parameters.push(input.scope);
  }
  const where: string[] = [];
  if (input.status === "pending") where.push("scope.attempt_id IS NULL");
  else if (input.status) {
    where.push("attempt.status=?");
    parameters.push(input.status);
  }
  if (input.query?.trim()) {
    where.push("LOWER(run.display_name || ' ' || run.class_name) LIKE ? ESCAPE '\\'");
    parameters.push(`%${escapeSqliteLike(input.query.trim().toLowerCase())}%`);
  }
  const direction = input.direction === "desc" ? "DESC" : "ASC";
  const sortExpression = {
    none: "run.created_at ASC,run.id ASC,scope.round ASC",
    name: `run.display_name COLLATE NOCASE ${direction},run.id ${direction},scope.round ${direction}`,
    status: `CASE COALESCE(attempt.status,'pending')
      WHEN 'succeeded' THEN 0 WHEN 'failed' THEN 1 WHEN 'timed_out' THEN 2
      WHEN 'cancelled' THEN 3 WHEN 'running' THEN 4 WHEN 'assigned' THEN 5 ELSE 6 END ${direction},
      CASE WHEN attempt.status='failed'
        THEN COALESCE(NULLIF(TRIM(attempt.result_summary),''),attempt.result_code,'')
        ELSE '' END COLLATE NOCASE ${direction},
      run.display_name COLLATE NOCASE ${direction},run.id ${direction},scope.round ${direction}`,
    runner: `COALESCE(attempt.runner_id,run.assigned_runner_id,'') ${direction},run.display_name COLLATE NOCASE ${direction}`,
    duration: `CASE WHEN attempt.duration_ms IS NULL THEN 1 ELSE 0 END ASC,attempt.duration_ms ${direction},run.display_name COLLATE NOCASE ${direction}`,
  }[input.sort];
  parameters.push(input.limit, input.offset);
  return {
    sqlText: `${SQLITE_BATCH_ROUND_CTES}${scopeCte}
      SELECT scope.execution_run_id AS runId,scope.attempt_id AS attemptId,scope.round,
             COUNT(*) OVER () AS total
      FROM scope_rows scope JOIN batch_runs run ON run.id=scope.execution_run_id
      LEFT JOIN run_attempts attempt ON attempt.id=scope.attempt_id
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${sortExpression} LIMIT ? OFFSET ?`,
    parameters,
  };
}

function escapeSqliteLike(value: string): string {
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
    ...(row.activated_at === null ? {} : { activatedAt: row.activated_at }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.build_result === null ? {} : { buildResult: row.build_result }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRoundConcurrency(
  row: typeof runBatchRoundConcurrencies.$inferSelect,
): RunBatchRoundConcurrency {
  return {
    round: row.executionRound,
    concurrency: row.concurrency,
    source: row.source,
    ...(row.ruleId ? { ruleId: row.ruleId } : {}),
    ...(row.previousConcurrency === null ? {} : { previousConcurrency: row.previousConcurrency }),
    recordedAt: row.recordedAt,
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

function finalFailureRunCondition(table: typeof executionRuns) {
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

type FinalOutcomeCounts = {
  batchId: string;
  succeeded: number | null;
  failed: number | null;
  timedOut: number | null;
  cancelled: number | null;
};

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

function retryContext(
  handle: SqliteDatabaseHandle,
  batch: RunBatch,
): NonNullable<SchedulingSnapshot["retryContext"]> {
  const remaining = handle.client
    .prepare(
      `SELECT COUNT(*) AS value FROM execution_runs
       WHERE batch_id = ? AND (
         status IN ('assigned', 'running') OR (status = 'queued' AND held_round = 0)
       )`,
    )
    .get(batch.id) as { value: number };
  if (batch.currentRound <= 1) {
    return {
      executionRound: batch.currentRound,
      previousRoundPassRate: null,
      remainingRuns: remaining.value,
    };
  }
  const previous = handle.client
    .prepare(
      `SELECT
         SUM(CASE WHEN a.status = 'succeeded' THEN 1 ELSE 0 END) AS passed,
         SUM(CASE WHEN a.status IN ('succeeded','failed','timed_out','cancelled') THEN 1 ELSE 0 END) AS completed
       FROM run_attempts a JOIN execution_runs r ON r.id = a.execution_run_id
       WHERE r.batch_id = ? AND a.attempt_number = ?`,
    )
    .get(batch.id, batch.currentRound - 1) as { passed: number | null; completed: number | null };
  const completed = previous.completed ?? 0;
  return {
    executionRound: batch.currentRound,
    previousRoundPassRate:
      completed === 0 ? null : Math.round(((previous.passed ?? 0) / completed) * 100),
    remainingRuns: remaining.value,
  };
}

function executionSpec(input: {
  attemptId: string;
  executionRunId: string;
  attemptNumber: number;
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
  // 批次创建时已经把平台开关固化进策略快照；领取阶段只读快照，避免 Web 与
  // 独立 worker 的进程内配置不一致，也保证运行中的批次不会被后续设置改写。
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
              input.attemptNumber,
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

function projectAdapterRuntime(
  handle: SqliteDatabaseHandle,
  projectId: string,
  adapter: CreateRunBatchRecord["adapter"],
  runs: CreateRunBatchRecord["runs"],
  projectVersionId?: string,
): ProjectAdapterRuntime | undefined {
  if (!hasTaskAdapterSettings(adapter)) return undefined;
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
  const versionConfiguration = projectVersionId
    ? (handle.client
        .prepare(
          `SELECT jdk_asset_id, jar_bundle_asset_id
           FROM project_version_runtime_assets
           WHERE project_version_id = ? AND project_id = ?`,
        )
        .get(projectVersionId, projectId) as
        { jdk_asset_id: string | null; jar_bundle_asset_id: string | null } | undefined)
    : undefined;
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
  const jdk = asset(
    projectVersionId
      ? (versionConfiguration?.jdk_asset_id ?? null)
      : (configuration?.jdk_asset_id ?? null),
  );
  const jarBundle = asset(
    projectVersionId
      ? (versionConfiguration?.jar_bundle_asset_id ?? null)
      : (configuration?.jar_bundle_asset_id ?? null),
  );
  if (!jarBundle) {
    throw new DomainError(
      "ADAPTER_DEPENDENCY_ARCHIVE_MISSING",
      "任务已启用 CoTest Adapter，但项目尚未配置完整依赖 JAR 压缩包。",
    );
  }
  return {
    suiteName: adapter?.suiteName ?? "",
    testName: adapter?.testName ?? "",
    environmentAddresses: [...(adapter?.environmentAddresses ?? [])],
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
    environmentAddresses: [...snapshot.environmentAddresses],
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

function previousCaseLogAdapterEnvironmentAddress(
  handle: SqliteDatabaseHandle,
  parentBatchId: string,
  sourceExecutionRunId: string,
  sourceRuntime: ProjectAdapterRuntime,
): string | undefined {
  const latestDiagnostic = handle.client
    .prepare(
      `SELECT batch.adapter_runtime_json AS adapterRuntimeJson, run.id AS executionRunId
       FROM run_batches batch
       JOIN execution_runs run ON run.batch_id = batch.id
       WHERE batch.batch_kind = 'case_log_rerun' AND batch.parent_batch_id = ?
         AND batch.source_execution_run_id = ?
       ORDER BY batch.created_at DESC, batch.id DESC, run.id DESC LIMIT 1`,
    )
    .get(parentBatchId, sourceExecutionRunId) as
    { adapterRuntimeJson: string | null; executionRunId: string } | undefined;
  const diagnosticRuntime = parseProjectAdapterRuntime(
    latestDiagnostic?.adapterRuntimeJson ?? null,
  );
  if (latestDiagnostic && diagnosticRuntime) {
    const address = adapterEnvironmentAddress(
      diagnosticRuntime,
      latestDiagnostic.executionRunId,
      1,
    );
    if (address) return address;
  }

  const actualAssignment = handle.client
    .prepare(
      `SELECT assignment.execution_spec_json AS executionSpecJson
       FROM assignments assignment
       JOIN execution_runs run ON run.id = assignment.execution_run_id
       JOIN run_batches batch ON batch.id = run.batch_id
       WHERE (batch.id = ? AND run.id = ?)
          OR (batch.batch_kind = 'case_log_rerun' AND batch.parent_batch_id = ?
              AND batch.source_execution_run_id = ?)
       ORDER BY assignment.created_at DESC, assignment.id DESC LIMIT 1`,
    )
    .get(parentBatchId, sourceExecutionRunId, parentBatchId, sourceExecutionRunId) as
    { executionSpecJson: string } | undefined;
  const actualAddress = actualAssignment
    ? adapterEnvironmentAddressFromExecutionSpec(actualAssignment.executionSpecJson)
    : undefined;
  if (actualAddress) return actualAddress;

  const latestSourceAttempt = handle.client
    .prepare(
      `SELECT attempt_number AS attemptNumber FROM run_attempts
       WHERE execution_run_id = ?
       ORDER BY attempt_number DESC, created_at DESC, id DESC LIMIT 1`,
    )
    .get(sourceExecutionRunId) as { attemptNumber: number } | undefined;
  return latestSourceAttempt
    ? adapterEnvironmentAddress(
        sourceRuntime,
        sourceExecutionRunId,
        latestSourceAttempt.attemptNumber,
      )
    : sourceRuntime.environmentAddressByRunId[sourceExecutionRunId];
}

function previousCaseLogRunnerId(
  handle: SqliteDatabaseHandle,
  parentBatchId: string,
  sourceExecutionRunId: string,
): string | undefined {
  const row = handle.client
    .prepare(
      `SELECT attempt.runner_id AS runnerId
       FROM run_attempts attempt
       JOIN execution_runs run ON run.id = attempt.execution_run_id
       JOIN run_batches batch ON batch.id = run.batch_id
       WHERE (batch.id = ? AND run.id = ?)
          OR (batch.batch_kind = 'case_log_rerun' AND batch.parent_batch_id = ?
              AND batch.source_execution_run_id = ?)
       ORDER BY attempt.created_at DESC, attempt.id DESC LIMIT 1`,
    )
    .get(parentBatchId, sourceExecutionRunId, parentBatchId, sourceExecutionRunId) as
    { runnerId: string } | undefined;
  return row?.runnerId;
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
      .innerJoin(executionRuns, eq(executionRuns.id, runAttempts.executionRunId))
      .innerJoin(runBatches, eq(runBatches.id, executionRuns.batchId))
      .where(
        and(
          inArray(runAttempts.runnerId, runnerIds),
          inArray(runAttempts.status, [...activeAttemptStatuses]),
          inArray(executionRuns.status, [...activeAttemptStatuses]),
          inArray(runBatches.status, [...activeBatchStatuses]),
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
       WHERE b.project_id=?
         AND b.status IN ('queued','dispatching','scheduled','running')
         AND r.status IN ('assigned','running')
         AND a.status IN ('assigned','running')`,
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
