import type {
  CaseCatalogRepository,
  CaseListPage,
  CaseListQuery,
  DashboardSummary,
  ExistingSource,
  ImportCatalogRecord,
} from "@autoforge/application";
import type { CaseDefinitionWithMethods, CaseSource, TestMethod } from "@autoforge/domain";
import { and, count, desc, eq, inArray, like, lt, or, type SQL } from "drizzle-orm";

import type { SqliteDatabaseHandle } from "./database";
import { caseDefinitions, caseSources, caseVersions, testMethods } from "./schema";

function stringArray(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function jsonArrayLength(json: string): number {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? parsed.length : 0;
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

export class SqliteCaseCatalogRepository implements CaseCatalogRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async findSourceBySha256(sha256: string): Promise<ExistingSource | null> {
    const row = this.handle.db
      .select({
        sourceId: caseSources.id,
        classCount: caseSources.classCount,
        methodCount: caseSources.methodCount,
      })
      .from(caseSources)
      .where(eq(caseSources.sha256, sha256))
      .get();
    return row ?? null;
  }

  async importCatalog(record: ImportCatalogRecord): Promise<void> {
    this.handle.client.transaction(() => {
      this.handle.db
        .insert(caseSources)
        .values({
          id: record.sourceId,
          displayName: record.displayName,
          originalFileName: record.inspection.fileName,
          objectKey: record.objectKey,
          sha256: record.inspection.sha256,
          sizeBytes: record.inspection.sizeBytes,
          classCount: record.inspection.testClassCount,
          methodCount: record.inspection.testMethodCount,
          status: "ready",
          warningsJson: JSON.stringify(record.inspection.warnings),
          createdAt: record.importedAt,
        })
        .run();

      for (const importedCase of record.cases) {
        const candidate = importedCase.candidate;
        this.handle.db
          .insert(caseDefinitions)
          .values({
            id: importedCase.caseDefinitionId,
            sourceId: record.sourceId,
            className: candidate.className,
            packageName: candidate.packageName,
            displayName: candidate.simpleName,
            enabled: candidate.enabled,
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
            version: 1,
            snapshotJson: JSON.stringify(candidate),
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
                return {
                  id: methodId,
                  caseDefinitionId: importedCase.caseDefinitionId,
                  methodName: method.methodName,
                  descriptor: method.descriptor,
                  enabled: method.enabled,
                  annotationSource: method.annotationSource,
                  groupsJson: JSON.stringify(method.groups),
                  description: method.description ?? null,
                  dataProvider: method.dataProvider ?? null,
                  dependsOnMethodsJson: JSON.stringify(method.dependsOnMethods),
                  dependsOnGroupsJson: JSON.stringify(method.dependsOnGroups),
                  priority: method.priority ?? null,
                  createdAt: record.importedAt,
                };
              }),
            )
            .run();
        }
      }
    })();
  }

  async listCases(query: CaseListQuery): Promise<CaseListPage> {
    const conditions: SQL[] = [];
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
        id: row.id,
        sourceId: row.sourceId,
        className: row.className,
        packageName: row.packageName,
        displayName: row.displayName,
        enabled: row.enabled,
        groups: stringArray(row.groupsJson),
        currentVersion: row.currentVersion,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
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

  async listRecentSources(limit: number): Promise<CaseSource[]> {
    return this.handle.db
      .select()
      .from(caseSources)
      .orderBy(desc(caseSources.createdAt))
      .limit(limit)
      .all()
      .map((row) => ({
        id: row.id,
        displayName: row.displayName,
        originalFileName: row.originalFileName,
        objectKey: row.objectKey,
        sha256: row.sha256,
        sizeBytes: row.sizeBytes,
        classCount: row.classCount,
        methodCount: row.methodCount,
        status: row.status,
        warningCount: jsonArrayLength(row.warningsJson),
        createdAt: row.createdAt,
      }));
  }

  async getDashboardSummary(): Promise<DashboardSummary> {
    const sourceCount =
      this.handle.db.select({ value: count() }).from(caseSources).get()?.value ?? 0;
    const caseCount =
      this.handle.db.select({ value: count() }).from(caseDefinitions).get()?.value ?? 0;
    const methodCount =
      this.handle.db.select({ value: count() }).from(testMethods).get()?.value ?? 0;
    const enabledMethodCount =
      this.handle.db
        .select({ value: count() })
        .from(testMethods)
        .where(eq(testMethods.enabled, true))
        .get()?.value ?? 0;
    return { sourceCount, caseCount, methodCount, enabledMethodCount };
  }
}
