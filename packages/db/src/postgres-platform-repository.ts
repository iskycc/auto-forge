import type {
  CaseCatalogRepository,
  CaseActivity,
  CaseListPage,
  CaseListQuery,
  CaseSourceVersionMerge,
  CaseSuiteRepository,
  CopyCaseSuiteRecord,
  CreateCaseSuiteRecord,
  CreateSourceComparisonRecord,
  DashboardSummary,
  ExistingSource,
  ImportCatalogRecord,
  LatestCaseRunOutcome,
  RegisterRunnerRecord,
  RunnerRepository,
  UpdateCaseSuiteRecord,
} from "@autoforge/application";
import {
  jarImportResultSchema,
  jarInspectionSchema,
  type JarImportJob,
  type TestNgClassCandidate,
} from "@autoforge/contracts";
import {
  DEFAULT_PROJECT_ID,
  DomainError,
  buildCaseSuiteVersionSnapshot,
  defaultCaseSuiteExecutionPolicy,
  type CaseSuiteExecutionPolicy,
  type CaseDefinitionWithMethods,
  type CaseSource,
  type CaseSourceComparison,
  type CaseSourceSnapshotEntry,
  type CaseSuite,
  type CaseSuiteDetails,
  type CaseVersion,
  type CleanupJob,
  type Runner,
  type TestMethod,
} from "@autoforge/domain";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  like,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import type { PostgresDatabaseHandle } from "./postgres-database";
import { mapStoredRunner } from "./runner-mapper";
import {
  pgAssignmentLeases,
  pgCaseDefinitions,
  pgCaseImportJobs,
  pgCaseSourceComparisons,
  pgCaseSources,
  pgCaseSuiteItems,
  pgCaseSuites,
  pgCaseSuiteVersions,
  pgCaseVersions,
  pgCleanupJobs,
  pgExecutionRuns,
  pgRunners,
  pgRunnerBootstrapUses,
  pgTestMethods,
} from "./postgres-schema";

function stringArray(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
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

function safePolicy(json: string): Partial<CaseSuiteExecutionPolicy> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Partial<CaseSuiteExecutionPolicy>)
      : {};
  } catch {
    return {};
  }
}

function jsonArrayLength(json: string): number {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? parsed.length : 0;
}

function toMethod(row: typeof pgTestMethods.$inferSelect): TestMethod {
  return {
    id: row.id,
    caseDefinitionId: row.caseDefinitionId,
    methodName: row.methodName,
    descriptor: row.descriptor,
    enabled: row.enabled,
    groups: stringArray(row.groupsJson),
    dependsOnMethods: stringArray(row.dependsOnMethodsJson),
    dependsOnGroups: stringArray(row.dependsOnGroupsJson),
    ...(row.description ? { description: row.description } : {}),
    ...(row.dataProvider ? { dataProvider: row.dataProvider } : {}),
    ...(row.priority === null ? {} : { priority: row.priority }),
    createdAt: row.createdAt,
  };
}

