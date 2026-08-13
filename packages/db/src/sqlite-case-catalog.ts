import type {
  CaseCatalogRepository,
  CaseListPage,
  CaseListQuery,
  CaseSourceVersionMerge,
  CreateSourceComparisonRecord,
  DashboardSummary,
  ExistingSource,
  ImportCatalogRecord,
} from "@autoforge/application";
import {
  jarInspectionSchema,
  jarImportResultSchema,
  jarInspectionWarningSchema,
  type JarImportJob,
  testNgClassCandidateSchema,
  type JarInspection,
  type TestNgClassCandidate,
} from "@autoforge/contracts";
import {
  DEFAULT_PROJECT_ID,
  DomainError,
  type CaseDefinitionWithMethods,
  type CaseSource,
  type CaseSourceComparison,
  type CaseSourceSnapshotEntry,
  type CaseVersion,
  type CleanupJob,
  type TestMethod,
} from "@autoforge/domain";
import { and, count, desc, eq, inArray, like, lt, or, sql, type SQL } from "drizzle-orm";

import type { SqliteDatabaseHandle } from "./database";
import {
  caseDefinitions,
  caseImportJobs,
  caseSourceComparisons,
  caseSources,
  caseSuiteItems,
  caseVersions,
  cleanupJobs,
  executionRuns,
  testMethods,
} from "./schema";

