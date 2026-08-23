import type {
  CaseSuiteRepository,
  CopyCaseSuiteRecord,
  CreateCaseSuiteRecord,
  UpdateCaseSuiteRecord,
} from "@autoforge/application";
import {
  DEFAULT_PROJECT_ID,
  DomainError,
  buildCaseSuiteVersionSnapshot,
  defaultCaseSuiteExecutionPolicy,
  mergeCaseSuiteExecutionPolicy,
  type CaseSuiteExecutionPolicy,
  type CaseDefinitionWithMethods,
  type CaseSuite,
  type CaseSuiteDetails,
  type TestMethod,
} from "@autoforge/domain";
import { and, asc, count, desc, eq, inArray, notInArray, sql } from "drizzle-orm";

import type { SqliteDatabaseHandle } from "./database";
import {
  batchesOf,
  RELATIONAL_ID_QUERY_BATCH_SIZE,
  RELATIONAL_WRITE_BATCH_SIZE,
} from "./database-batches";
import {
  caseDefinitions,
  caseSuiteItems,
  caseSuiteRoundRecoveryCredentials,
  caseSuites,
  caseSuiteVersions,
  testMethods,
} from "./schema";

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

function policy(json: string): CaseSuiteExecutionPolicy {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? mergeCaseSuiteExecutionPolicy(defaultCaseSuiteExecutionPolicy, parsed)
      : { ...defaultCaseSuiteExecutionPolicy };
  } catch {
    return { ...defaultCaseSuiteExecutionPolicy };
  }
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
    projectId: row.projectId,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    version: row.version,
    revision: row.revision,
    status: row.status,
    enabled: row.enabled,
    policy: policy(row.policyJson),
    caseCount,
    ...(row.createdBy ? { createdBy: row.createdBy } : {}),
    ...(row.updatedBy ? { updatedBy: row.updatedBy } : {}),
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
      .returning()
      .get();
    return toSuite(row, 0);
  }

  async list(
    limit: number,
    projectIds?: readonly string[],
    projectVersionId?: string,
  ): Promise<CaseSuite[]> {
    if (projectIds?.length === 0) return [];
    const suiteRows = this.handle.db
      .select()
      .from(caseSuites)
      .where(
        and(
          ...(projectIds ? [inArray(caseSuites.projectId, [...projectIds])] : []),
          ...(projectVersionId
            ? [
                sql`json_extract(${caseSuites.policyJson}, '$.projectVersionId') = ${projectVersionId}`,
              ]
            : []),
        ),
      )
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

  async getSummary(suiteId: string, projectIds?: readonly string[]): Promise<CaseSuite | null> {
    if (projectIds?.length === 0) return null;
    const row = this.handle.db
      .select()
      .from(caseSuites)
      .where(
        and(
          eq(caseSuites.id, suiteId),
          ...(projectIds ? [inArray(caseSuites.projectId, [...projectIds])] : []),
        ),
      )
      .get();
    if (!row) return null;
    const caseCount =
      this.handle.db
        .select({ value: count() })
        .from(caseSuiteItems)
        .where(eq(caseSuiteItems.suiteId, suiteId))
        .get()?.value ?? 0;
    return toSuite(row, caseCount);
  }

  async get(suiteId: string, projectIds?: readonly string[]): Promise<CaseSuiteDetails | null> {
    if (projectIds?.length === 0) return null;
    const suiteRow = this.handle.db
      .select()
      .from(caseSuites)
      .where(
        and(
          eq(caseSuites.id, suiteId),
          ...(projectIds ? [inArray(caseSuites.projectId, [...projectIds])] : []),
        ),
      )
      .get();
    if (!suiteRow) return null;

    const itemRows = this.handle.db
      .select()
      .from(caseSuiteItems)
      .where(eq(caseSuiteItems.suiteId, suiteId))
      .orderBy(asc(caseSuiteItems.addedAt), asc(caseSuiteItems.id))
      .all();
    const definitionIds = itemRows.map((row) => row.caseDefinitionId);
    const definitionRows = batchesOf(definitionIds, RELATIONAL_ID_QUERY_BATCH_SIZE).flatMap((ids) =>
      this.handle.db.select().from(caseDefinitions).where(inArray(caseDefinitions.id, ids)).all(),
    );
    const methodRows = batchesOf(definitionIds, RELATIONAL_ID_QUERY_BATCH_SIZE).flatMap((ids) =>
      this.handle.db
        .select()
        .from(testMethods)
        .where(inArray(testMethods.caseDefinitionId, ids))
        .all(),
    );
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

  async getRoundRecoveryCredentials(
    suiteId: string,
    ruleIds: readonly string[],
  ): Promise<Record<string, string>> {
    if (ruleIds.length === 0) return {};
    const rows = batchesOf(ruleIds, RELATIONAL_ID_QUERY_BATCH_SIZE).flatMap((ids) =>
      this.handle.db
        .select()
        .from(caseSuiteRoundRecoveryCredentials)
        .where(
          and(
            eq(caseSuiteRoundRecoveryCredentials.suiteId, suiteId),
            inArray(caseSuiteRoundRecoveryCredentials.ruleId, ids),
          ),
        )
        .all(),
    );
    return Object.fromEntries(rows.map((row) => [row.ruleId, row.apiKeyCiphertext]));
  }

  async findMemberCaseDefinitionIds(
    suiteId: string,
    candidateIds: readonly string[],
  ): Promise<string[]> {
    if (candidateIds.length === 0) return [];
    return batchesOf(candidateIds, RELATIONAL_ID_QUERY_BATCH_SIZE).flatMap((ids) =>
      this.handle.db
        .select({ caseDefinitionId: caseSuiteItems.caseDefinitionId })
        .from(caseSuiteItems)
        .where(
          and(eq(caseSuiteItems.suiteId, suiteId), inArray(caseSuiteItems.caseDefinitionId, ids)),
        )
        .all()
        .map((row) => row.caseDefinitionId),
    );
  }

  async addCases(input: {
    suiteId: string;
    items: Array<{ id: string; caseDefinitionId: string }>;
    versionId: string;
    actorId?: string;
    updatedAt: string;
  }): Promise<CaseSuite> {
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
          .set({
            version: sql`${caseSuites.version} + 1`,
            revision: sql`${caseSuites.revision} + 1`,
            ...(input.actorId ? { updatedBy: input.actorId } : {}),
            updatedAt: input.updatedAt,
          })
          .where(eq(caseSuites.id, input.suiteId))
          .run();
        this.insertVersionSnapshot(input.suiteId, input.versionId, "suite.cases.add", input);
      }
    })();
    const suite = await this.getSummary(input.suiteId);
    if (!suite) throw new Error(`Case suite ${input.suiteId} does not exist.`);
    return suite;
  }

  async removeCases(input: {
    suiteId: string;
    caseDefinitionIds: string[];
    versionId: string;
    actorId?: string;
    updatedAt: string;
  }): Promise<CaseSuite> {
    this.handle.client.transaction(() => {
      let removed = 0;
      for (const ids of batchesOf(input.caseDefinitionIds, RELATIONAL_WRITE_BATCH_SIZE)) {
        removed += this.handle.db
          .delete(caseSuiteItems)
          .where(
            and(
              eq(caseSuiteItems.suiteId, input.suiteId),
              inArray(caseSuiteItems.caseDefinitionId, ids),
            ),
          )
          .run().changes;
      }
      if (removed > 0) {
        this.handle.db
          .update(caseSuites)
          .set({
            version: sql`${caseSuites.version} + 1`,
            revision: sql`${caseSuites.revision} + 1`,
            ...(input.actorId ? { updatedBy: input.actorId } : {}),
            updatedAt: input.updatedAt,
          })
          .where(eq(caseSuites.id, input.suiteId))
          .run();
        this.insertVersionSnapshot(
          input.suiteId,
          input.versionId,
          "suite.cases.remove-bulk",
          input,
        );
      }
    })();
    const suite = await this.getSummary(input.suiteId);
    if (!suite) throw new Error(`Case suite ${input.suiteId} does not exist.`);
    return suite;
  }

  async updateSuite(input: UpdateCaseSuiteRecord): Promise<CaseSuite> {
    this.handle.client.transaction(() => {
      const patch: Record<string, unknown> = {
        version: sql`${caseSuites.version} + 1`,
        revision: sql`${caseSuites.revision} + 1`,
        updatedAt: input.updatedAt,
      };
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description;
      if (input.enabled !== undefined) patch.enabled = input.enabled;
      if (input.archived !== undefined) patch.status = input.archived ? "archived" : "active";
      if (input.policy !== undefined) patch.policyJson = JSON.stringify(input.policy);
      if (input.actorId) patch.updatedBy = input.actorId;
      const result = this.handle.db
        .update(caseSuites)
        .set(patch)
        .where(
          and(eq(caseSuites.id, input.suiteId), eq(caseSuites.revision, input.expectedRevision)),
        )
        .run();
      if (result.changes !== 1) throwCaseSuiteConflict(this.handle, input.suiteId);
      for (const [ruleId, apiKeyCiphertext] of Object.entries(
        input.roundRecoveryCredentialUpserts ?? {},
      )) {
        this.handle.db
          .insert(caseSuiteRoundRecoveryCredentials)
          .values({ suiteId: input.suiteId, ruleId, apiKeyCiphertext, updatedAt: input.updatedAt })
          .onConflictDoUpdate({
            target: [
              caseSuiteRoundRecoveryCredentials.suiteId,
              caseSuiteRoundRecoveryCredentials.ruleId,
            ],
            set: { apiKeyCiphertext, updatedAt: input.updatedAt },
          })
          .run();
      }
      if (input.policy) {
        const activeRuleIds = input.policy.roundRecoveryRules.map((rule) => rule.id);
        this.handle.db
          .delete(caseSuiteRoundRecoveryCredentials)
          .where(
            activeRuleIds.length === 0
              ? eq(caseSuiteRoundRecoveryCredentials.suiteId, input.suiteId)
              : and(
                  eq(caseSuiteRoundRecoveryCredentials.suiteId, input.suiteId),
                  notInArray(caseSuiteRoundRecoveryCredentials.ruleId, activeRuleIds),
                ),
          )
          .run();
      }
      this.insertVersionSnapshot(input.suiteId, input.versionId, input.changeReason, input);
    })();
    const suite = await this.getSummary(input.suiteId);
    if (!suite) throw new Error(`Case suite ${input.suiteId} does not exist.`);
    return suite;
  }

  async copySuite(input: CopyCaseSuiteRecord): Promise<CaseSuite> {
    this.handle.client.transaction(() => {
      this.handle.db
        .insert(caseSuites)
        .values({
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
        })
        .run();
      for (const item of input.items) {
        this.handle.db
          .insert(caseSuiteItems)
          .values({
            id: item.id,
            suiteId: input.id,
            caseDefinitionId: item.caseDefinitionId,
            addedAt: input.createdAt,
          })
          .run();
      }
      for (const [ruleId, apiKeyCiphertext] of Object.entries(
        input.roundRecoveryCredentials ?? {},
      )) {
        this.handle.db
          .insert(caseSuiteRoundRecoveryCredentials)
          .values({ suiteId: input.id, ruleId, apiKeyCiphertext, updatedAt: input.createdAt })
          .run();
      }
      this.insertVersionSnapshot(input.id, input.versionId, "suite.copy", {
        ...(input.actorId ? { actorId: input.actorId } : {}),
        updatedAt: input.createdAt,
      });
    })();
    const suite = await this.getSummary(input.id);
    if (!suite) throw new Error(`Case suite ${input.id} does not exist after copy.`);
    return suite;
  }

  // 在变更事务内基于最新状态写版本快照，版本号与 case_suites.version 保持一致。
  private insertVersionSnapshot(
    suiteId: string,
    versionId: string,
    changeReason: string,
    input: { actorId?: string; updatedAt: string },
  ): void {
    const row = this.handle.db.select().from(caseSuites).where(eq(caseSuites.id, suiteId)).get();
    if (!row) throw new DomainError("CASE_SUITE_NOT_FOUND", "指定的用例任务不存在。");
    const itemIds = this.handle.db
      .select({ caseDefinitionId: caseSuiteItems.caseDefinitionId })
      .from(caseSuiteItems)
      .where(eq(caseSuiteItems.suiteId, suiteId))
      .all()
      .map((item) => item.caseDefinitionId);
    const snapshot = buildCaseSuiteVersionSnapshot(toSuite(row, itemIds.length), itemIds);
    this.handle.db
      .insert(caseSuiteVersions)
      .values({
        id: versionId,
        suiteId,
        version: row.version,
        snapshotJson: JSON.stringify(snapshot),
        changeReason,
        ...(input.actorId ? { createdBy: input.actorId } : {}),
        createdAt: input.updatedAt,
      })
      .run();
  }
}

function throwCaseSuiteConflict(handle: SqliteDatabaseHandle, suiteId: string): never {
  const row = handle.db
    .select({ id: caseSuites.id })
    .from(caseSuites)
    .where(eq(caseSuites.id, suiteId))
    .get();
  if (!row) throw new DomainError("CASE_SUITE_NOT_FOUND", "指定的用例任务不存在。");
  throw new DomainError("CASE_SUITE_REVISION_CONFLICT", "用例任务已被他人修改，请刷新后重试。");
}
