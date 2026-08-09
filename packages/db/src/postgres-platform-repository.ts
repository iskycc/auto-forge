import type {
  CaseCatalogRepository,
  CaseListPage,
  CaseListQuery,
  CaseSuiteRepository,
  CreateCaseSuiteRecord,
  DashboardSummary,
  ExistingSource,
  ImportCatalogRecord,
  RegisterRunnerRecord,
  RunnerRepository,
} from "@autoforge/application";
import { jarInspectionSchema } from "@autoforge/contracts";
import type {
  CaseDefinitionWithMethods,
  CaseSource,
  CaseSuite,
  CaseSuiteDetails,
  Runner,
  TestMethod,
} from "@autoforge/domain";
import { and, count, desc, eq, inArray, like, lt, or, sql, type SQL } from "drizzle-orm";

import type { PostgresDatabaseHandle } from "./postgres-database";
import {
  pgCaseDefinitions,
  pgCaseSources,
  pgCaseSuiteItems,
  pgCaseSuites,
  pgCaseVersions,
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

function toSuite(row: typeof pgCaseSuites.$inferSelect, caseCount: number): CaseSuite {
  return {
    id: row.id,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    version: row.version,
    caseCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRunner(row: typeof pgRunners.$inferSelect, offlineBefore?: string): Runner {
  return {
    id: row.id,
    name: row.name,
    state: row.disabled
      ? "disabled"
      : offlineBefore && row.lastSeenAt < offlineBefore
        ? "offline"
        : "online",
    os: row.os,
    architecture: row.architecture,
    agentVersion: row.agentVersion,
    protocolVersion: row.protocolVersion,
    labels: stringArray(row.labelsJson),
    maxConcurrency: row.maxConcurrency,
    busySlots: row.busySlots,
    lastSeenAt: row.lastSeenAt,
    terminalEnabled: row.terminalEnabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PostgresCaseCatalogRepository implements CaseCatalogRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  private async ready(): Promise<void> {
    await this.handle.ready;
  }

  async findSourceBySha256(sha256: string): Promise<ExistingSource | null> {
    await this.ready();
    const [row] = await this.handle.db
      .select({
        sourceId: pgCaseSources.id,
        classCount: pgCaseSources.classCount,
        methodCount: pgCaseSources.methodCount,
      })
      .from(pgCaseSources)
      .where(eq(pgCaseSources.sha256, sha256))
      .limit(1);
    return row ?? null;
  }

  async importCatalog(record: ImportCatalogRecord): Promise<void> {
    await this.ready();
    await this.handle.db.transaction(async (transaction) => {
      await transaction.insert(pgCaseSources).values({
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
      });
      for (const importedCase of record.cases) {
        const candidate = importedCase.candidate;
        await transaction.insert(pgCaseDefinitions).values({
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
        });
        await transaction.insert(pgCaseVersions).values({
          id: importedCase.caseVersionId,
          caseDefinitionId: importedCase.caseDefinitionId,
          version: 1,
          snapshotJson: JSON.stringify(candidate),
          createdAt: record.importedAt,
        });
        if (importedCase.methods.length > 0) {
          await transaction.insert(pgTestMethods).values(
            importedCase.methods.map(({ methodId, methodIndex }) => {
              const method = candidate.methods[methodIndex];
              if (!method) throw new Error(`Missing imported method at index ${methodIndex}.`);
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
          );
        }
      }
    });
  }

  async listCases(query: CaseListQuery): Promise<CaseListPage> {
    await this.ready();
    const conditions: SQL[] = [];
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
      methods: (methods.get(row.id) ?? []).sort((left, right) =>
        left.methodName.localeCompare(right.methodName),
      ),
    }));
    const last = pageRows.at(-1);
    return { items, ...(rows.length > query.limit && last ? { nextCursor: last.id } : {}) };
  }

  async findExistingCaseIds(caseDefinitionIds: string[]): Promise<string[]> {
    await this.ready();
    if (!caseDefinitionIds.length) return [];
    return (
      await this.handle.db
        .select({ id: pgCaseDefinitions.id })
        .from(pgCaseDefinitions)
        .where(inArray(pgCaseDefinitions.id, caseDefinitionIds))
    ).map((row) => row.id);
  }

  async listRecentSources(limit: number): Promise<CaseSource[]> {
    await this.ready();
    return (
      await this.handle.db
        .select()
        .from(pgCaseSources)
        .orderBy(desc(pgCaseSources.createdAt))
        .limit(limit)
    ).map(toSource);
  }

  async listSources(limit: number): Promise<CaseSource[]> {
    return this.listRecentSources(limit);
  }

  async getSource(sourceId: string) {
    await this.ready();
    const [row] = await this.handle.db
      .select()
      .from(pgCaseSources)
      .where(eq(pgCaseSources.id, sourceId))
      .limit(1);
    if (!row) return null;
    const inspection = jarInspectionSchema.parse(JSON.parse(row.inspectionJson));
    return { source: toSource(row), inspection };
  }

  async setAuthoritativeSource(sourceId: string): Promise<CaseSource> {
    await this.ready();
    return this.handle.db.transaction(async (transaction) => {
      await transaction.update(pgCaseSources).set({ authoritative: false });
      const [row] = await transaction
        .update(pgCaseSources)
        .set({ authoritative: true })
        .where(eq(pgCaseSources.id, sourceId))
        .returning();
      if (!row) throw new Error(`Case source ${sourceId} does not exist.`);
      return toSource(row);
    });
  }

  async getDashboardSummary(): Promise<DashboardSummary> {
    await this.ready();
    const [sources, cases, methods, enabled] = await Promise.all([
      this.handle.db.select({ value: count() }).from(pgCaseSources),
      this.handle.db.select({ value: count() }).from(pgCaseDefinitions),
      this.handle.db.select({ value: count() }).from(pgTestMethods),
      this.handle.db
        .select({ value: count() })
        .from(pgTestMethods)
        .where(eq(pgTestMethods.enabled, true)),
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
        name: record.name,
        description: record.description ?? null,
        version: 1,
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
      })
      .returning();
    if (!row) throw new Error("PostgreSQL did not return the created case suite.");
    return toSuite(row, 0);
  }

  async list(limit: number): Promise<CaseSuite[]> {
    await this.ready();
    const [rows, counts] = await Promise.all([
      this.handle.db.select().from(pgCaseSuites).orderBy(desc(pgCaseSuites.updatedAt)).limit(limit),
      this.handle.db
        .select({ suiteId: pgCaseSuiteItems.suiteId, value: count() })
        .from(pgCaseSuiteItems)
        .groupBy(pgCaseSuiteItems.suiteId),
    ]);
    const countBySuite = new Map(counts.map((row) => [row.suiteId, row.value]));
    return rows.map((row) => toSuite(row, countBySuite.get(row.id) ?? 0));
  }

  async get(suiteId: string): Promise<CaseSuiteDetails | null> {
    await this.ready();
    const [suite] = await this.handle.db
      .select()
      .from(pgCaseSuites)
      .where(eq(pgCaseSuites.id, suiteId))
      .limit(1);
    if (!suite) return null;
    const itemRows = await this.handle.db
      .select()
      .from(pgCaseSuiteItems)
      .where(eq(pgCaseSuiteItems.suiteId, suiteId))
      .orderBy(desc(pgCaseSuiteItems.addedAt));
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
          sourceId: row.sourceId,
          className: row.className,
          packageName: row.packageName,
          displayName: row.displayName,
          enabled: row.enabled,
          groups: stringArray(row.groupsJson),
          currentVersion: row.currentVersion,
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
      if (inserted.length)
        await transaction
          .update(pgCaseSuites)
          .set({ version: sql`${pgCaseSuites.version} + 1`, updatedAt: input.updatedAt })
          .where(eq(pgCaseSuites.id, input.suiteId));
    });
    const suite = await this.get(input.suiteId);
    if (!suite) throw new Error(`Case suite ${input.suiteId} does not exist.`);
    return suite;
  }

  async removeCase(input: {
    suiteId: string;
    caseDefinitionId: string;
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
      if (deleted.length)
        await transaction
          .update(pgCaseSuites)
          .set({ version: sql`${pgCaseSuites.version} + 1`, updatedAt: input.updatedAt })
          .where(eq(pgCaseSuites.id, input.suiteId));
    });
    const suite = await this.get(input.suiteId);
    if (!suite) throw new Error(`Case suite ${input.suiteId} does not exist.`);
    return suite;
  }
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
          name: record.name,
          disabled: false,
          os: record.os,
          architecture: record.architecture,
          agentVersion: record.agentVersion,
          protocolVersion: record.protocolVersion,
          labelsJson: JSON.stringify(record.labels),
          maxConcurrency: record.maxConcurrency,
          busySlots: 0,
          lastSeenAt: record.recordedAt,
          terminalEnabled: record.terminalEnabled,
          createdAt: record.recordedAt,
          updatedAt: record.recordedAt,
        })
        .returning();
      if (!row) throw new Error("PostgreSQL did not return the registered runner.");
      return toRunner(row);
    });
  }

  async findByCredentialHash(credentialHash: string): Promise<Runner | null> {
    await this.ready();
    const [row] = await this.handle.db
      .select()
      .from(pgRunners)
      .where(eq(pgRunners.credentialHash, credentialHash))
      .limit(1);
    return row ? toRunner(row) : null;
  }

  async heartbeat(input: {
    runnerId: string;
    labels: string[];
    maxConcurrency: number;
    busySlots: number;
    agentVersion: string;
    terminalEnabled: boolean;
    recordedAt: string;
  }): Promise<Runner> {
    await this.ready();
    const [row] = await this.handle.db
      .update(pgRunners)
      .set({
        labelsJson: JSON.stringify(input.labels),
        maxConcurrency: input.maxConcurrency,
        busySlots: input.busySlots,
        agentVersion: input.agentVersion,
        terminalEnabled: input.terminalEnabled,
        lastSeenAt: input.recordedAt,
        updatedAt: input.recordedAt,
      })
      .where(eq(pgRunners.id, input.runnerId))
      .returning();
    if (!row) throw new Error(`Runner ${input.runnerId} does not exist.`);
    return toRunner(row);
  }

  async list(offlineBefore: string, limit: number): Promise<Runner[]> {
    await this.ready();
    return (
      await this.handle.db.select().from(pgRunners).orderBy(desc(pgRunners.lastSeenAt)).limit(limit)
    ).map((row) => toRunner(row, offlineBefore));
  }

  async get(runnerId: string, offlineBefore: string): Promise<Runner | null> {
    await this.ready();
    const [row] = await this.handle.db
      .select()
      .from(pgRunners)
      .where(eq(pgRunners.id, runnerId))
      .limit(1);
    return row ? toRunner(row, offlineBefore) : null;
  }
}
