import type {
  CaseCatalogRepository,
  CaseListPage,
  CaseListQuery,
  DashboardSummary,
  ExistingSource,
  ImportCatalogRecord,
} from "@autoforge/application";
import {
  jarInspectionSchema,
  jarInspectionWarningSchema,
  testNgClassCandidateSchema,
  type JarInspection,
} from "@autoforge/contracts";
import type { CaseDefinitionWithMethods, CaseSource, TestMethod } from "@autoforge/domain";
import { and, count, desc, eq, inArray, like, lt, or, type SQL } from "drizzle-orm";

import type { SqliteDatabaseHandle } from "./database";
import { caseDefinitions, caseSources, caseVersions, testMethods } from "./schema";

function stringArray(json: string): string[] {
  const parsed = safeJson(json);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
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
    createdAt: row.createdAt,
  };
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
          inspectionJson: JSON.stringify(record.inspection),
          authoritative: false,
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

  async findExistingCaseIds(caseDefinitionIds: string[]): Promise<string[]> {
    if (caseDefinitionIds.length === 0) return [];
    return this.handle.db
      .select({ id: caseDefinitions.id })
      .from(caseDefinitions)
      .where(inArray(caseDefinitions.id, caseDefinitionIds))
      .all()
      .map((row) => row.id);
  }

  async listRecentSources(limit: number): Promise<CaseSource[]> {
    return this.handle.db
      .select()
      .from(caseSources)
      .orderBy(desc(caseSources.createdAt))
      .limit(limit)
      .all()
      .map(toCaseSource);
  }

  async listSources(limit: number): Promise<CaseSource[]> {
    return this.listRecentSources(limit);
  }

  async getSource(sourceId: string) {
    const row = this.handle.db.select().from(caseSources).where(eq(caseSources.id, sourceId)).get();
    if (!row) return null;
    const inspection = jarInspectionSchema.safeParse(safeJson(row.inspectionJson));
    return {
      source: toCaseSource(row),
      inspection: inspection.success ? inspection.data : this.reconstructLegacyInspection(row),
    };
  }

  async setAuthoritativeSource(sourceId: string): Promise<CaseSource> {
    return this.handle.client.transaction(() => {
      this.handle.db.update(caseSources).set({ authoritative: false }).run();
      const updated = this.handle.db
        .update(caseSources)
        .set({ authoritative: true })
        .where(eq(caseSources.id, sourceId))
        .returning()
        .get();
      if (!updated) throw new Error(`Case source ${sourceId} does not exist.`);
      return toCaseSource(updated);
    })();
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

  private reconstructLegacyInspection(row: typeof caseSources.$inferSelect): JarInspection {
    const snapshots = this.handle.db
      .select({ snapshotJson: caseVersions.snapshotJson })
      .from(caseVersions)
      .innerJoin(caseDefinitions, eq(caseVersions.caseDefinitionId, caseDefinitions.id))
      .where(eq(caseDefinitions.sourceId, row.id))
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
