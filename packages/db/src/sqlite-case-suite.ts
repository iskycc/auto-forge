import type { CaseSuiteRepository, CreateCaseSuiteRecord } from "@autoforge/application";
import type {
  CaseDefinitionWithMethods,
  CaseSuite,
  CaseSuiteDetails,
  TestMethod,
} from "@autoforge/domain";
import { count, desc, eq, inArray, sql } from "drizzle-orm";

import type { SqliteDatabaseHandle } from "./database";
import { caseDefinitions, caseSuiteItems, caseSuites, testMethods } from "./schema";

function stringArray(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function toMethod(row: typeof testMethods.$inferSelect): TestMethod {
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

function toSuite(row: typeof caseSuites.$inferSelect, caseCount: number): CaseSuite {
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

export class SqliteCaseSuiteRepository implements CaseSuiteRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async create(record: CreateCaseSuiteRecord): Promise<CaseSuite> {
    const row = this.handle.db
      .insert(caseSuites)
      .values({
        id: record.id,
        name: record.name,
        description: record.description ?? null,
        version: 1,
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
      })
      .returning()
      .get();
    return toSuite(row, 0);
  }

  async list(limit: number): Promise<CaseSuite[]> {
    const suiteRows = this.handle.db
      .select()
      .from(caseSuites)
      .orderBy(desc(caseSuites.updatedAt))
      .limit(limit)
      .all();
    const countRows = this.handle.db
      .select({ suiteId: caseSuiteItems.suiteId, value: count() })
      .from(caseSuiteItems)
      .groupBy(caseSuiteItems.suiteId)
      .all();
    const counts = new Map(countRows.map((row) => [row.suiteId, row.value]));
    return suiteRows.map((row) => toSuite(row, counts.get(row.id) ?? 0));
  }

  async get(suiteId: string): Promise<CaseSuiteDetails | null> {
    const suiteRow = this.handle.db
      .select()
      .from(caseSuites)
      .where(eq(caseSuites.id, suiteId))
      .get();
    if (!suiteRow) return null;

    const itemRows = this.handle.db
      .select()
      .from(caseSuiteItems)
      .where(eq(caseSuiteItems.suiteId, suiteId))
      .orderBy(desc(caseSuiteItems.addedAt))
      .all();
    const definitionIds = itemRows.map((row) => row.caseDefinitionId);
    const definitionRows =
      definitionIds.length === 0
        ? []
        : this.handle.db
            .select()
            .from(caseDefinitions)
            .where(inArray(caseDefinitions.id, definitionIds))
            .all();
    const methodRows =
      definitionIds.length === 0
        ? []
        : this.handle.db
            .select()
            .from(testMethods)
            .where(inArray(testMethods.caseDefinitionId, definitionIds))
            .all();
    const methods = new Map<string, TestMethod[]>();
    for (const row of methodRows) {
      const values = methods.get(row.caseDefinitionId) ?? [];
      values.push(toMethod(row));
      methods.set(row.caseDefinitionId, values);
    }
    const definitions = new Map<string, CaseDefinitionWithMethods>(
      definitionRows.map((row) => [
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
          methods: (methods.get(row.id) ?? []).sort((left, right) =>
            left.methodName.localeCompare(right.methodName),
          ),
        },
      ]),
    );

    const items = itemRows.flatMap((row) => {
      const definition = definitions.get(row.caseDefinitionId);
      return definition
        ? [{ id: row.id, suiteId: row.suiteId, caseDefinition: definition, addedAt: row.addedAt }]
        : [];
    });
    return { ...toSuite(suiteRow, items.length), items };
  }

  async addCases(input: {
    suiteId: string;
    items: Array<{ id: string; caseDefinitionId: string }>;
    updatedAt: string;
  }): Promise<CaseSuiteDetails> {
    this.handle.client.transaction(() => {
      let added = 0;
      for (const item of input.items) {
        const result = this.handle.db
          .insert(caseSuiteItems)
          .values({
            id: item.id,
            suiteId: input.suiteId,
            caseDefinitionId: item.caseDefinitionId,
            addedAt: input.updatedAt,
          })
          .onConflictDoNothing()
          .run();
        added += result.changes;
      }
      if (added > 0) {
        this.handle.db
          .update(caseSuites)
          .set({ version: sql`${caseSuites.version} + 1`, updatedAt: input.updatedAt })
          .where(eq(caseSuites.id, input.suiteId))
          .run();
      }
    })();
    const suite = await this.get(input.suiteId);
    if (!suite) throw new Error(`Case suite ${input.suiteId} does not exist.`);
    return suite;
  }

  async removeCase(input: {
    suiteId: string;
    caseDefinitionId: string;
    updatedAt: string;
  }): Promise<CaseSuiteDetails> {
    this.handle.client.transaction(() => {
      const result = this.handle.db
        .delete(caseSuiteItems)
        .where(
          sql`${caseSuiteItems.suiteId} = ${input.suiteId} AND ${caseSuiteItems.caseDefinitionId} = ${input.caseDefinitionId}`,
        )
        .run();
      if (result.changes > 0) {
        this.handle.db
          .update(caseSuites)
          .set({ version: sql`${caseSuites.version} + 1`, updatedAt: input.updatedAt })
          .where(eq(caseSuites.id, input.suiteId))
          .run();
      }
    })();
    const suite = await this.get(input.suiteId);
    if (!suite) throw new Error(`Case suite ${input.suiteId} does not exist.`);
    return suite;
  }
}