function stringArray(json: string): string[] {
  const parsed = safeJson(json);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function stringRecord(json: string): Record<string, string> {
  const parsed = safeJson(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function jsonArrayLength(json: string): number {
  const parsed = safeJson(json);
  return Array.isArray(parsed) ? parsed.length : 0;
}

function safeJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

function toSourceComparison(row: typeof caseSourceComparisons.$inferSelect): CaseSourceComparison {
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

function toCleanupJob(row: typeof cleanupJobs.$inferSelect): CleanupJob {
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

function throwCaseSourceConflict(handle: SqliteDatabaseHandle, sourceId: string): never {
  const row = handle.db
    .select({ id: caseSources.id })
    .from(caseSources)
    .where(eq(caseSources.id, sourceId))
    .get();
  if (!row) throw new DomainError("CASE_SOURCE_NOT_FOUND", "指定的 JAR 来源不存在。");
  throw new DomainError("CASE_SOURCE_REVISION_CONFLICT", "该来源已被并发修改，请刷新后重试。");
}

function toTestMethod(row: typeof testMethods.$inferSelect): TestMethod {
  const method: TestMethod = {
    id: row.id,
    caseDefinitionId: row.caseDefinitionId,
    methodName: row.methodName,
    descriptor: row.descriptor,
    enabled: row.enabled,
    groups: stringArray(row.groupsJson),
    dependsOnMethods: stringArray(row.dependsOnMethodsJson),
    dependsOnGroups: stringArray(row.dependsOnGroupsJson),
    createdAt: row.createdAt,
  };
  if (row.description) method.description = row.description;
  if (row.dataProvider) method.dataProvider = row.dataProvider;
  if (row.priority !== null) method.priority = row.priority;
  return method;
}

function toCaseSource(row: typeof caseSources.$inferSelect): CaseSource {
  return {
    id: row.id,
    projectId: row.projectId,
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
  row: typeof caseDefinitions.$inferSelect,
): Omit<CaseDefinitionWithMethods, "methods"> {
  return {
    id: row.id,
    projectId: row.projectId,
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

function toCaseVersion(row: typeof caseVersions.$inferSelect): CaseVersion {
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

function toJarImportJob(row: typeof caseImportJobs.$inferSelect): JarImportJob {
  return {
    id: row.id,
    projectId: row.projectId,
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

export class SqliteCaseCatalogRepository implements CaseCatalogRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async createJarImportJob(record: Parameters<CaseCatalogRepository["createJarImportJob"]>[0]) {
    this.handle.client.transaction(() => {
      this.handle.client
        .prepare(
          `INSERT OR IGNORE INTO case_import_jobs
           (id, project_id, idempotency_key, file_name, object_key, sha256, size_bytes, status,
            progress_percent, requested_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.job.id,
          record.job.projectId,
          record.idempotencyKey,
          record.job.fileName,
          record.objectKey,
          record.job.sha256,
          record.job.sizeBytes,
          record.job.status,
          record.job.progressPercent,
          record.job.requestedBy ?? null,
          record.job.createdAt,
          record.job.updatedAt,
        );
      const inserted = this.handle.client.prepare("SELECT changes() AS changes").get() as {
        changes: number;
      };
      if (inserted.changes === 0) return;
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
    })();
    const row = this.handle.db
      .select()
      .from(caseImportJobs)
      .where(
        and(
          eq(caseImportJobs.projectId, record.job.projectId),
          eq(caseImportJobs.idempotencyKey, record.idempotencyKey),
        ),
      )
      .get();
    if (!row) throw new Error("JAR import job was not persisted.");
    return toJarImportJob(row);
  }

  async getJarImportJob(jobId: string, projectIds?: readonly string[]) {
    if (projectIds?.length === 0) return null;
    const row = this.handle.db
      .select()
      .from(caseImportJobs)
      .where(
        projectIds
          ? and(eq(caseImportJobs.id, jobId), inArray(caseImportJobs.projectId, [...projectIds]))
          : eq(caseImportJobs.id, jobId),
      )
      .get();
    return row ? toJarImportJob(row) : null;
  }

  async claimJarImportJob(input: Parameters<CaseCatalogRepository["claimJarImportJob"]>[0]) {
    const row = this.handle.db
      .update(caseImportJobs)
      .set({
        status: "running",
        progressPercent: 5,
        startedAt: input.startedAt,
        updatedAt: input.startedAt,
      })
      .where(
        and(
          eq(caseImportJobs.id, input.jobId),
          inArray(caseImportJobs.status, ["queued", "failed"]),
        ),
      )
      .returning()
      .get();
    return row ? { job: toJarImportJob(row), objectKey: row.objectKey } : null;
  }

  async updateJarImportJob(input: Parameters<CaseCatalogRepository["updateJarImportJob"]>[0]) {
    const row = this.handle.db
      .update(caseImportJobs)
      .set({
        status: input.status,
        progressPercent: input.progressPercent,
        resultJson: input.result ? JSON.stringify(input.result) : null,
        errorCode: input.errorCode ?? null,
        errorSummary: input.errorSummary ?? null,
        updatedAt: input.updatedAt,
        finishedAt: input.finishedAt ?? null,
      })
      .where(eq(caseImportJobs.id, input.jobId))
      .returning()
      .get();
    if (!row) throw new DomainError("JAR_IMPORT_JOB_NOT_FOUND", "指定的 JAR 导入任务不存在。");
    return toJarImportJob(row);
  }

  async requestJarImportCancellation(
    input: Parameters<CaseCatalogRepository["requestJarImportCancellation"]>[0],
  ) {
    const scope = input.projectIds
      ? inArray(caseImportJobs.projectId, [...input.projectIds])
      : undefined;
    this.handle.db
      .update(caseImportJobs)
      .set({
        status: "cancelled",
        progressPercent: 100,
        updatedAt: input.updatedAt,
        finishedAt: input.updatedAt,
      })
      .where(and(eq(caseImportJobs.id, input.jobId), eq(caseImportJobs.status, "queued"), scope))
      .run();
    this.handle.db
      .update(caseImportJobs)
      .set({ status: "cancel_requested", updatedAt: input.updatedAt })
      .where(and(eq(caseImportJobs.id, input.jobId), eq(caseImportJobs.status, "running"), scope))
      .run();
    const job = await this.getJarImportJob(input.jobId, input.projectIds);
    if (!job) throw new DomainError("JAR_IMPORT_JOB_NOT_FOUND", "指定的 JAR 导入任务不存在。");
    return job;
  }

  async retryJarImportJob(input: Parameters<CaseCatalogRepository["retryJarImportJob"]>[0]) {
    const scope = input.projectIds
      ? inArray(caseImportJobs.projectId, [...input.projectIds])
      : undefined;
    const updated = this.handle.client.transaction(() => {
      const row = this.handle.db
        .update(caseImportJobs)
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
            eq(caseImportJobs.id, input.jobId),
            inArray(caseImportJobs.status, ["failed", "cancelled"]),
            scope,
          ),
        )
        .returning()
        .get();
      if (!row) return undefined;
      this.handle.client
        .prepare(
          `INSERT INTO queue_jobs
           (message_id, run_id, attempt, schema_version, kind, payload_json, priority,
            deduplication_key, status, available_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)`,
        )
        .run(
          input.dispatchJob.messageId,
          input.dispatchJob.runId,
          input.dispatchJob.attempt,
          input.dispatchJob.schemaVersion,
          input.dispatchJob.kind,
          JSON.stringify(input.dispatchJob.payload),
          input.dispatchJob.priority,
          input.dispatchJob.deduplicationKey,
          input.dispatchJob.createdAt,
          input.dispatchJob.createdAt,
          input.dispatchJob.createdAt,
        );
      return row;
    })();
    if (!updated) throw new DomainError("JAR_IMPORT_JOB_NOT_RETRYABLE", "当前导入任务不能重试。");
    return toJarImportJob(updated);
  }

  async findSourceBySha256(
    sha256: string,
    projectId = DEFAULT_PROJECT_ID,
  ): Promise<ExistingSource | null> {
    const row = this.handle.db
      .select({
        sourceId: caseSources.id,
        classCount: caseSources.classCount,
        methodCount: caseSources.methodCount,
      })
      .from(caseSources)
      .where(and(eq(caseSources.projectId, projectId), eq(caseSources.sha256, sha256)))
      .get();
    return row ?? null;
  }

  async importCatalog(record: ImportCatalogRecord): Promise<void> {
    const projectId = record.projectId ?? DEFAULT_PROJECT_ID;
    this.handle.client.transaction(() => {
      this.handle.db
        .insert(caseSources)
        .values({
          id: record.sourceId,
          projectId,
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
        })
        .run();

      for (const importedCase of record.cases) {
        const candidate = importedCase.candidate;
        this.handle.db
          .insert(caseDefinitions)
          .values({
            id: importedCase.caseDefinitionId,
            projectId,
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
          })
          .run();
        this.handle.db
          .insert(caseVersions)
          .values({
            id: importedCase.caseVersionId,
            caseDefinitionId: importedCase.caseDefinitionId,
            sourceId: record.sourceId,
            version: 1,
            snapshotJson: JSON.stringify(candidate),
            ...(record.importedBy ? { createdBy: record.importedBy } : {}),
            changeReason: "source.import",
            createdAt: record.importedAt,
          })
          .run();

        if (importedCase.methods.length > 0) {
          this.handle.db
            .insert(testMethods)
            .values(
              importedCase.methods.map(({ methodId, methodIndex }) => {
                const method = candidate.methods[methodIndex];
                if (!method) {
                  throw new Error(`Missing imported method at index ${methodIndex}.`);
                }
                return testMethodInsertValues({
                  id: methodId,
                  caseDefinitionId: importedCase.caseDefinitionId,
                  method,
                  createdAt: record.importedAt,
                });
              }),
            )
            .run();
        }
      }
    })();
  }

  async listCases(query: CaseListQuery): Promise<CaseListPage> {
    const conditions: SQL[] = [];
    if (query.projectIds?.length === 0) return { items: [] };
    if (query.projectIds)
      conditions.push(inArray(caseDefinitions.projectId, [...query.projectIds]));
    const normalizedQuery = query.query?.trim();
    if (normalizedQuery) {
      const searchCondition = or(
        like(caseDefinitions.className, `%${normalizedQuery}%`),
        like(caseDefinitions.displayName, `%${normalizedQuery}%`),
      );
      if (searchCondition) conditions.push(searchCondition);
    }
    if (query.cursor) {
      conditions.push(lt(caseDefinitions.id, query.cursor));
    }

    const rows = this.handle.db
      .select()
      .from(caseDefinitions)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(caseDefinitions.id))
      .limit(query.limit + 1)
      .all();
    const pageRows = rows.slice(0, query.limit);
    const definitionIds = pageRows.map((row) => row.id);
    const methodRows =
      definitionIds.length === 0
        ? []
        : this.handle.db
            .select()
            .from(testMethods)
            .where(inArray(testMethods.caseDefinitionId, definitionIds))
            .all();
    const methodsByDefinition = new Map<string, TestMethod[]>();
    for (const row of methodRows) {
      const methods = methodsByDefinition.get(row.caseDefinitionId) ?? [];
      methods.push(toTestMethod(row));
      methodsByDefinition.set(row.caseDefinitionId, methods);
    }

    const result: CaseListPage = {
      items: pageRows.map((row): CaseDefinitionWithMethods => ({
        ...toCaseDefinition(row),
        methods: (methodsByDefinition.get(row.id) ?? []).sort((left, right) =>
          left.methodName.localeCompare(right.methodName),
        ),
      })),
    };
    if (rows.length > query.limit) {
      const lastItem = pageRows.at(-1);
      if (lastItem) result.nextCursor = lastItem.id;
    }
    return result;
  }

  async getCaseDefinition(
    caseDefinitionId: string,
    projectIds?: readonly string[],
  ): Promise<CaseDefinitionWithMethods | null> {
    if (projectIds?.length === 0) return null;
    const row = this.handle.db
      .select()
      .from(caseDefinitions)
      .where(
        and(
          eq(caseDefinitions.id, caseDefinitionId),
          ...(projectIds ? [inArray(caseDefinitions.projectId, [...projectIds])] : []),
        ),
      )
      .get();
    if (!row) return null;
    const methods = this.handle.db
      .select()
      .from(testMethods)
      .where(eq(testMethods.caseDefinitionId, row.id))
      .all()
      .map(toTestMethod)
      .sort((left, right) => left.methodName.localeCompare(right.methodName));
    return { ...toCaseDefinition(row), methods };
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
    const updated = this.handle.db
      .update(caseDefinitions)
      .set({
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.tags !== undefined ? { tagsJson: JSON.stringify(input.tags) } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
        revision: sql`${caseDefinitions.revision} + 1`,
        updatedBy: input.actorId,
        updatedAt: input.updatedAt,
      })
      .where(
        and(
          eq(caseDefinitions.id, input.caseDefinitionId),
          eq(caseDefinitions.revision, input.expectedRevision),
        ),
      )
      .returning()
      .get();
    if (!updated) this.throwCaseDefinitionConflict(input.caseDefinitionId);
    const definition = await this.getCaseDefinition(input.caseDefinitionId);
    if (!definition) throw new DomainError("CASE_DEFINITION_NOT_FOUND", "指定的用例不存在。");
    return definition;
  }

  async listCaseVersions(caseDefinitionId: string, limit: number): Promise<CaseVersion[]> {
    return this.handle.db
      .select()
      .from(caseVersions)
      .where(eq(caseVersions.caseDefinitionId, caseDefinitionId))
      .orderBy(desc(caseVersions.version))
      .limit(limit)
      .all()
      .map(toCaseVersion);
  }

  async getCaseVersion(caseDefinitionId: string, version: number): Promise<CaseVersion | null> {
    const row = this.handle.db
      .select()
      .from(caseVersions)
      .where(
        and(eq(caseVersions.caseDefinitionId, caseDefinitionId), eq(caseVersions.version, version)),
      )
      .get();
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
    if (input.methodIds.length !== input.snapshot.methods.length) {
      throw new Error("Restore method identifiers must match the snapshot method count.");
    }
    return this.handle.client.transaction(() => {
      const updated = this.handle.db
        .update(caseDefinitions)
        .set({
          groupsJson: JSON.stringify(input.snapshot.groups),
          parametersJson: JSON.stringify(input.snapshot.parameters ?? {}),
          enabled: input.snapshot.enabled,
          sourceId: input.sourceId,
          currentVersion: input.version,
          revision: sql`${caseDefinitions.revision} + 1`,
          updatedBy: input.actorId,
          updatedAt: input.restoredAt,
        })
        .where(
          and(
            eq(caseDefinitions.id, input.caseDefinitionId),
            eq(caseDefinitions.revision, input.expectedRevision),
          ),
        )
        .returning()
        .get();
      if (!updated) this.throwCaseDefinitionConflict(input.caseDefinitionId);
      this.handle.db
        .delete(testMethods)
        .where(eq(testMethods.caseDefinitionId, input.caseDefinitionId))
        .run();
      if (input.snapshot.methods.length > 0) {
        this.handle.db
          .insert(testMethods)
          .values(
            input.snapshot.methods.map((method, index) =>
              testMethodInsertValues({
                id: input.methodIds[index]!,
                caseDefinitionId: input.caseDefinitionId,
                method,
                createdAt: input.restoredAt,
              }),
            ),
          )
          .run();
      }
      this.handle.db
        .insert(caseVersions)
        .values({
          id: input.versionId,
          caseDefinitionId: input.caseDefinitionId,
          sourceId: input.sourceId,
          version: input.version,
          snapshotJson: JSON.stringify(input.snapshot),
          createdBy: input.actorId,
          changeReason: input.changeReason,
          createdAt: input.restoredAt,
        })
        .run();
      const row = this.handle.db
        .select()
        .from(caseDefinitions)
        .where(eq(caseDefinitions.id, input.caseDefinitionId))
        .get();
      if (!row) throw new DomainError("CASE_DEFINITION_NOT_FOUND", "指定的用例不存在。");
      const methods = this.handle.db
        .select()
        .from(testMethods)
        .where(eq(testMethods.caseDefinitionId, row.id))
        .all()
        .map(toTestMethod)
        .sort((left, right) => left.methodName.localeCompare(right.methodName));
      return { ...toCaseDefinition(row), methods };
    })();
  }

  private throwCaseDefinitionConflict(caseDefinitionId: string): never {
    const existing = this.handle.db
      .select({ id: caseDefinitions.id })
      .from(caseDefinitions)
      .where(eq(caseDefinitions.id, caseDefinitionId))
      .get();
    if (!existing) throw new DomainError("CASE_DEFINITION_NOT_FOUND", "指定的用例不存在。");
    throw new DomainError("CASE_DEFINITION_REVISION_CONFLICT", "用例已被并发修改，请刷新后重试。");
  }

  async findExistingCaseIds(caseDefinitionIds: string[], projectId?: string): Promise<string[]> {
    if (caseDefinitionIds.length === 0) return [];
    return this.handle.db
      .select({ id: caseDefinitions.id })
      .from(caseDefinitions)
      .where(
        and(
          inArray(caseDefinitions.id, caseDefinitionIds),
          ...(projectId ? [eq(caseDefinitions.projectId, projectId)] : []),
        ),
      )
      .all()
      .map((row) => row.id);
  }

  async listRecentSources(limit: number, projectIds?: readonly string[]): Promise<CaseSource[]> {
    if (projectIds?.length === 0) return [];
    return this.handle.db
      .select()
      .from(caseSources)
      .where(projectIds ? inArray(caseSources.projectId, [...projectIds]) : undefined)
      .orderBy(desc(caseSources.createdAt))
      .limit(limit)
      .all()
      .map(toCaseSource);
  }

  async listSources(limit: number, projectIds?: readonly string[]): Promise<CaseSource[]> {
    return this.listRecentSources(limit, projectIds);
  }

  async getSource(sourceId: string, projectIds?: readonly string[]) {
    if (projectIds?.length === 0) return null;
    const row = this.handle.db
      .select()
      .from(caseSources)
      .where(
        and(
          eq(caseSources.id, sourceId),
          ...(projectIds ? [inArray(caseSources.projectId, [...projectIds])] : []),
        ),
      )
      .get();
    if (!row) return null;
    const inspection = jarInspectionSchema.safeParse(safeJson(row.inspectionJson));
    return {
      source: toCaseSource(row),
      inspection: inspection.success ? inspection.data : this.reconstructLegacyInspection(row),
    };
  }

  async setAuthoritativeSource(sourceId: string, projectId?: string): Promise<CaseSource> {
    return this.handle.client.transaction(() => {
      const source = this.handle.db
        .select()
        .from(caseSources)
        .where(eq(caseSources.id, sourceId))
        .get();
      if (!source || (projectId && source.projectId !== projectId)) {
        throw new Error(`Case source ${sourceId} does not exist.`);
      }
      this.handle.db
        .update(caseSources)
        .set({ authoritative: false })
        .where(eq(caseSources.projectId, source.projectId))
        .run();
      const updated = this.handle.db
        .update(caseSources)
        .set({
          authoritative: true,
          revision: source.revision + 1,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(caseSources.id, sourceId))
        .returning()
        .get();
      if (!updated) throw new Error(`Case source ${sourceId} does not exist.`);
      return toCaseSource(updated);
    })();
  }

  async getAuthoritativeSource(projectId: string): Promise<CaseSource | null> {
    const row = this.handle.db
      .select()
      .from(caseSources)
      .where(and(eq(caseSources.projectId, projectId), eq(caseSources.authoritative, true)))
      .get();
    return row ? toCaseSource(row) : null;
  }

  async listSourceCaseSnapshots(
    sourceId: string,
  ): Promise<Array<{ caseDefinitionId: string; className: string; snapshotJson: string }>> {
    return this.handle.db
      .select({
        caseDefinitionId: caseDefinitions.id,
        className: caseDefinitions.className,
        snapshotJson: caseVersions.snapshotJson,
      })
      .from(caseDefinitions)
      .innerJoin(caseVersions, eq(caseVersions.caseDefinitionId, caseDefinitions.id))
      .where(
        and(
          eq(caseVersions.sourceId, sourceId),
          sql`${caseVersions.version} = (
            SELECT MAX(source_version.version)
            FROM case_versions source_version
            WHERE source_version.case_definition_id = ${caseVersions.caseDefinitionId}
              AND source_version.source_id = ${sourceId}
          )`,
        ),
      )
      .all();
  }

  async createSourceComparison(
    record: CreateSourceComparisonRecord,
  ): Promise<CaseSourceComparison> {
    this.handle.db
      .insert(caseSourceComparisons)
      .values({
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
      })
      .run();
    const comparison = await this.getSourceComparison(record.id);
    if (!comparison) throw new Error(`Case source comparison ${record.id} was not persisted.`);
    return comparison;
  }

  async getSourceComparison(comparisonId: string): Promise<CaseSourceComparison | null> {
    const row = this.handle.db
      .select()
      .from(caseSourceComparisons)
      .where(eq(caseSourceComparisons.id, comparisonId))
      .get();
    return row ? toSourceComparison(row) : null;
  }

  async promoteAuthoritativeSource(input: {
    sourceId: string;
    expectedRevision: number;
    updatedAt: string;
    actorId?: string;
    versionMerges?: CaseSourceVersionMerge[];
  }): Promise<CaseSource> {
    return this.handle.client.transaction(() => {
      const target = this.handle.db
        .select()
        .from(caseSources)
        .where(eq(caseSources.id, input.sourceId))
        .get();
      if (!target) throw new DomainError("CASE_SOURCE_NOT_FOUND", "指定的 JAR 来源不存在。");
      if (target.revision !== input.expectedRevision) {
        throwCaseSourceConflict(this.handle, input.sourceId);
      }
      const current = this.handle.db
        .select({ id: caseSources.id })
        .from(caseSources)
        .where(
          and(eq(caseSources.projectId, target.projectId), eq(caseSources.authoritative, true)),
        )
        .get();
      for (const merge of input.versionMerges ?? []) {
        this.mergeSourceVersion({
          merge,
          candidateSourceId: target.id,
          ...(current ? { currentSourceId: current.id } : {}),
          ...(input.actorId ? { actorId: input.actorId } : {}),
          updatedAt: input.updatedAt,
        });
      }
      this.handle.db
        .update(caseSources)
        .set({
          authoritative: false,
          revision: sql`${caseSources.revision} + 1`,
          updatedAt: input.updatedAt,
        })
        .where(
          and(eq(caseSources.projectId, target.projectId), eq(caseSources.authoritative, true)),
        )
        .run();
      const updated = this.handle.db
        .update(caseSources)
        .set({
          authoritative: true,
          revision: sql`${caseSources.revision} + 1`,
          updatedAt: input.updatedAt,
        })
        .where(
          and(eq(caseSources.id, input.sourceId), eq(caseSources.revision, input.expectedRevision)),
        )
        .returning()
        .get();
      if (!updated) throwCaseSourceConflict(this.handle, input.sourceId);
      return toCaseSource(updated);
    })();
  }

  private mergeSourceVersion(input: {
    merge: CaseSourceVersionMerge;
    candidateSourceId: string;
    currentSourceId?: string;
    actorId?: string;
    updatedAt: string;
  }): void {
    const { merge } = input;
    if (merge.methodIds.length !== merge.snapshot.methods.length) {
      throw new Error("Source sync method identifiers must match the snapshot method count.");
    }
    const currentDefinition = this.handle.db
      .select()
      .from(caseDefinitions)
      .where(eq(caseDefinitions.id, merge.currentCaseDefinitionId))
      .get();
    const candidateDefinition = this.handle.db
      .select()
      .from(caseDefinitions)
      .where(eq(caseDefinitions.id, merge.candidateCaseDefinitionId))
      .get();
    const currentSourceVersion = input.currentSourceId
      ? this.handle.db
          .select({ id: caseVersions.id })
          .from(caseVersions)
          .where(
            and(
              eq(caseVersions.caseDefinitionId, merge.currentCaseDefinitionId),
              eq(caseVersions.sourceId, input.currentSourceId),
            ),
          )
          .orderBy(desc(caseVersions.version))
          .get()
      : undefined;
    if (
      !currentDefinition ||
      !candidateDefinition ||
      !currentSourceVersion ||
      candidateDefinition.sourceId !== input.candidateSourceId ||
      currentDefinition.className !== candidateDefinition.className ||
      candidateDefinition.className !== merge.snapshot.className
    ) {
      throw new DomainError("CASE_SOURCE_SYNC_STALE", "来源用例在确认同步前已变化，请重新对比。");
    }
    const suiteReferences =
      this.handle.db
        .select({ value: count() })
        .from(caseSuiteItems)
        .where(eq(caseSuiteItems.caseDefinitionId, candidateDefinition.id))
        .get()?.value ?? 0;
    const runReferences =
      this.handle.db
        .select({ value: count() })
        .from(executionRuns)
        .where(eq(executionRuns.caseDefinitionId, candidateDefinition.id))
        .get()?.value ?? 0;
    if (suiteReferences > 0 || runReferences > 0) {
      throw new DomainError(
        "CASE_SOURCE_SYNC_CANDIDATE_IN_USE",
        `候选来源中的 ${candidateDefinition.className} 已被任务或执行引用，不能合并到现有用例。`,
      );
    }

    this.handle.db
      .delete(caseDefinitions)
      .where(eq(caseDefinitions.id, candidateDefinition.id))
      .run();
    const nextVersion = currentDefinition.currentVersion + 1;
    this.handle.db
      .update(caseDefinitions)
      .set({
        sourceId: input.candidateSourceId,
        groupsJson: JSON.stringify(merge.snapshot.groups),
        parametersJson: JSON.stringify(merge.snapshot.parameters ?? {}),
        currentVersion: nextVersion,
        revision: sql`${caseDefinitions.revision} + 1`,
        ...(input.actorId ? { updatedBy: input.actorId } : {}),
        updatedAt: input.updatedAt,
      })
      .where(eq(caseDefinitions.id, currentDefinition.id))
      .run();
    this.handle.db
      .delete(testMethods)
      .where(eq(testMethods.caseDefinitionId, currentDefinition.id))
      .run();
    if (merge.snapshot.methods.length > 0) {
      this.handle.db
        .insert(testMethods)
        .values(
          merge.snapshot.methods.map((method, index) =>
            testMethodInsertValues({
              id: merge.methodIds[index]!,
              caseDefinitionId: currentDefinition.id,
              method,
              createdAt: input.updatedAt,
            }),
          ),
        )
        .run();
    }
    this.handle.db
      .insert(caseVersions)
      .values({
        id: merge.caseVersionId,
        caseDefinitionId: currentDefinition.id,
        sourceId: input.candidateSourceId,
        version: nextVersion,
        snapshotJson: JSON.stringify(merge.snapshot),
        ...(input.actorId ? { createdBy: input.actorId } : {}),
        changeReason: "source.sync",
        createdAt: input.updatedAt,
      })
      .run();
  }

  async updateSourceLifecycle(input: {
    sourceId: string;
    expectedRevision: number;
    lifecycleStatus: "active" | "archived" | "deleting";
    updatedAt: string;
  }): Promise<CaseSource> {
    const updated = this.handle.db
      .update(caseSources)
      .set({
        lifecycleStatus: input.lifecycleStatus,
        revision: sql`${caseSources.revision} + 1`,
        updatedAt: input.updatedAt,
      })
      .where(
        and(eq(caseSources.id, input.sourceId), eq(caseSources.revision, input.expectedRevision)),
      )
      .returning()
      .get();
    if (!updated) throwCaseSourceConflict(this.handle, input.sourceId);
    return toCaseSource(updated);
  }

  async countSourceReferences(
    sourceId: string,
  ): Promise<{ caseDefinitions: number; caseVersions: number; executionRuns: number }> {
    const caseDefinitionCount =
      this.handle.db
        .select({ value: count() })
        .from(caseDefinitions)
        .where(eq(caseDefinitions.sourceId, sourceId))
        .get()?.value ?? 0;
    const caseVersionCount =
      this.handle.db
        .select({ value: count() })
        .from(caseVersions)
        .where(eq(caseVersions.sourceId, sourceId))
        .get()?.value ?? 0;
    const executionRunCount =
      this.handle.db
        .select({ value: count() })
        .from(executionRuns)
        .innerJoin(
          caseVersions,
          and(
            eq(caseVersions.caseDefinitionId, executionRuns.caseDefinitionId),
            eq(caseVersions.version, executionRuns.caseVersion),
          ),
        )
        .where(eq(caseVersions.sourceId, sourceId))
        .get()?.value ?? 0;
    return {
      caseDefinitions: caseDefinitionCount,
      caseVersions: caseVersionCount,
      executionRuns: executionRunCount,
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
    return this.handle.client.transaction(() => {
      const updated = this.handle.db
        .update(caseSources)
        .set({
          lifecycleStatus: "deleting",
          revision: sql`${caseSources.revision} + 1`,
          updatedAt: input.updatedAt,
        })
        .where(
          and(
            eq(caseSources.id, input.sourceId),
            eq(caseSources.revision, input.expectedRevision),
            eq(caseSources.authoritative, false),
          ),
        )
        .returning()
        .get();
      if (!updated) throwCaseSourceConflict(this.handle, input.sourceId);
      this.handle.db
        .insert(cleanupJobs)
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
        .onConflictDoNothing()
        .run();
      return toCaseSource(updated);
    })();
  }

  async getCleanupJob(cleanupJobId: string): Promise<CleanupJob | null> {
    const row = this.handle.db
      .select()
      .from(cleanupJobs)
      .where(eq(cleanupJobs.id, cleanupJobId))
      .get();
    return row ? toCleanupJob(row) : null;
  }

  async completeCleanupJob(input: {
    id: string;
    status: "succeeded" | "failed";
    attemptCount: number;
    errorSummary?: string;
    finishedAt: string;
  }): Promise<void> {
    this.handle.client.transaction(() => {
      const job = this.handle.db
        .select({ category: cleanupJobs.category, resourceId: cleanupJobs.resourceId })
        .from(cleanupJobs)
        .where(eq(cleanupJobs.id, input.id))
        .get();
      this.handle.db
        .update(cleanupJobs)
        .set({
          status: input.status,
          attemptCount: input.attemptCount,
          errorSummary: input.errorSummary ?? null,
          updatedAt: input.finishedAt,
        })
        .where(eq(cleanupJobs.id, input.id))
        .run();
      if (input.status === "succeeded" && job?.category === "case-source") {
        this.handle.db
          .delete(caseSources)
          .where(
            and(eq(caseSources.id, job.resourceId), eq(caseSources.lifecycleStatus, "deleting")),
          )
          .run();
      }
    })();
  }

  async getDashboardSummary(projectIds?: readonly string[]): Promise<DashboardSummary> {
    if (projectIds?.length === 0) {
      return { sourceCount: 0, caseCount: 0, methodCount: 0, enabledMethodCount: 0 };
    }
    const sourceScope = projectIds ? inArray(caseSources.projectId, [...projectIds]) : undefined;
    const caseScope = projectIds ? inArray(caseDefinitions.projectId, [...projectIds]) : undefined;
    const sourceCount =
      this.handle.db.select({ value: count() }).from(caseSources).where(sourceScope).get()?.value ??
      0;
    const caseCount =
      this.handle.db.select({ value: count() }).from(caseDefinitions).where(caseScope).get()
        ?.value ?? 0;
    const methodCount =
      this.handle.db
        .select({ value: count() })
        .from(testMethods)
        .innerJoin(caseDefinitions, eq(caseDefinitions.id, testMethods.caseDefinitionId))
        .where(caseScope)
        .get()?.value ?? 0;
    const enabledMethodCount =
      this.handle.db
        .select({ value: count() })
        .from(testMethods)
        .innerJoin(caseDefinitions, eq(caseDefinitions.id, testMethods.caseDefinitionId))
        .where(and(eq(testMethods.enabled, true), ...(caseScope ? [caseScope] : [])))
        .get()?.value ?? 0;
    return { sourceCount, caseCount, methodCount, enabledMethodCount };
  }

  private reconstructLegacyInspection(row: typeof caseSources.$inferSelect): JarInspection {
    const snapshots = this.handle.db
      .select({ snapshotJson: caseVersions.snapshotJson })
      .from(caseVersions)
      .where(eq(caseVersions.sourceId, row.id))
      .all();
    const classes = snapshots.flatMap(({ snapshotJson }) => {
      const parsed = testNgClassCandidateSchema.safeParse(safeJson(snapshotJson));
      return parsed.success ? [parsed.data] : [];
    });
    const storedWarnings = jarInspectionWarningSchema.array().safeParse(safeJson(row.warningsJson));
    return {
      schemaVersion: 1,
      fileName: row.originalFileName,
      sha256: row.sha256,
      sizeBytes: row.sizeBytes,
      classFileCount: row.classCount,
      testClassCount: row.classCount,
      testMethodCount: row.methodCount,
      hasRootTestNgXml: false,
      discoveryMode: "bytecode-annotations",
      classes,
      warnings: [
        ...(storedWarnings.success ? storedWarnings.data : []),
        {
          code: "LEGACY_INSPECTION_RECONSTRUCTED",
          message: "该来源由旧版数据库升级，预览由用例版本重建；testng.xml 状态未知。",
        },
      ],
    };
  }
}