function toSource(row: typeof pgCaseSources.$inferSelect): CaseSource {
  return {
    id: row.id,
    projectId: row.projectId,
    ...(row.projectVersionId ? { projectVersionId: row.projectVersionId } : {}),
    ...(row.testStageId ? { testStageId: row.testStageId } : {}),
    displayName: row.displayName,
    originalFileName: row.originalFileName,
    objectKey: row.objectKey,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    classCount: row.classCount,
    methodCount: row.methodCount,
    status: row.status,
    warningCount: jsonArrayLength(row.warningsJson),
    authoritative: row.authoritative,
    lifecycleStatus: row.lifecycleStatus,
    revision: row.revision,
    ...(row.importedBy ? { importedBy: row.importedBy } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCaseDefinition(
  row: typeof pgCaseDefinitions.$inferSelect,
): Omit<CaseDefinitionWithMethods, "methods"> {
  return {
    id: row.id,
    projectId: row.projectId,
    ...(row.projectVersionId ? { projectVersionId: row.projectVersionId } : {}),
    ...(row.testStageId ? { testStageId: row.testStageId } : {}),
    directoryPath: row.directoryPath,
    sourceId: row.sourceId,
    className: row.className,
    packageName: row.packageName,
    displayName: row.displayName,
    description: row.description,
    tags: stringArray(row.tagsJson),
    enabled: row.enabled,
    archived: row.archived,
    groups: stringArray(row.groupsJson),
    parameters: stringRecord(row.parametersJson),
    currentVersion: row.currentVersion,
    revision: row.revision,
    ...(row.updatedBy ? { updatedBy: row.updatedBy } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCaseVersion(row: typeof pgCaseVersions.$inferSelect): CaseVersion {
  return {
    id: row.id,
    caseDefinitionId: row.caseDefinitionId,
    sourceId: row.sourceId,
    version: row.version,
    snapshot: safeJson(row.snapshotJson),
    changeReason: row.changeReason,
    ...(row.createdBy ? { createdBy: row.createdBy } : {}),
    createdAt: row.createdAt,
  };
}

function testMethodInsertValues(input: {
  id: string;
  caseDefinitionId: string;
  method: TestNgClassCandidate["methods"][number];
  createdAt: string;
}) {
  return {
    id: input.id,
    caseDefinitionId: input.caseDefinitionId,
    methodName: input.method.methodName,
    descriptor: input.method.descriptor,
    enabled: input.method.enabled,
    annotationSource: input.method.annotationSource,
    groupsJson: JSON.stringify(input.method.groups),
    description: input.method.description ?? null,
    dataProvider: input.method.dataProvider ?? null,
    dependsOnMethodsJson: JSON.stringify(input.method.dependsOnMethods),
    dependsOnGroupsJson: JSON.stringify(input.method.dependsOnGroups),
    priority: input.method.priority ?? null,
    createdAt: input.createdAt,
  };
}

function toJarImportJob(row: typeof pgCaseImportJobs.$inferSelect): JarImportJob {
  return {
    id: row.id,
    projectId: row.projectId,
    ...(row.projectVersionId ? { projectVersionId: row.projectVersionId } : {}),
    ...(row.testStageId ? { testStageId: row.testStageId } : {}),
    fileName: row.fileName,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    status: row.status,
    progressPercent: row.progressPercent,
    ...(row.resultJson ? { result: jarImportResultSchema.parse(JSON.parse(row.resultJson)) } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    ...(row.errorSummary ? { errorSummary: row.errorSummary } : {}),
    ...(row.requestedBy ? { requestedBy: row.requestedBy } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.startedAt ? { startedAt: row.startedAt } : {}),
    ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
  };
}

function safeJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

// 单次查询的用例 ID 上限，避免参数过多。
const LATEST_RUN_BATCH_SIZE = 5000;

function toLatestRunOutcome(
  terminalOutcome: string | null,
  status: string,
): LatestCaseRunOutcome["outcome"] {
  if (
    terminalOutcome === "succeeded" ||
    terminalOutcome === "failed" ||
    terminalOutcome === "timed_out" ||
    terminalOutcome === "cancelled"
  ) {
    return terminalOutcome;
  }
  // terminal_outcome 为空时回退到终态 status。
  return status === "succeeded" || status === "cancelled" ? status : "failed";
}

function latestRunBatchesOf<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    batches.push(items.slice(offset, offset + size));
  }
  return batches;
}

function toSuite(row: typeof pgCaseSuites.$inferSelect, caseCount: number): CaseSuite {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    version: row.version,
    revision: row.revision,
    status: row.status,
    enabled: row.enabled,
    policy: { ...defaultCaseSuiteExecutionPolicy, ...safePolicy(row.policyJson) },
    caseCount,
    ...(row.createdBy ? { createdBy: row.createdBy } : {}),
    ...(row.updatedBy ? { updatedBy: row.updatedBy } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PostgresCaseCatalogRepository implements CaseCatalogRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  private async ready(): Promise<void> {
    await this.handle.ready;
  }

  async createJarImportJob(record: Parameters<CaseCatalogRepository["createJarImportJob"]>[0]) {
    await this.ready();
    await this.handle.db.transaction(async (transaction) => {
      const inserted = await transaction
        .insert(pgCaseImportJobs)
        .values({
          id: record.job.id,
          projectId: record.job.projectId,
          projectVersionId: record.job.projectVersionId,
          testStageId: record.job.testStageId,
          idempotencyKey: record.idempotencyKey,
          fileName: record.job.fileName,
          objectKey: record.objectKey,
          sha256: record.job.sha256,
          sizeBytes: record.job.sizeBytes,
          status: record.job.status,
          progressPercent: record.job.progressPercent,
          requestedBy: record.job.requestedBy,
          createdAt: record.job.createdAt,
          updatedAt: record.job.updatedAt,
        })
        .onConflictDoNothing()
        .returning({ id: pgCaseImportJobs.id });
      if (inserted.length === 0) return;
      await transaction.execute(sql`
        INSERT INTO transactional_outbox
          (message_id, run_id, attempt, schema_version, subject, payload_json,
           deduplication_key, created_at, available_at)
        VALUES
          (${record.dispatchJob.messageId}, ${record.dispatchJob.runId},
           ${record.dispatchJob.attempt}, ${record.dispatchJob.schemaVersion},
           ${"autoforge.jobs.v1.ready"}, ${JSON.stringify(record.dispatchJob)}::jsonb,
           ${record.dispatchJob.deduplicationKey}, ${record.dispatchJob.createdAt},
           ${record.dispatchJob.createdAt})
      `);
    });
    const [row] = await this.handle.db
      .select()
      .from(pgCaseImportJobs)
      .where(
        and(
          eq(pgCaseImportJobs.projectId, record.job.projectId),
          eq(pgCaseImportJobs.idempotencyKey, record.idempotencyKey),
          record.job.projectVersionId
            ? eq(pgCaseImportJobs.projectVersionId, record.job.projectVersionId)
            : isNull(pgCaseImportJobs.projectVersionId),
          record.job.testStageId
            ? eq(pgCaseImportJobs.testStageId, record.job.testStageId)
            : isNull(pgCaseImportJobs.testStageId),
        ),
      )
      .limit(1);
    if (!row) throw new Error("JAR import job was not persisted.");
    return toJarImportJob(row);
  }

  async getJarImportJob(jobId: string, projectIds?: readonly string[]) {
    await this.ready();
    if (projectIds?.length === 0) return null;
    const [row] = await this.handle.db
      .select()
      .from(pgCaseImportJobs)
      .where(
        projectIds
          ? and(
              eq(pgCaseImportJobs.id, jobId),
              inArray(pgCaseImportJobs.projectId, [...projectIds]),
            )
          : eq(pgCaseImportJobs.id, jobId),
      )
      .limit(1);
    return row ? toJarImportJob(row) : null;
  }

  async claimJarImportJob(input: Parameters<CaseCatalogRepository["claimJarImportJob"]>[0]) {
    await this.ready();
    const [row] = await this.handle.db
      .update(pgCaseImportJobs)
      .set({
        status: "running",
        progressPercent: 5,
        startedAt: input.startedAt,
        updatedAt: input.startedAt,
      })
      .where(
        and(
          eq(pgCaseImportJobs.id, input.jobId),
          inArray(pgCaseImportJobs.status, ["queued", "failed"]),
        ),
      )
      .returning();
    return row ? { job: toJarImportJob(row), objectKey: row.objectKey } : null;
  }

  async updateJarImportJob(input: Parameters<CaseCatalogRepository["updateJarImportJob"]>[0]) {
    await this.ready();
    const [row] = await this.handle.db
      .update(pgCaseImportJobs)
      .set({
        status: input.status,
        progressPercent: input.progressPercent,
        resultJson: input.result ? JSON.stringify(input.result) : null,
        errorCode: input.errorCode ?? null,
        errorSummary: input.errorSummary ?? null,
        updatedAt: input.updatedAt,
        finishedAt: input.finishedAt ?? null,
      })
      .where(eq(pgCaseImportJobs.id, input.jobId))
      .returning();
    if (!row) throw new DomainError("JAR_IMPORT_JOB_NOT_FOUND", "指定的 JAR 导入任务不存在。");
    return toJarImportJob(row);
  }

  async requestJarImportCancellation(
    input: Parameters<CaseCatalogRepository["requestJarImportCancellation"]>[0],
  ) {
    await this.ready();
    const scope = input.projectIds
      ? inArray(pgCaseImportJobs.projectId, [...input.projectIds])
      : undefined;
    await this.handle.db
      .update(pgCaseImportJobs)
      .set({
        status: "cancelled",
        progressPercent: 100,
        updatedAt: input.updatedAt,
        finishedAt: input.updatedAt,
      })
      .where(
        and(eq(pgCaseImportJobs.id, input.jobId), eq(pgCaseImportJobs.status, "queued"), scope),
      );
    await this.handle.db
      .update(pgCaseImportJobs)
      .set({ status: "cancel_requested", updatedAt: input.updatedAt })
      .where(
        and(eq(pgCaseImportJobs.id, input.jobId), eq(pgCaseImportJobs.status, "running"), scope),
      );
    const job = await this.getJarImportJob(input.jobId, input.projectIds);
    if (!job) throw new DomainError("JAR_IMPORT_JOB_NOT_FOUND", "指定的 JAR 导入任务不存在。");
    return job;
  }

  async retryJarImportJob(input: Parameters<CaseCatalogRepository["retryJarImportJob"]>[0]) {
    await this.ready();
    const updated = await this.handle.db.transaction(async (transaction) => {
      const scope = input.projectIds
        ? inArray(pgCaseImportJobs.projectId, [...input.projectIds])
        : undefined;
      const [row] = await transaction
        .update(pgCaseImportJobs)
        .set({
          status: "queued",
          progressPercent: 0,
          errorCode: null,
          errorSummary: null,
          resultJson: null,
          startedAt: null,
          finishedAt: null,
          updatedAt: input.updatedAt,
        })
        .where(
          and(
            eq(pgCaseImportJobs.id, input.jobId),
            inArray(pgCaseImportJobs.status, ["failed", "cancelled"]),
            scope,
          ),
        )
        .returning();
      if (!row) return undefined;
      await transaction.execute(sql`
        INSERT INTO transactional_outbox
          (message_id, run_id, attempt, schema_version, subject, payload_json,
           deduplication_key, created_at, available_at)
        VALUES
          (${input.dispatchJob.messageId}, ${input.dispatchJob.runId},
           ${input.dispatchJob.attempt}, ${input.dispatchJob.schemaVersion},
           ${"autoforge.jobs.v1.ready"}, ${JSON.stringify(input.dispatchJob)}::jsonb,
           ${input.dispatchJob.deduplicationKey}, ${input.dispatchJob.createdAt},
           ${input.dispatchJob.createdAt})
      `);
      return row;
    });
    if (!updated) throw new DomainError("JAR_IMPORT_JOB_NOT_RETRYABLE", "当前导入任务不能重试。");
    return toJarImportJob(updated);
  }

  async findSourceBySha256(
    sha256: string,
    projectId = DEFAULT_PROJECT_ID,
    projectVersionId?: string,
    testStageId?: string,
  ): Promise<ExistingSource | null> {
    await this.ready();
    const [row] = await this.handle.db
      .select({
        sourceId: pgCaseSources.id,
        classCount: pgCaseSources.classCount,
        methodCount: pgCaseSources.methodCount,
      })
      .from(pgCaseSources)
      .where(
        and(
          eq(pgCaseSources.projectId, projectId),
          eq(pgCaseSources.sha256, sha256),
          projectVersionId && testStageId
            ? and(
                eq(pgCaseSources.projectVersionId, projectVersionId),
                eq(pgCaseSources.testStageId, testStageId),
              )
            : and(isNull(pgCaseSources.projectVersionId), isNull(pgCaseSources.testStageId)),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async importCatalog(record: ImportCatalogRecord): Promise<void> {
    await this.ready();
    const projectId = record.projectId ?? DEFAULT_PROJECT_ID;
    await this.handle.db.transaction(async (transaction) => {
      await transaction.insert(pgCaseSources).values({
        id: record.sourceId,
        projectId,
        projectVersionId: record.projectVersionId,
        testStageId: record.testStageId,
        displayName: record.displayName,
        originalFileName: record.inspection.fileName,
        objectKey: record.objectKey,
        sha256: record.inspection.sha256,
        sizeBytes: record.inspection.sizeBytes,
        classCount: record.inspection.testClassCount,
        methodCount: record.inspection.testMethodCount,
        status: "ready",
        warningsJson: JSON.stringify(record.inspection.warnings),
        inspectionJson: JSON.stringify(record.inspection),
        authoritative: false,
        lifecycleStatus: "active",
        revision: 1,
        ...(record.importedBy ? { importedBy: record.importedBy } : {}),
        createdAt: record.importedAt,
        updatedAt: record.importedAt,
      });
      for (const importedCase of record.cases) {
        const candidate = importedCase.candidate;
        await transaction.insert(pgCaseDefinitions).values({
          id: importedCase.caseDefinitionId,
          projectId,
          projectVersionId: record.projectVersionId,
          testStageId: record.testStageId,
          directoryPath: candidate.packageName.replaceAll(".", "/"),
          sourceId: record.sourceId,
          className: candidate.className,
          packageName: candidate.packageName,
          displayName: candidate.simpleName,
          description: "",
          tagsJson: "[]",
          parametersJson: JSON.stringify(candidate.parameters ?? {}),
          enabled: candidate.enabled,
          archived: false,
          revision: 1,
          ...(record.importedBy ? { updatedBy: record.importedBy } : {}),
          groupsJson: JSON.stringify(candidate.groups),
          currentVersion: 1,
          createdAt: record.importedAt,
          updatedAt: record.importedAt,
        });
        await transaction.insert(pgCaseVersions).values({
          id: importedCase.caseVersionId,
          caseDefinitionId: importedCase.caseDefinitionId,
          sourceId: record.sourceId,
          version: 1,
          snapshotJson: JSON.stringify(candidate),
          ...(record.importedBy ? { createdBy: record.importedBy } : {}),
          changeReason: "source.import",
          createdAt: record.importedAt,
        });
        if (importedCase.methods.length > 0) {
          await transaction.insert(pgTestMethods).values(
            importedCase.methods.map(({ methodId, methodIndex }) => {
              const method = candidate.methods[methodIndex];
              if (!method) throw new Error(`Missing imported method at index ${methodIndex}.`);
              return testMethodInsertValues({
                id: methodId,
                caseDefinitionId: importedCase.caseDefinitionId,
                method,
                createdAt: record.importedAt,
              });
            }),
          );
        }
      }
    });
  }

  async listCases(query: CaseListQuery): Promise<CaseListPage> {
    await this.ready();
    if (query.projectIds?.length === 0) return { items: [] };
    const conditions: SQL[] = [];
    if (query.projectIds)
      conditions.push(inArray(pgCaseDefinitions.projectId, [...query.projectIds]));
    if (query.projectVersionId)
      conditions.push(eq(pgCaseDefinitions.projectVersionId, query.projectVersionId));
    if (query.testStageId) conditions.push(eq(pgCaseDefinitions.testStageId, query.testStageId));
    if (query.scopedOnly) {
      conditions.push(sql`${pgCaseDefinitions.projectVersionId} IS NOT NULL`);
      conditions.push(sql`${pgCaseDefinitions.testStageId} IS NOT NULL`);
    }
    const normalized = query.query?.trim();
    if (normalized) {
      const search = or(
        like(pgCaseDefinitions.className, `%${normalized}%`),
        like(pgCaseDefinitions.displayName, `%${normalized}%`),
      );
      if (search) conditions.push(search);
    }
    if (query.cursor) conditions.push(lt(pgCaseDefinitions.id, query.cursor));
    const rows = await this.handle.db
      .select()
      .from(pgCaseDefinitions)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(pgCaseDefinitions.id))
      .limit(query.limit + 1);
    const pageRows = rows.slice(0, query.limit);
    const ids = pageRows.map((row) => row.id);
    const methodRows = ids.length
      ? await this.handle.db
          .select()
          .from(pgTestMethods)
          .where(inArray(pgTestMethods.caseDefinitionId, ids))
      : [];
    const methods = new Map<string, TestMethod[]>();
    for (const row of methodRows) {
      const values = methods.get(row.caseDefinitionId) ?? [];
      values.push(toMethod(row));
      methods.set(row.caseDefinitionId, values);
    }
    const items = pageRows.map((row): CaseDefinitionWithMethods => ({
      ...toCaseDefinition(row),
      methods: (methods.get(row.id) ?? []).sort((left, right) =>
        left.methodName.localeCompare(right.methodName),
      ),
    }));
    const last = pageRows.at(-1);
    return { items, ...(rows.length > query.limit && last ? { nextCursor: last.id } : {}) };
  }

  async getCaseDefinition(
    caseDefinitionId: string,
    projectIds?: readonly string[],
  ): Promise<CaseDefinitionWithMethods | null> {
    await this.ready();
    if (projectIds?.length === 0) return null;
    const [row] = await this.handle.db
      .select()
      .from(pgCaseDefinitions)
      .where(
        and(
          eq(pgCaseDefinitions.id, caseDefinitionId),
          ...(projectIds ? [inArray(pgCaseDefinitions.projectId, [...projectIds])] : []),
        ),
      )
      .limit(1);
    if (!row) return null;
    const methodRows = await this.handle.db
      .select()
      .from(pgTestMethods)
      .where(eq(pgTestMethods.caseDefinitionId, row.id));
    return {
      ...toCaseDefinition(row),
      methods: methodRows
        .map(toMethod)
        .sort((left, right) => left.methodName.localeCompare(right.methodName)),
    };
  }

  async listCaseActivity(caseDefinitionId: string, limit: number): Promise<CaseActivity> {
    await this.ready();
    const [executionResult, analysisResult] = await Promise.all([
      this.handle.pool.query<{
        run_id: string;
        batch_id: string;
        status: string;
        created_at: string;
        attempt_id: string | null;
        runner_id: string | null;
        result_code: string | null;
        duration_ms: string | number | null;
        finished_at: string | null;
      }>(
        `SELECT r.id AS run_id, r.batch_id, r.status, r.created_at,
                a.id AS attempt_id, a.runner_id, a.result_code, a.duration_ms, a.finished_at
         FROM execution_runs r
         LEFT JOIN LATERAL (
           SELECT * FROM run_attempts latest
           WHERE latest.execution_run_id = r.id
           ORDER BY latest.attempt_number DESC LIMIT 1
         ) a ON TRUE
         WHERE r.case_definition_id = $1
         ORDER BY r.created_at DESC, r.id DESC LIMIT $2`,
        [caseDefinitionId, limit],
      ),
      this.handle.pool.query<{
        attempt_id: string;
        batch_id: string;
        outcome: string;
        result_code: string | null;
        failure_signature: string | null;
        duration_ms: string | number | null;
        passed: number;
        failed: number;
        skipped: number;
        completed_at: string;
      }>(
        `SELECT attempt_id, batch_id, outcome, result_code, failure_signature, duration_ms,
                passed, failed, skipped, completed_at
         FROM analytics_facts WHERE case_definition_id = $1
         ORDER BY completed_at DESC, attempt_id DESC LIMIT $2`,
        [caseDefinitionId, limit],
      ),
    ]);
    return {
      executions: executionResult.rows.map((row) => ({
        runId: row.run_id,
        batchId: row.batch_id,
        status: row.status,
        ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
        ...(row.runner_id ? { runnerId: row.runner_id } : {}),
        ...(row.result_code ? { resultCode: row.result_code } : {}),
        ...(row.duration_ms === null ? {} : { durationMs: Number(row.duration_ms) }),
        createdAt: row.created_at,
        ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      })),
      analyses: analysisResult.rows.map((row) => ({
        attemptId: row.attempt_id,
        batchId: row.batch_id,
        outcome: row.outcome,
        ...(row.result_code ? { resultCode: row.result_code } : {}),
        ...(row.failure_signature ? { failureSignature: row.failure_signature } : {}),
        ...(row.duration_ms === null ? {} : { durationMs: Number(row.duration_ms) }),
        passed: row.passed,
        failed: row.failed,
        skipped: row.skipped,
        completedAt: row.completed_at,
      })),
    };
  }

  async listLatestRunOutcomes(
    caseDefinitionIds: readonly string[],
  ): Promise<LatestCaseRunOutcome[]> {
    await this.ready();
    if (caseDefinitionIds.length === 0) return [];
    const outcomes: LatestCaseRunOutcome[] = [];
    for (const batch of latestRunBatchesOf(
      [...new Set(caseDefinitionIds)],
      LATEST_RUN_BATCH_SIZE,
    )) {
      const placeholders = batch.map((_, index) => `$${index + 1}`).join(", ");
      // 每个用例只取最新一条终态 run（succeeded/failed/cancelled）；
      // created_at 相同时用 id（UUIDv7，时间有序）作为次序，保证结果确定。
      const result = await this.handle.pool.query<{
        case_definition_id: string;
        status: string;
        terminal_outcome: string | null;
        created_at: string;
      }>(
        `SELECT DISTINCT ON (case_definition_id)
                case_definition_id, status, terminal_outcome, created_at
         FROM execution_runs
         WHERE case_definition_id IN (${placeholders})
           AND status IN ('succeeded', 'failed', 'cancelled')
         ORDER BY case_definition_id, created_at DESC, id DESC`,
        batch,
      );
      for (const row of result.rows) {
        outcomes.push({
          caseDefinitionId: row.case_definition_id,
          outcome: toLatestRunOutcome(row.terminal_outcome, row.status),
          executedAt: row.created_at,
        });
      }
    }
    return outcomes;
  }

  async updateCaseDefinition(input: {
    caseDefinitionId: string;
    expectedRevision: number;
    displayName?: string;
    description?: string;
    tags?: string[];
    enabled?: boolean;
    archived?: boolean;
    actorId: string;
    updatedAt: string;
  }): Promise<CaseDefinitionWithMethods> {
    await this.ready();
    const [updated] = await this.handle.db
      .update(pgCaseDefinitions)
      .set({
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.tags !== undefined ? { tagsJson: JSON.stringify(input.tags) } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
        revision: sql`${pgCaseDefinitions.revision} + 1`,
        updatedBy: input.actorId,
        updatedAt: input.updatedAt,
      })
      .where(
        and(
          eq(pgCaseDefinitions.id, input.caseDefinitionId),
          eq(pgCaseDefinitions.revision, input.expectedRevision),
        ),
      )
      .returning();
    if (!updated) await this.throwCaseDefinitionConflict(input.caseDefinitionId);
    const definition = await this.getCaseDefinition(input.caseDefinitionId);
    if (!definition) throw new DomainError("CASE_DEFINITION_NOT_FOUND", "指定的用例不存在。");
    return definition;
  }

  async listCaseVersions(caseDefinitionId: string, limit: number): Promise<CaseVersion[]> {
    await this.ready();
    return (
      await this.handle.db
        .select()
        .from(pgCaseVersions)
        .where(eq(pgCaseVersions.caseDefinitionId, caseDefinitionId))
        .orderBy(desc(pgCaseVersions.version))
        .limit(limit)
    ).map(toCaseVersion);
  }

  async getCaseVersion(caseDefinitionId: string, version: number): Promise<CaseVersion | null> {
    await this.ready();
    const [row] = await this.handle.db
      .select()
      .from(pgCaseVersions)
      .where(
        and(
          eq(pgCaseVersions.caseDefinitionId, caseDefinitionId),
          eq(pgCaseVersions.version, version),
        ),
      )
      .limit(1);
    return row ? toCaseVersion(row) : null;
  }

  async restoreCaseVersion(input: {
    caseDefinitionId: string;
    expectedRevision: number;
    versionId: string;
    version: number;
    sourceId: string;
    snapshot: TestNgClassCandidate;
    changeReason: string;
    methodIds: string[];
    actorId: string;
    restoredAt: string;
  }): Promise<CaseDefinitionWithMethods> {
    await this.ready();
    if (input.methodIds.length !== input.snapshot.methods.length) {
      throw new Error("Restore method identifiers must match the snapshot method count.");
    }
    await this.handle.db.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(pgCaseDefinitions)
        .set({
          groupsJson: JSON.stringify(input.snapshot.groups),
          parametersJson: JSON.stringify(input.snapshot.parameters ?? {}),
          enabled: input.snapshot.enabled,
          sourceId: input.sourceId,
          currentVersion: input.version,
          revision: sql`${pgCaseDefinitions.revision} + 1`,
          updatedBy: input.actorId,
          updatedAt: input.restoredAt,
        })
        .where(
          and(
            eq(pgCaseDefinitions.id, input.caseDefinitionId),
            eq(pgCaseDefinitions.revision, input.expectedRevision),
          ),
        )
        .returning({ id: pgCaseDefinitions.id });
      if (!updated) {
        const [existing] = await transaction
          .select({ id: pgCaseDefinitions.id })
          .from(pgCaseDefinitions)
          .where(eq(pgCaseDefinitions.id, input.caseDefinitionId))
          .limit(1);
        if (!existing) throw new DomainError("CASE_DEFINITION_NOT_FOUND", "指定的用例不存在。");
        throw new DomainError(
          "CASE_DEFINITION_REVISION_CONFLICT",
          "用例已被并发修改，请刷新后重试。",
        );
      }
      await transaction
        .delete(pgTestMethods)
        .where(eq(pgTestMethods.caseDefinitionId, input.caseDefinitionId));
      if (input.snapshot.methods.length > 0) {
        await transaction.insert(pgTestMethods).values(
          input.snapshot.methods.map((method, index) =>
            testMethodInsertValues({
              id: input.methodIds[index]!,
              caseDefinitionId: input.caseDefinitionId,
              method,
              createdAt: input.restoredAt,
            }),
          ),
        );
      }
      await transaction.insert(pgCaseVersions).values({
        id: input.versionId,
        caseDefinitionId: input.caseDefinitionId,
        sourceId: input.sourceId,
        version: input.version,
        snapshotJson: JSON.stringify(input.snapshot),
        createdBy: input.actorId,
        changeReason: input.changeReason,
        createdAt: input.restoredAt,
      });
    });
    const definition = await this.getCaseDefinition(input.caseDefinitionId);
    if (!definition) throw new DomainError("CASE_DEFINITION_NOT_FOUND", "指定的用例不存在。");
    return definition;
  }

  private async throwCaseDefinitionConflict(caseDefinitionId: string): Promise<never> {
    const [existing] = await this.handle.db
      .select({ id: pgCaseDefinitions.id })
      .from(pgCaseDefinitions)
      .where(eq(pgCaseDefinitions.id, caseDefinitionId))
      .limit(1);
    if (!existing) throw new DomainError("CASE_DEFINITION_NOT_FOUND", "指定的用例不存在。");
    throw new DomainError("CASE_DEFINITION_REVISION_CONFLICT", "用例已被并发修改，请刷新后重试。");
  }

  async findExistingCaseIds(caseDefinitionIds: string[], projectId?: string): Promise<string[]> {
    await this.ready();
    if (!caseDefinitionIds.length) return [];
    return (
      await this.handle.db
        .select({ id: pgCaseDefinitions.id })
        .from(pgCaseDefinitions)
        .where(
          and(
            inArray(pgCaseDefinitions.id, caseDefinitionIds),
            ...(projectId ? [eq(pgCaseDefinitions.projectId, projectId)] : []),
          ),
        )
    ).map((row) => row.id);
  }

  async listRecentSources(limit: number, projectIds?: readonly string[]): Promise<CaseSource[]> {
    await this.ready();
    if (projectIds?.length === 0) return [];
    return (
      await this.handle.db
        .select()
        .from(pgCaseSources)
        .where(projectIds ? inArray(pgCaseSources.projectId, [...projectIds]) : undefined)
        .orderBy(desc(pgCaseSources.createdAt))
        .limit(limit)
    ).map(toSource);
  }

  async listSources(limit: number, projectIds?: readonly string[]): Promise<CaseSource[]> {
    return this.listRecentSources(limit, projectIds);
  }

  async getSource(sourceId: string, projectIds?: readonly string[]) {
    await this.ready();
    if (projectIds?.length === 0) return null;
    const [row] = await this.handle.db
      .select()
      .from(pgCaseSources)
      .where(
        and(
          eq(pgCaseSources.id, sourceId),
          ...(projectIds ? [inArray(pgCaseSources.projectId, [...projectIds])] : []),
        ),
      )
      .limit(1);
    if (!row) return null;
    const inspection = jarInspectionSchema.parse(JSON.parse(row.inspectionJson));
    return { source: toSource(row), inspection };
  }

  async setAuthoritativeSource(sourceId: string, projectId?: string): Promise<CaseSource> {
    await this.ready();
    return this.handle.db.transaction(async (transaction) => {
      const [source] = await transaction
        .select()
        .from(pgCaseSources)
        .where(eq(pgCaseSources.id, sourceId))
        .limit(1);
      if (!source || (projectId && source.projectId !== projectId)) {
        throw new Error(`Case source ${sourceId} does not exist.`);
      }
      await transaction
        .update(pgCaseSources)
        .set({ authoritative: false })
        .where(eq(pgCaseSources.projectId, source.projectId));
      const [row] = await transaction
        .update(pgCaseSources)
        .set({
          authoritative: true,
          revision: source.revision + 1,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(pgCaseSources.id, sourceId))
        .returning();
      if (!row) throw new Error(`Case source ${sourceId} does not exist.`);
      return toSource(row);
    });
  }

  async getAuthoritativeSource(projectId: string): Promise<CaseSource | null> {
    await this.ready();
    const [row] = await this.handle.db
      .select()
      .from(pgCaseSources)
      .where(and(eq(pgCaseSources.projectId, projectId), eq(pgCaseSources.authoritative, true)))
      .limit(1);
    return row ? toSource(row) : null;
  }

  async listSourceCaseSnapshots(
    sourceId: string,
  ): Promise<Array<{ caseDefinitionId: string; className: string; snapshotJson: string }>> {
    await this.ready();
    return this.handle.db
      .select({
        caseDefinitionId: pgCaseDefinitions.id,
        className: pgCaseDefinitions.className,
        snapshotJson: pgCaseVersions.snapshotJson,
      })
      .from(pgCaseDefinitions)
      .innerJoin(pgCaseVersions, eq(pgCaseVersions.caseDefinitionId, pgCaseDefinitions.id))
      .where(
        and(
          eq(pgCaseVersions.sourceId, sourceId),
          sql`${pgCaseVersions.version} = (
            SELECT MAX(source_version.version)
            FROM case_versions source_version
            WHERE source_version.case_definition_id = ${pgCaseVersions.caseDefinitionId}
              AND source_version.source_id = ${sourceId}
          )`,
        ),
      );
  }

  async createSourceComparison(
    record: CreateSourceComparisonRecord,
  ): Promise<CaseSourceComparison> {
    await this.ready();
    await this.handle.db.insert(pgCaseSourceComparisons).values({
      id: record.id,
      projectId: record.projectId,
      currentSourceId: record.currentSourceId ?? null,
      candidateSourceId: record.candidateSourceId,
      addedJson: JSON.stringify(record.added),
      changedJson: JSON.stringify(record.changed),
      removedJson: JSON.stringify(record.removed),
      conflictsJson: JSON.stringify(record.conflicts),
      truncated: record.truncated,
      ...(record.createdBy ? { createdBy: record.createdBy } : {}),
      createdAt: record.createdAt,
    });
    const comparison = await this.getSourceComparison(record.id);
    if (!comparison) throw new Error(`Case source comparison ${record.id} was not persisted.`);
    return comparison;
  }

  async getSourceComparison(comparisonId: string): Promise<CaseSourceComparison | null> {
    await this.ready();
    const [row] = await this.handle.db
      .select()
      .from(pgCaseSourceComparisons)
      .where(eq(pgCaseSourceComparisons.id, comparisonId))
      .limit(1);
    return row ? toSourceComparison(row) : null;
  }

  async promoteAuthoritativeSource(input: {
    sourceId: string;
    expectedRevision: number;
    updatedAt: string;
    actorId?: string;
    versionMerges?: CaseSourceVersionMerge[];
  }): Promise<CaseSource> {
    await this.ready();
    return this.handle.db.transaction(async (transaction) => {
      const [target] = await transaction
        .select()
        .from(pgCaseSources)
        .where(eq(pgCaseSources.id, input.sourceId))
        .limit(1);
      if (!target) throw new DomainError("CASE_SOURCE_NOT_FOUND", "指定的 JAR 来源不存在。");
      if (target.revision !== input.expectedRevision) {
        return throwPostgresSourceConflict(transaction, input.sourceId);
      }
      const [current] = await transaction
        .select({ id: pgCaseSources.id })
        .from(pgCaseSources)
        .where(
          and(eq(pgCaseSources.projectId, target.projectId), eq(pgCaseSources.authoritative, true)),
        )
        .limit(1);
      for (const merge of input.versionMerges ?? []) {
        if (merge.methodIds.length !== merge.snapshot.methods.length) {
          throw new Error("Source sync method identifiers must match the snapshot method count.");
        }
        const [currentDefinition] = await transaction
          .select()
          .from(pgCaseDefinitions)
          .where(eq(pgCaseDefinitions.id, merge.currentCaseDefinitionId))
          .limit(1);
        const [candidateDefinition] = await transaction
          .select()
          .from(pgCaseDefinitions)
          .where(eq(pgCaseDefinitions.id, merge.candidateCaseDefinitionId))
          .limit(1);
        const [currentSourceVersion] = current
          ? await transaction
              .select({ id: pgCaseVersions.id })
              .from(pgCaseVersions)
              .where(
                and(
                  eq(pgCaseVersions.caseDefinitionId, merge.currentCaseDefinitionId),
                  eq(pgCaseVersions.sourceId, current.id),
                ),
              )
              .orderBy(desc(pgCaseVersions.version))
              .limit(1)
          : [];
        if (
          !currentDefinition ||
          !candidateDefinition ||
          !currentSourceVersion ||
          candidateDefinition.sourceId !== target.id ||
          currentDefinition.className !== candidateDefinition.className ||
          candidateDefinition.className !== merge.snapshot.className
        ) {
          throw new DomainError(
            "CASE_SOURCE_SYNC_STALE",
            "来源用例在确认同步前已变化，请重新对比。",
          );
        }
        const [suiteReference, runReference] = await Promise.all([
          transaction
            .select({ value: count() })
            .from(pgCaseSuiteItems)
            .where(eq(pgCaseSuiteItems.caseDefinitionId, candidateDefinition.id)),
          transaction
            .select({ value: count() })
            .from(pgExecutionRuns)
            .where(eq(pgExecutionRuns.caseDefinitionId, candidateDefinition.id)),
        ]);
        if ((suiteReference[0]?.value ?? 0) > 0 || (runReference[0]?.value ?? 0) > 0) {
          throw new DomainError(
            "CASE_SOURCE_SYNC_CANDIDATE_IN_USE",
            `候选来源中的 ${candidateDefinition.className} 已被任务或执行引用，不能合并到现有用例。`,
          );
        }

        await transaction
          .delete(pgCaseDefinitions)
          .where(eq(pgCaseDefinitions.id, candidateDefinition.id));
        const nextVersion = currentDefinition.currentVersion + 1;
        await transaction
          .update(pgCaseDefinitions)
          .set({
            sourceId: target.id,
            groupsJson: JSON.stringify(merge.snapshot.groups),
            parametersJson: JSON.stringify(merge.snapshot.parameters ?? {}),
            currentVersion: nextVersion,
            revision: sql`${pgCaseDefinitions.revision} + 1`,
            ...(input.actorId ? { updatedBy: input.actorId } : {}),
            updatedAt: input.updatedAt,
          })
          .where(eq(pgCaseDefinitions.id, currentDefinition.id));
        await transaction
          .delete(pgTestMethods)
          .where(eq(pgTestMethods.caseDefinitionId, currentDefinition.id));
        if (merge.snapshot.methods.length > 0) {
          await transaction.insert(pgTestMethods).values(
            merge.snapshot.methods.map((method, index) =>
              testMethodInsertValues({
                id: merge.methodIds[index]!,
                caseDefinitionId: currentDefinition.id,
                method,
                createdAt: input.updatedAt,
              }),
            ),
          );
        }
        await transaction.insert(pgCaseVersions).values({
          id: merge.caseVersionId,
          caseDefinitionId: currentDefinition.id,
          sourceId: target.id,
          version: nextVersion,
          snapshotJson: JSON.stringify(merge.snapshot),
          ...(input.actorId ? { createdBy: input.actorId } : {}),
          changeReason: "source.sync",
          createdAt: input.updatedAt,
        });
      }
      await transaction
        .update(pgCaseSources)
        .set({
          authoritative: false,
          revision: sql`${pgCaseSources.revision} + 1`,
          updatedAt: input.updatedAt,
        })
        .where(
          and(eq(pgCaseSources.projectId, target.projectId), eq(pgCaseSources.authoritative, true)),
        );
      const [row] = await transaction
        .update(pgCaseSources)
        .set({
          authoritative: true,
          revision: sql`${pgCaseSources.revision} + 1`,
          updatedAt: input.updatedAt,
        })
        .where(
          and(
            eq(pgCaseSources.id, input.sourceId),
            eq(pgCaseSources.revision, input.expectedRevision),
          ),
        )
        .returning();
      if (!row) return throwPostgresSourceConflict(transaction, input.sourceId);
      return toSource(row);
    });
  }

  async updateSourceLifecycle(input: {
    sourceId: string;
    expectedRevision: number;
    lifecycleStatus: "active" | "archived" | "deleting";
    updatedAt: string;
  }): Promise<CaseSource> {
    await this.ready();
    const [row] = await this.handle.db
      .update(pgCaseSources)
      .set({
        lifecycleStatus: input.lifecycleStatus,
        revision: sql`${pgCaseSources.revision} + 1`,
        updatedAt: input.updatedAt,
      })
      .where(
        and(
          eq(pgCaseSources.id, input.sourceId),
          eq(pgCaseSources.revision, input.expectedRevision),
        ),
      )
      .returning();
    if (!row) return throwPostgresSourceConflict(this.handle.db, input.sourceId);
    return toSource(row);
  }

  async countSourceReferences(
    sourceId: string,
  ): Promise<{ caseDefinitions: number; caseVersions: number; executionRuns: number }> {
    await this.ready();
    const [caseRows, versionRows, runRows] = await Promise.all([
      this.handle.db
        .select({ value: count() })
        .from(pgCaseDefinitions)
        .where(eq(pgCaseDefinitions.sourceId, sourceId)),
      this.handle.db
        .select({ value: count() })
        .from(pgCaseVersions)
        .where(eq(pgCaseVersions.sourceId, sourceId)),
      this.handle.db
        .select({ value: count() })
        .from(pgExecutionRuns)
        .innerJoin(
          pgCaseVersions,
          and(
            eq(pgCaseVersions.caseDefinitionId, pgExecutionRuns.caseDefinitionId),
            eq(pgCaseVersions.version, pgExecutionRuns.caseVersion),
          ),
        )
        .where(eq(pgCaseVersions.sourceId, sourceId)),
    ]);
    return {
      caseDefinitions: caseRows[0]?.value ?? 0,
      caseVersions: versionRows[0]?.value ?? 0,
      executionRuns: runRows[0]?.value ?? 0,
    };
  }

  async enqueueSourceDeletion(input: {
    sourceId: string;
    expectedRevision: number;
    cleanupJobId: string;
    objectKey: string;
    availableAt: string;
    updatedAt: string;
  }): Promise<CaseSource> {
    await this.ready();
    return this.handle.db.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(pgCaseSources)
        .set({
          lifecycleStatus: "deleting",
          revision: sql`${pgCaseSources.revision} + 1`,
          updatedAt: input.updatedAt,
        })
        .where(
          and(
            eq(pgCaseSources.id, input.sourceId),
            eq(pgCaseSources.revision, input.expectedRevision),
            eq(pgCaseSources.authoritative, false),
          ),
        )
        .returning();
      if (!updated) return throwPostgresSourceConflict(transaction, input.sourceId);
      await transaction
        .insert(pgCleanupJobs)
        .values({
          id: input.cleanupJobId,
          category: "case-source",
          resourceType: "case-source",
          resourceId: input.sourceId,
          objectKey: input.objectKey,
          status: "pending",
          attemptCount: 0,
          availableAt: input.availableAt,
          createdAt: input.updatedAt,
          updatedAt: input.updatedAt,
        })
        .onConflictDoNothing();
      return toSource(updated);
    });
  }

  async getCleanupJob(cleanupJobId: string): Promise<CleanupJob | null> {
    await this.ready();
    const [row] = await this.handle.db
      .select()
      .from(pgCleanupJobs)
      .where(eq(pgCleanupJobs.id, cleanupJobId))
      .limit(1);
    return row ? toCleanupJob(row) : null;
  }

  async completeCleanupJob(input: {
    id: string;
    status: "succeeded" | "failed";
    attemptCount: number;
    errorSummary?: string;
    finishedAt: string;
  }): Promise<void> {
    await this.ready();
    await this.handle.db.transaction(async (transaction) => {
      const [job] = await transaction
        .select({ category: pgCleanupJobs.category, resourceId: pgCleanupJobs.resourceId })
        .from(pgCleanupJobs)
        .where(eq(pgCleanupJobs.id, input.id))
        .for("update");
      await transaction
        .update(pgCleanupJobs)
        .set({
          status: input.status,
          attemptCount: input.attemptCount,
          errorSummary: input.errorSummary ?? null,
          updatedAt: input.finishedAt,
        })
        .where(eq(pgCleanupJobs.id, input.id));
      if (input.status === "succeeded" && job?.category === "case-source") {
        await transaction
          .delete(pgCaseSources)
          .where(
            and(
              eq(pgCaseSources.id, job.resourceId),
              eq(pgCaseSources.lifecycleStatus, "deleting"),
            ),
          );
      }
    });
  }

  async getDashboardSummary(projectIds?: readonly string[]): Promise<DashboardSummary> {
    await this.ready();
    if (projectIds?.length === 0) {
      return { sourceCount: 0, caseCount: 0, methodCount: 0, enabledMethodCount: 0 };
    }
    const sourceScope = projectIds ? inArray(pgCaseSources.projectId, [...projectIds]) : undefined;
    const caseScope = projectIds
      ? inArray(pgCaseDefinitions.projectId, [...projectIds])
      : undefined;
    const [sources, cases, methods, enabled] = await Promise.all([
      this.handle.db.select({ value: count() }).from(pgCaseSources).where(sourceScope),
      this.handle.db.select({ value: count() }).from(pgCaseDefinitions).where(caseScope),
      this.handle.db
        .select({ value: count() })
        .from(pgTestMethods)
        .innerJoin(pgCaseDefinitions, eq(pgCaseDefinitions.id, pgTestMethods.caseDefinitionId))
        .where(caseScope),
      this.handle.db
        .select({ value: count() })
        .from(pgTestMethods)
        .innerJoin(pgCaseDefinitions, eq(pgCaseDefinitions.id, pgTestMethods.caseDefinitionId))
        .where(and(eq(pgTestMethods.enabled, true), ...(caseScope ? [caseScope] : []))),
    ]);
    return {
      sourceCount: sources[0]?.value ?? 0,
      caseCount: cases[0]?.value ?? 0,
      methodCount: methods[0]?.value ?? 0,
      enabledMethodCount: enabled[0]?.value ?? 0,
    };
  }
}

export class PostgresCaseSuiteRepository implements CaseSuiteRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  private async ready(): Promise<void> {
    await this.handle.ready;
  }

  async create(record: CreateCaseSuiteRecord): Promise<CaseSuite> {
    await this.ready();
    const [row] = await this.handle.db
      .insert(pgCaseSuites)
      .values({
        id: record.id,
        projectId: record.projectId ?? DEFAULT_PROJECT_ID,
        name: record.name,
        description: record.description ?? null,
        version: 1,
        status: "active",
        enabled: true,
        revision: 1,
        policyJson: JSON.stringify(record.policy ?? defaultCaseSuiteExecutionPolicy),
        ...(record.actorId ? { createdBy: record.actorId, updatedBy: record.actorId } : {}),
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
      })
      .returning();
    if (!row) throw new Error("PostgreSQL did not return the created case suite.");
    return toSuite(row, 0);
  }

  async list(limit: number, projectIds?: readonly string[]): Promise<CaseSuite[]> {
    await this.ready();
    if (projectIds?.length === 0) return [];
    const [rows, counts] = await Promise.all([
      this.handle.db
        .select()
        .from(pgCaseSuites)
        .where(projectIds ? inArray(pgCaseSuites.projectId, [...projectIds]) : undefined)
        .orderBy(desc(pgCaseSuites.updatedAt))
        .limit(limit),
      this.handle.db
        .select({ suiteId: pgCaseSuiteItems.suiteId, value: count() })
        .from(pgCaseSuiteItems)
        .groupBy(pgCaseSuiteItems.suiteId),
    ]);
    const countBySuite = new Map(counts.map((row) => [row.suiteId, row.value]));
    return rows.map((row) => toSuite(row, countBySuite.get(row.id) ?? 0));
  }

  async get(suiteId: string, projectIds?: readonly string[]): Promise<CaseSuiteDetails | null> {
    await this.ready();
    if (projectIds?.length === 0) return null;
    const [suite] = await this.handle.db
      .select()
      .from(pgCaseSuites)
      .where(
        and(
          eq(pgCaseSuites.id, suiteId),
          ...(projectIds ? [inArray(pgCaseSuites.projectId, [...projectIds])] : []),
        ),
      )
      .limit(1);
    if (!suite) return null;
    const itemRows = await this.handle.db
      .select()
      .from(pgCaseSuiteItems)
      .where(eq(pgCaseSuiteItems.suiteId, suiteId))
      .orderBy(asc(pgCaseSuiteItems.addedAt), asc(pgCaseSuiteItems.id));
    const ids = itemRows.map((row) => row.caseDefinitionId);
    const [definitions, methodRows] = ids.length
      ? await Promise.all([
          this.handle.db.select().from(pgCaseDefinitions).where(inArray(pgCaseDefinitions.id, ids)),
          this.handle.db
            .select()
            .from(pgTestMethods)
            .where(inArray(pgTestMethods.caseDefinitionId, ids)),
        ])
      : [[], []];
    const methods = new Map<string, TestMethod[]>();
    for (const row of methodRows) {
      const values = methods.get(row.caseDefinitionId) ?? [];
      values.push(toMethod(row));
      methods.set(row.caseDefinitionId, values);
    }
    const byId = new Map(
      definitions.map((row) => [
        row.id,
        {
          id: row.id,
          projectId: row.projectId,
          ...(row.projectVersionId ? { projectVersionId: row.projectVersionId } : {}),
          ...(row.testStageId ? { testStageId: row.testStageId } : {}),
          directoryPath: row.directoryPath,
          sourceId: row.sourceId,
          className: row.className,
          packageName: row.packageName,
          displayName: row.displayName,
          description: row.description,
          tags: stringArray(row.tagsJson),
          enabled: row.enabled,
          archived: row.archived,
          groups: stringArray(row.groupsJson),
          parameters: stringRecord(row.parametersJson),
          currentVersion: row.currentVersion,
          revision: row.revision,
          ...(row.updatedBy ? { updatedBy: row.updatedBy } : {}),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          methods: methods.get(row.id) ?? [],
        } satisfies CaseDefinitionWithMethods,
      ]),
    );
    const items = itemRows.flatMap((row) => {
      const definition = byId.get(row.caseDefinitionId);
      return definition
        ? [{ id: row.id, suiteId: row.suiteId, caseDefinition: definition, addedAt: row.addedAt }]
        : [];
    });
    return { ...toSuite(suite, items.length), items };
  }

  async addCases(input: {
    suiteId: string;
    items: Array<{ id: string; caseDefinitionId: string }>;
    versionId: string;
    actorId?: string;
    updatedAt: string;
  }): Promise<CaseSuiteDetails> {
    await this.ready();
    await this.handle.db.transaction(async (transaction) => {
      if (!input.items.length) return;
      const inserted = await transaction
        .insert(pgCaseSuiteItems)
        .values(
          input.items.map((item) => ({
            id: item.id,
            suiteId: input.suiteId,
            caseDefinitionId: item.caseDefinitionId,
            addedAt: input.updatedAt,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: pgCaseSuiteItems.id });
      if (inserted.length) {
        await transaction
          .update(pgCaseSuites)
          .set({
            version: sql`${pgCaseSuites.version} + 1`,
            revision: sql`${pgCaseSuites.revision} + 1`,
            ...(input.actorId ? { updatedBy: input.actorId } : {}),
            updatedAt: input.updatedAt,
          })
          .where(eq(pgCaseSuites.id, input.suiteId));
        await this.insertVersionSnapshot(
          transaction,
          input.suiteId,
          input.versionId,
          "suite.cases.add",
          input,
        );
      }
    });
    const suite = await this.get(input.suiteId);
    if (!suite) throw new Error(`Case suite ${input.suiteId} does not exist.`);
    return suite;
  }

  async removeCase(input: {
    suiteId: string;
    caseDefinitionId: string;
    versionId: string;
    actorId?: string;
    updatedAt: string;
  }): Promise<CaseSuiteDetails> {
    await this.ready();
    await this.handle.db.transaction(async (transaction) => {
      const deleted = await transaction
        .delete(pgCaseSuiteItems)
        .where(
          and(
            eq(pgCaseSuiteItems.suiteId, input.suiteId),
            eq(pgCaseSuiteItems.caseDefinitionId, input.caseDefinitionId),
          ),
        )
        .returning({ id: pgCaseSuiteItems.id });
      if (deleted.length) {
        await transaction
          .update(pgCaseSuites)
          .set({
            version: sql`${pgCaseSuites.version} + 1`,
            revision: sql`${pgCaseSuites.revision} + 1`,
            ...(input.actorId ? { updatedBy: input.actorId } : {}),
            updatedAt: input.updatedAt,
          })
          .where(eq(pgCaseSuites.id, input.suiteId));
        await this.insertVersionSnapshot(
          transaction,
          input.suiteId,
          input.versionId,
          "suite.cases.remove",
          input,
        );
      }
    });
    const suite = await this.get(input.suiteId);
    if (!suite) throw new Error(`Case suite ${input.suiteId} does not exist.`);
    return suite;
  }

  async updateSuite(input: UpdateCaseSuiteRecord): Promise<CaseSuiteDetails> {
    await this.ready();
    await this.handle.db.transaction(async (transaction) => {
      const patch: Record<string, unknown> = {
        version: sql`${pgCaseSuites.version} + 1`,
        revision: sql`${pgCaseSuites.revision} + 1`,
        updatedAt: input.updatedAt,
      };
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description;
      if (input.enabled !== undefined) patch.enabled = input.enabled;
      if (input.archived !== undefined) patch.status = input.archived ? "archived" : "active";
      if (input.policy !== undefined) patch.policyJson = JSON.stringify(input.policy);
      if (input.actorId) patch.updatedBy = input.actorId;
      const updated = await transaction
        .update(pgCaseSuites)
        .set(patch)
        .where(
          and(
            eq(pgCaseSuites.id, input.suiteId),
            eq(pgCaseSuites.revision, input.expectedRevision),
          ),
        )
        .returning({ id: pgCaseSuites.id });
      if (updated.length !== 1) await throwPostgresSuiteConflict(transaction, input.suiteId);
      await this.insertVersionSnapshot(
        transaction,
        input.suiteId,
        input.versionId,
        input.changeReason,
        input,
      );
    });
    const suite = await this.get(input.suiteId);
    if (!suite) throw new Error(`Case suite ${input.suiteId} does not exist.`);
    return suite;
  }

  async copySuite(input: CopyCaseSuiteRecord): Promise<CaseSuiteDetails> {
    await this.ready();
    await this.handle.db.transaction(async (transaction) => {
      await transaction.insert(pgCaseSuites).values({
        id: input.id,
        projectId: input.projectId ?? DEFAULT_PROJECT_ID,
        name: input.name,
        description: input.description ?? null,
        version: 1,
        status: "active",
        enabled: true,
        revision: 1,
        policyJson: JSON.stringify(input.policy),
        ...(input.actorId ? { createdBy: input.actorId, updatedBy: input.actorId } : {}),
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      });
      if (input.items.length) {
        await transaction.insert(pgCaseSuiteItems).values(
          input.items.map((item) => ({
            id: item.id,
            suiteId: input.id,
            caseDefinitionId: item.caseDefinitionId,
            addedAt: input.createdAt,
          })),
        );
      }
      await this.insertVersionSnapshot(transaction, input.id, input.versionId, "suite.copy", {
        ...(input.actorId ? { actorId: input.actorId } : {}),
        updatedAt: input.createdAt,
      });
    });
    const suite = await this.get(input.id);
    if (!suite) throw new Error(`Case suite ${input.id} does not exist after copy.`);
    return suite;
  }

  // 在变更事务内基于最新状态写版本快照，版本号与 case_suites.version 保持一致。
  private async insertVersionSnapshot(
    transaction: PostgresSuiteTransaction,
    suiteId: string,
    versionId: string,
    changeReason: string,
    input: { actorId?: string; updatedAt: string },
  ): Promise<void> {
    const [row] = await transaction
      .select()
      .from(pgCaseSuites)
      .where(eq(pgCaseSuites.id, suiteId))
      .limit(1);
    if (!row) throw new DomainError("CASE_SUITE_NOT_FOUND", "指定的用例任务不存在。");
    const itemIds = (
      await transaction
        .select({ caseDefinitionId: pgCaseSuiteItems.caseDefinitionId })
        .from(pgCaseSuiteItems)
        .where(eq(pgCaseSuiteItems.suiteId, suiteId))
    ).map((item) => item.caseDefinitionId);
    const snapshot = buildCaseSuiteVersionSnapshot(toSuite(row, itemIds.length), itemIds);
    await transaction.insert(pgCaseSuiteVersions).values({
      id: versionId,
      suiteId,
      version: row.version,
      snapshotJson: JSON.stringify(snapshot),
      changeReason,
      ...(input.actorId ? { createdBy: input.actorId } : {}),
      createdAt: input.updatedAt,
    });
  }
}

type PostgresSuiteTransaction = Parameters<
  Parameters<PostgresDatabaseHandle["db"]["transaction"]>[0]
>[0];

async function throwPostgresSuiteConflict(
  transaction: PostgresSuiteTransaction,
  suiteId: string,
): Promise<never> {
  const [row] = await transaction
    .select({ id: pgCaseSuites.id })
    .from(pgCaseSuites)
    .where(eq(pgCaseSuites.id, suiteId))
    .limit(1);
  if (!row) throw new DomainError("CASE_SUITE_NOT_FOUND", "指定的用例任务不存在。");
  throw new DomainError("CASE_SUITE_REVISION_CONFLICT", "用例任务已被他人修改，请刷新后重试。");
}

function toSourceComparison(
  row: typeof pgCaseSourceComparisons.$inferSelect,
): CaseSourceComparison {
  return {
    id: row.id,
    projectId: row.projectId,
    ...(row.currentSourceId ? { currentSourceId: row.currentSourceId } : {}),
    candidateSourceId: row.candidateSourceId,
    added: comparisonEntries(row.addedJson),
    changed: comparisonEntries(row.changedJson),
    removed: comparisonEntries(row.removedJson),
    conflicts: comparisonEntries(row.conflictsJson),
    truncated: row.truncated,
    ...(row.createdBy ? { createdBy: row.createdBy } : {}),
    createdAt: row.createdAt,
  };
}

function comparisonEntries(json: string): CaseSourceSnapshotEntry[] {
  const parsed = safeJson(json);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is CaseSourceSnapshotEntry =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { className?: unknown }).className === "string" &&
      typeof (entry as { signature?: unknown }).signature === "string",
  );
}

function toCleanupJob(row: typeof pgCleanupJobs.$inferSelect): CleanupJob {
  return {
    id: row.id,
    category: row.category,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    ...(row.objectKey ? { objectKey: row.objectKey } : {}),
    status: row.status,
    attemptCount: row.attemptCount,
    availableAt: row.availableAt,
    ...(row.errorSummary ? { errorSummary: row.errorSummary } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function throwPostgresSourceConflict(
  executor: Pick<PostgresDatabaseHandle["db"], "select">,
  sourceId: string,
): Promise<never> {
  const [row] = await executor
    .select({ id: pgCaseSources.id })
    .from(pgCaseSources)
    .where(eq(pgCaseSources.id, sourceId))
    .limit(1);
  if (!row) throw new DomainError("CASE_SOURCE_NOT_FOUND", "指定的 JAR 来源不存在。");
  throw new DomainError("CASE_SOURCE_REVISION_CONFLICT", "该来源已被并发修改，请刷新后重试。");
}

export class PostgresRunnerRepository implements RunnerRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  private async ready(): Promise<void> {
    await this.handle.ready;
  }

  async register(record: RegisterRunnerRecord): Promise<Runner | null> {
    await this.ready();
    return this.handle.db.transaction(async (transaction) => {
      const used = await transaction
        .insert(pgRunnerBootstrapUses)
        .values({ tokenHash: record.bootstrapTokenHash, usedAt: record.recordedAt })
        .onConflictDoNothing()
        .returning({ tokenHash: pgRunnerBootstrapUses.tokenHash });
      if (used.length === 0) return null;
      const [row] = await transaction
        .insert(pgRunners)
        .values({
          id: record.id,
          credentialHash: record.credentialHash,
          credentialVersion: 1,
          name: record.name,
          disabled: false,
          draining: false,
          os: record.os,
          architecture: record.architecture,
          agentVersion: record.agentVersion,
          protocolVersion: record.protocolVersion,
          labelsJson: JSON.stringify(record.labels),
          capabilitiesJson: JSON.stringify(record.capabilities),
          maxConcurrency: record.maxConcurrency,
          busySlots: 0,
          lastSeenAt: record.recordedAt,
          terminalEnabled: record.terminalEnabled,
          createdAt: record.recordedAt,
          updatedAt: record.recordedAt,
        })
        .returning();
      if (!row) throw new Error("PostgreSQL did not return the registered runner.");
      return mapStoredRunner(row);
    });
  }

  async findByCredentialHash(credentialHash: string, now: string): Promise<Runner | null> {
    await this.ready();
    const [row] = await this.handle.db
      .select()
      .from(pgRunners)
      .where(
        or(
          eq(pgRunners.credentialHash, credentialHash),
          and(
            eq(pgRunners.previousCredentialHash, credentialHash),
            gt(pgRunners.previousCredentialValidUntil, now),
          ),
        ),
      )
      .limit(1);
    return row ? mapStoredRunner(row) : null;
  }

  async heartbeat(input: {
    runnerId: string;
    labels: string[];
    capabilities: string[];
    maxConcurrency: number;
    busySlots: number;
    agentVersion: string;
    terminalEnabled: boolean;
    resourceSnapshot?: {
      cpuUtilizationPercent: number;
      memoryUtilizationPercent: number;
      loadAverage1m: number;
      logicalCpuCount: number;
      observedAt: string;
    };
    recordedAt: string;
  }): Promise<Runner> {
    await this.ready();
    const [row] = await this.handle.db
      .update(pgRunners)
      .set({
        labelsJson: JSON.stringify(input.labels),
        capabilitiesJson: JSON.stringify(input.capabilities),
        maxConcurrency: input.maxConcurrency,
        busySlots: input.busySlots,
        agentVersion: input.agentVersion,
        terminalEnabled: input.terminalEnabled,
        ...(input.resourceSnapshot
          ? {
              cpuUtilizationPercent: input.resourceSnapshot.cpuUtilizationPercent,
              memoryUtilizationPercent: input.resourceSnapshot.memoryUtilizationPercent,
              loadAverage1m: input.resourceSnapshot.loadAverage1m,
              logicalCpuCount: input.resourceSnapshot.logicalCpuCount,
              metricsObservedAt: input.resourceSnapshot.observedAt,
            }
          : {}),
        lastSeenAt: input.recordedAt,
        updatedAt: input.recordedAt,
      })
      .where(eq(pgRunners.id, input.runnerId))
      .returning();
    if (!row) throw new Error(`Runner ${input.runnerId} does not exist.`);
    return mapStoredRunner(row);
  }

  async list(offlineBefore: string, limit: number): Promise<Runner[]> {
    await this.ready();
    return (
      await this.handle.db
        .select()
        .from(pgRunners)
        .where(isNull(pgRunners.purgedAt))
        .orderBy(desc(pgRunners.lastSeenAt))
        .limit(limit)
    ).map((row) => mapStoredRunner(row, offlineBefore));
  }

  async get(runnerId: string, offlineBefore: string): Promise<Runner | null> {
    await this.ready();
    const [row] = await this.handle.db
      .select()
      .from(pgRunners)
      .where(eq(pgRunners.id, runnerId))
      .limit(1);
    return row ? mapStoredRunner(row, offlineBefore) : null;
  }

  async setLifecycleState(input: {
    runnerId: string;
    state: "active" | "draining" | "disabled";
    updatedAt: string;
  }): Promise<Runner> {
    await this.ready();
    const [row] = await this.handle.db
      .update(pgRunners)
      .set({
        disabled: input.state === "disabled",
        draining: input.state === "draining",
        updatedAt: input.updatedAt,
      })
      .where(eq(pgRunners.id, input.runnerId))
      .returning();
    if (!row) throw new Error(`Runner ${input.runnerId} does not exist.`);
    return mapStoredRunner(row);
  }

  async rotateCredential(input: {
    runnerId: string;
    credentialHash: string;
    previousCredentialValidUntil: string;
    rotatedAt: string;
  }): Promise<Runner> {
    await this.ready();
    const [row] = await this.handle.db
      .update(pgRunners)
      .set({
        previousCredentialHash: sql`${pgRunners.credentialHash}`,
        previousCredentialValidUntil: input.previousCredentialValidUntil,
        credentialHash: input.credentialHash,
        credentialVersion: sql`${pgRunners.credentialVersion} + 1`,
        credentialRotationRequestedAt: null,
        updatedAt: input.rotatedAt,
      })
      .where(eq(pgRunners.id, input.runnerId))
      .returning();
    if (!row) throw new Error(`Runner ${input.runnerId} does not exist.`);
    return mapStoredRunner(row);
  }

  async requestCredentialRotation(input: {
    runnerId: string;
    requestedAt: string;
  }): Promise<Runner> {
    await this.ready();
    const [row] = await this.handle.db
      .update(pgRunners)
      .set({ credentialRotationRequestedAt: input.requestedAt, updatedAt: input.requestedAt })
      .where(eq(pgRunners.id, input.runnerId))
      .returning();
    if (!row) throw new Error(`Runner ${input.runnerId} does not exist.`);
    return mapStoredRunner(row);
  }

  async revokeCredential(input: { runnerId: string; revokedAt: string }): Promise<Runner> {
    await this.ready();
    const [row] = await this.handle.db
      .update(pgRunners)
      .set({
        credentialRevokedAt: input.revokedAt,
        credentialRotationRequestedAt: null,
        previousCredentialHash: null,
        previousCredentialValidUntil: null,
        updatedAt: input.revokedAt,
      })
      .where(eq(pgRunners.id, input.runnerId))
      .returning();
    if (!row) throw new Error(`Runner ${input.runnerId} does not exist.`);
    return mapStoredRunner(row);
  }

  async deregister(input: { runnerId: string; deregisteredAt: string }): Promise<Runner> {
    await this.ready();
    return this.handle.db.transaction(async (transaction) => {
      const [row] = await transaction
        .update(pgRunners)
        .set({
          deregisteredAt: input.deregisteredAt,
          credentialRotationRequestedAt: null,
          disabled: true,
          updatedAt: input.deregisteredAt,
        })
        .where(eq(pgRunners.id, input.runnerId))
        .returning();
      if (!row) throw new Error(`Runner ${input.runnerId} does not exist.`);
      // 活跃租约立即到期，由 recoverExpired 统一回收并重新排队。
      await transaction
        .update(pgAssignmentLeases)
        .set({ expiresAt: input.deregisteredAt })
        .where(
          and(
            eq(pgAssignmentLeases.runnerId, input.runnerId),
            eq(pgAssignmentLeases.status, "active"),
            gt(pgAssignmentLeases.expiresAt, input.deregisteredAt),
          ),
        );
      return mapStoredRunner(row);
    });
  }

  async purge(input: { runnerId: string; purgedAt: string }): Promise<Runner> {
    await this.ready();
    const [row] = await this.handle.db
      .update(pgRunners)
      .set({
        purgedAt: input.purgedAt,
        // credential_hash 为 NOT NULL 且有唯一约束：用按执行机唯一的哨兵值替换，
        // 保证任何真实凭据哈希都无法再匹配该记录。
        credentialHash: `purged:${input.runnerId}`,
        previousCredentialHash: null,
        previousCredentialValidUntil: null,
        credentialRotationRequestedAt: null,
        labelsJson: "[]",
        capabilitiesJson: "[]",
        updatedAt: input.purgedAt,
      })
      .where(eq(pgRunners.id, input.runnerId))
      .returning();
    if (!row) throw new Error(`Runner ${input.runnerId} does not exist.`);
    return mapStoredRunner(row);
  }
}
