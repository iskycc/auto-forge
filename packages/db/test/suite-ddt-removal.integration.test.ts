import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CaseSuiteService,
  DdtScopeClearService,
  type CaseCatalogRepository,
} from "@autoforge/application";
import { DEFAULT_PROJECT_ID, defaultCaseSuiteExecutionPolicy } from "@autoforge/domain";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteCaseSuiteRepository } from "../src/sqlite-case-suite";
import { PostgresCaseSuiteRepository } from "../src/postgres-platform-repository";
import { SqliteDdtRepository } from "../src/sqlite-ddt";
import { PostgresDdtRepository } from "../src/postgres-ddt";
import { SqliteProjectStructureRepository } from "../src/sqlite-project-structure";
import { PostgresProjectStructureRepository } from "../src/postgres-project-structure";
import { SqlitePlatformOperationsRepository } from "../src/sqlite-platform-operations";
import { PostgresPlatformOperationsRepository } from "../src/postgres-platform-operations";
import { SqliteWebhookRepository } from "../src/sqlite-webhook";
import { PostgresWebhookRepository } from "../src/postgres-webhook";

const now = "2026-10-25T00:00:00.000Z";
for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} task removal by CaseID`,
    () => {
      it("allows one lock winner and excludes another owner's locked Rerun from bulk archiving", async () => {
        const f = await fixture(dialect);
        try {
          const suite = (await f.suites.getSummary(f.suiteId))!;
          const actors = [randomUUID(), randomUUID()];
          const results = await Promise.allSettled(
            actors.map((actorId) =>
              f.suites.setLock({
                suiteId: suite.id,
                expectedRevision: suite.revision,
                actorId,
                actorName: actorId,
                locked: true,
                updatedAt: now,
              }),
            ),
          );
          expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
          expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
          const locked = (await f.suites.getSummary(f.suiteId))!;
          await f.execute("UPDATE case_suites SET is_rerun=TRUE WHERE id=?", [suite.id]);
          const rejectedActor = actors.find((id) => id !== locked.lockedBy)!;
          const result = await f.suites.archiveReruns({
            projectId: f.scope.projectId,
            projectVersionId: f.scope.projectVersionId,
            actorId: rejectedActor,
            auditId: randomUUID(),
            requestId: "locked-archive",
            archivedAt: now,
          });
          expect(result.archivedIds).not.toContain(suite.id);
          expect((await f.suites.getSummary(suite.id))?.status).toBe("active");
        } finally {
          await f.close();
        }
      });

      it("persists owner-only task locks across member edits, archive, restore, schedules and deletion", async () => {
        const f = await fixture(dialect);
        const owner = randomUUID();
        const other = randomUUID();
        try {
          for (const id of [owner, other])
            await f.execute(
              "INSERT INTO users(id,username,normalized_username,display_name,source,status,created_at,updated_at) VALUES (?,?,?,?,'local','active',?,?)",
              [id, id, id, id, now, now],
            );
          const original = (await f.suites.getSummary(f.suiteId))!;
          const locked = await f.service.setLock(
            f.suiteId,
            { locked: true, expectedRevision: original.revision },
            { id: owner, username: "锁定操作人" },
          );
          expect(locked).toMatchObject({
            lockedBy: owner,
            lockedByName: "锁定操作人",
            lockedAt: now,
            revision: original.revision + 1,
            version: original.version,
          });
          expect(
            (await f.suites.list(20, [f.scope.projectId], f.scope.projectVersionId)).find(
              (item) => item.id === f.suiteId,
            )?.lockedBy,
          ).toBe(owner);
          for (const actorId of [other, undefined]) {
            await expect(
              f.service.update(
                f.suiteId,
                { expectedRevision: locked.revision, name: "不应修改" },
                actorId,
              ),
            ).rejects.toMatchObject({ code: "CASE_SUITE_LOCKED" });
            await expect(
              f.suites.addDdtCases({
                suiteId: f.suiteId,
                items: [],
                versionId: randomUUID(),
                updatedAt: now,
                ...(actorId ? { actorId } : {}),
              }),
            ).rejects.toMatchObject({ code: "CASE_SUITE_LOCKED" });
            await expect(
              f.suites.removeCases({
                suiteId: f.suiteId,
                caseDefinitionIds: [],
                versionId: randomUUID(),
                updatedAt: now,
                ...(actorId ? { actorId } : {}),
              }),
            ).rejects.toMatchObject({ code: "CASE_SUITE_LOCKED" });
            await expect(
              f.suites.deleteSuite({
                suiteId: f.suiteId,
                expectedRevision: locked.revision,
                ...(actorId ? { actorId } : {}),
              }),
            ).rejects.toMatchObject({ code: "CASE_SUITE_LOCKED" });
          }
          await expect(
            f.service.setLock(
              f.suiteId,
              { locked: false, expectedRevision: locked.revision },
              { id: other, username: "其他人" },
            ),
          ).rejects.toMatchObject({ code: "CASE_SUITE_LOCKED" });
          await expect(
            f.service.setLock(
              f.suiteId,
              { locked: true, expectedRevision: original.revision },
              { id: owner, username: "锁定操作人" },
            ),
          ).rejects.toMatchObject({ code: "CASE_SUITE_REVISION_CONFLICT" });
          await expect(
            f.webhooks.replaceSuiteBindings({
              suiteId: f.suiteId,
              webhookIds: [],
              recordedAt: now,
              actorId: other,
            }),
          ).rejects.toMatchObject({ code: "CASE_SUITE_LOCKED" });
          const scheduleInput = {
            id: randomUUID(),
            suiteId: f.suiteId,
            projectId: f.scope.projectId,
            cronExpression: "0 9 * * *",
            timeZone: "Asia/Shanghai",
            missedRunPolicy: "skip" as const,
            enabled: true,
            nextTriggerAt: now,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          };
          await expect(
            f.operations.upsertSchedule(scheduleInput, undefined, other),
          ).rejects.toMatchObject({ code: "CASE_SUITE_LOCKED" });
          const schedule = await f.operations.upsertSchedule(scheduleInput, undefined, owner);
          await expect(
            f.operations.deleteSchedule(schedule.id, schedule.revision, other),
          ).rejects.toMatchObject({ code: "CASE_SUITE_LOCKED" });
          const archived = await f.service.update(
            f.suiteId,
            { expectedRevision: locked.revision, archived: true },
            owner,
          );
          await expect(
            f.service.update(
              f.suiteId,
              { expectedRevision: archived.revision, archived: false },
              other,
            ),
          ).rejects.toMatchObject({ code: "CASE_SUITE_LOCKED" });
          const restored = await f.service.update(
            f.suiteId,
            { expectedRevision: archived.revision, archived: false },
            owner,
          );
          const unlocked = await f.service.setLock(
            f.suiteId,
            { locked: false, expectedRevision: restored.revision },
            { id: owner, username: "锁定操作人" },
          );
          expect(unlocked.lockedBy).toBeUndefined();
          expect(unlocked.lockedAt).toBeUndefined();
          await expect(
            f.service.update(
              f.suiteId,
              { expectedRevision: unlocked.revision, name: "已解锁可编辑" },
              other,
            ),
          ).resolves.toMatchObject({ name: "已解锁可编辑" });
        } finally {
          await f.execute("DELETE FROM users WHERE id IN (?,?)", [owner, other]);
          await f.close();
        }
      });

      it("archives ordinary tasks only after active executions finish, pauses their schedule and restores the same task", async () => {
        const f = await fixture(dialect);
        try {
          const before = (await f.suites.getSummary(f.suiteId))!;
          const members = await f.suites.get(f.suiteId);
          const history = await f.read("SELECT * FROM execution_runs WHERE batch_id=?", [
            f.batchId,
          ]);
          const schedule = await f.operations.upsertSchedule({
            id: randomUUID(),
            suiteId: f.suiteId,
            projectId: f.scope.projectId,
            cronExpression: "0 9 * * *",
            timeZone: "Asia/Shanghai",
            missedRunPolicy: "skip",
            enabled: true,
            nextTriggerAt: now,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          });
          const archive = () =>
            f.service.update(f.suiteId, { expectedRevision: before.revision, archived: true });
          for (const status of ["queued", "dispatching", "scheduled", "running"]) {
            await f.execute("UPDATE run_batches SET status=? WHERE id=?", [status, f.batchId]);
            await expect(archive()).rejects.toMatchObject({ code: "CASE_SUITE_ARCHIVE_CONFLICT" });
            expect(await f.suites.getSummary(f.suiteId)).toEqual(before);
            expect(await f.operations.findScheduleBySuite(f.suiteId)).toEqual(schedule);
          }
          await f.execute("UPDATE run_batches SET status='failed' WHERE id=?", [f.batchId]);
          const archived = await archive();
          expect(archived).toMatchObject({
            status: "archived",
            isRerun: false,
            enabled: before.enabled,
            caseCount: before.caseCount,
          });
          const pausedSchedule = await f.operations.findScheduleBySuite(f.suiteId);
          expect(pausedSchedule).toMatchObject({
            id: schedule.id,
            enabled: false,
            revision: schedule.revision + 1,
          });
          const restored = await f.service.update(f.suiteId, {
            expectedRevision: archived.revision,
            archived: false,
          });
          expect(restored).toMatchObject({
            id: before.id,
            status: "active",
            policy: before.policy,
            enabled: before.enabled,
            caseCount: before.caseCount,
          });
          expect((await f.suites.get(f.suiteId))?.ddtItems).toEqual(members?.ddtItems);
          expect(await f.operations.findScheduleBySuite(f.suiteId)).toEqual(pausedSchedule);
          expect(
            await f.read("SELECT * FROM execution_runs WHERE batch_id=?", [f.batchId]),
          ).toEqual(history);
        } finally {
          await f.close();
        }
      });
      it("rejects adding DDT members when the task is archived after selection validation begins", async () => {
        const f = await fixture(dialect);
        try {
          const before = (await f.suites.getSummary(f.suiteId))!;
          const candidate = (await f.ddt.getCase(f.scope, "NOT-MEMBER"))!;
          const getCases = f.ddt.getCases.bind(f.ddt);
          vi.spyOn(f.ddt, "getCases").mockImplementationOnce(async (...parameters) => {
            const cases = await getCases(...parameters);
            await f.suites.updateSuite({
              suiteId: f.suiteId,
              expectedRevision: before.revision,
              archived: true,
              versionId: randomUUID(),
              changeReason: "archive-during-selection",
              updatedAt: now,
            });
            return cases;
          });
          await expect(
            f.service.addDdtCases(f.suiteId, f.scope.testStageId, ["NOT-MEMBER"]),
          ).rejects.toMatchObject({ code: "CASE_SUITE_ARCHIVED" });
          expect(await f.suites.getSummary(f.suiteId)).toMatchObject({
            status: "archived",
            caseCount: before.caseCount,
            revision: before.revision + 1,
          });
          expect(await f.suites.findMemberDdtCaseIds(f.suiteId, [candidate.id])).toEqual([]);
        } finally {
          await f.close();
        }
      });
      it("keeps archived members and configuration immutable in the write transaction and allows an explicit restore", async () => {
        const f = await fixture(dialect);
        try {
          const schedule = await f.operations.upsertSchedule({
            id: randomUUID(),
            suiteId: f.suiteId,
            projectId: f.scope.projectId,
            cronExpression: "0 9 * * *",
            timeZone: "Asia/Shanghai",
            missedRunPolicy: "skip",
            enabled: false,
            nextTriggerAt: now,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          });
          const suite = (await f.suites.getSummary(f.suiteId))!;
          const archived = await f.suites.updateSuite({
            suiteId: f.suiteId,
            expectedRevision: suite.revision,
            archived: true,
            versionId: randomUUID(),
            changeReason: "archive",
            updatedAt: now,
          });
          const members = await f.suites.get(f.suiteId);
          const snapshots = await f.read(
            "SELECT id,snapshot_json FROM case_suite_versions WHERE suite_id=? ORDER BY id",
            [f.suiteId],
          );
          const mutation = { suiteId: f.suiteId, versionId: randomUUID(), updatedAt: now };
          const operations = [
            () =>
              f.suites.addDdtCases({
                ...mutation,
                items: [{ id: randomUUID(), ddtCaseId: f.keepCaseId }],
              }),
            () => f.suites.removeDdtCases({ ...mutation, ddtCaseIds: [f.keepCaseId] }),
            () => f.suites.addCases({ ...mutation, items: [] }),
            () => f.suites.removeCases({ ...mutation, caseDefinitionIds: [randomUUID()] }),
            () =>
              f.suites.updateSuite({
                ...mutation,
                expectedRevision: archived.revision,
                name: "changed",
                changeReason: "rename",
              }),
            () =>
              f.suites.updateSuite({
                ...mutation,
                expectedRevision: archived.revision,
                archived: false,
                enabled: true,
                changeReason: "restore-and-edit",
              }),
            () => f.service.addDdtCases(f.suiteId, f.scope.testStageId, ["KEEP"]),
            () => f.operations.upsertSchedule({ ...schedule, enabled: true }, schedule.revision),
            () => f.operations.deleteSchedule(schedule.id, schedule.revision),
            () =>
              f.webhooks.replaceSuiteBindings({
                suiteId: f.suiteId,
                webhookIds: [],
                recordedAt: now,
              }),
          ];
          for (const operation of operations) {
            await expect(operation()).rejects.toMatchObject({ code: "CASE_SUITE_ARCHIVED" });
          }
          expect(await f.suites.get(f.suiteId)).toEqual(members);
          expect(
            await f.read(
              "SELECT id,snapshot_json FROM case_suite_versions WHERE suite_id=? ORDER BY id",
              [f.suiteId],
            ),
          ).toEqual(snapshots);
          expect(await f.operations.findScheduleBySuite(f.suiteId)).toEqual(schedule);
          const restored = await f.suites.updateSuite({
            ...mutation,
            expectedRevision: archived.revision,
            archived: false,
            changeReason: "restore",
          });
          expect(restored.status).toBe("active");
          await f.suites.removeDdtCases({
            ...mutation,
            versionId: randomUUID(),
            ddtCaseIds: [f.keepCaseId],
          });
          expect((await f.suites.getSummary(f.suiteId))?.caseCount).toBe(2);
        } finally {
          await f.close();
        }
      });
      it("clears 8100+ scoped cases in bounded pages, unlinks tasks once, preserves snapshots and uses the case index", async () => {
        const f = await fixture(dialect);
        try {
          for (let index = 0; index < 8100; index++) {
            const caseId = `extra-${index}`;
            await f.execute(
              "INSERT INTO ddt_cases(id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,created_at,updated_at) VALUES (?,?,?,?,?,?, 'SR','sr','standard',?,?,?)",
              [
                randomUUID(),
                f.scope.projectId,
                f.scope.projectVersionId,
                f.scope.testStageId,
                caseId,
                caseId,
                JSON.stringify({ CaseID: caseId, srNum: "SR", value: index }),
                now,
                now,
              ],
            );
          }
          // Refresh synthetic bulk-load statistics before asserting the optimizer's index choice.
          await f.execute("ANALYZE ddt_cases");
          const queryPlan = await f.explainCase("extra-7999");
          expect(queryPlan).toContain("ddt_cases_scope_case_id_uq");
          await f.ddt.trashCases({
            scope: f.scope,
            caseIds: ["NOT-MEMBER"],
            recycleIds: [randomUUID()],
            deletedAt: now,
          });
          await f.execute(
            "INSERT INTO ddt_case_history(id,ddt_case_id,case_id,change_type,source_name,before_json,after_json,changes_json,created_at) VALUES (?,?,?,'edit','fixture','{}','{}','[]',?)",
            [randomUUID(), f.removedCaseId, "移除-CASE", now],
          );
          const future = "2026-10-31T00:00:00.000Z";
          await f.execute(
            "INSERT INTO ddt_cases(id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,created_at,updated_at) VALUES (?,?,?,?, 'LATER','later','SR','sr','standard','{}',?,?)",
            [
              randomUUID(),
              f.scope.projectId,
              f.scope.projectVersionId,
              f.scope.testStageId,
              future,
              future,
            ],
          );
          const beforeRuns = await f.read("SELECT * FROM execution_runs WHERE batch_id=?", [
            f.batchId,
          ]);
          const beforeVersions = await f.read(
            "SELECT id,snapshot_json FROM case_suite_versions WHERE suite_id=? ORDER BY id",
            [f.suiteId],
          );
          const before = (await f.suites.getSummary(f.suiteId))!;
          const clear = new DdtScopeClearService(
            f.ddt,
            f.suites,
            { now: () => new Date(now) },
            { next: randomUUID },
          );
          const preview = await clear.preview(f.scope);
          expect(preview).toMatchObject({
            activeCases: 8102,
            recycledCases: 1,
            suiteMembers: 3,
            affectedSuites: 2,
          });
          const totals = { members: 0, cases: 0, history: 0, recycled: 0 };
          let pages = 0;
          for (;;) {
            const page = await clear.clearPage(
              f.scope,
              { clearedBefore: preview.clearedBefore, confirmation: "清空DDT用例" },
              { principalId: "clear-test" },
              "clear-request",
            );
            totals.members += page.removedMembers;
            totals.cases += page.deletedCases;
            totals.history += page.deletedHistory;
            totals.recycled += page.deletedRecycled;
            expect(page.deletedCases).toBeLessThanOrEqual(100);
            expect(page.deletedHistory).toBeLessThanOrEqual(100);
            if (!page.hasMore) break;
            expect(++pages).toBeLessThan(100);
          }
          expect(totals).toEqual({ members: 3, cases: 8102, history: 1, recycled: 1 });
          expect((await f.suites.get(f.suiteId))?.ddtItems.map((item) => item.ddtCase.id)).toEqual([
            f.otherStageCaseId,
          ]);
          expect((await f.suites.getSummary(f.suiteId))?.version).toBe(before.version + 1);
          expect(await f.suites.getSummary(f.otherSuiteId)).toMatchObject({ caseCount: 0 });
          expect(await f.ddt.getCase(f.scope, "LATER")).not.toBeNull();
          expect(await f.ddt.getCase(f.scope, "移除-CASE")).toBeNull();
          expect(
            await f.read("SELECT * FROM execution_runs WHERE batch_id=?", [f.batchId]),
          ).toEqual(beforeRuns);
          const versionsAfter = await f.read(
            "SELECT id,snapshot_json FROM case_suite_versions WHERE suite_id=? ORDER BY id",
            [f.suiteId],
          );
          expect(
            versionsAfter.filter((row) => beforeVersions.some((old) => old.id === row.id)),
          ).toEqual(beforeVersions);
          expect(
            await clear.clearPage(
              f.scope,
              { clearedBefore: preview.clearedBefore, confirmation: "清空DDT用例" },
              { principalId: "clear-test" },
              "clear-request",
            ),
          ).toMatchObject({ phase: "done", hasMore: false, deletedCases: 0 });
        } finally {
          await f.close();
        }
      }, 120_000);
      it("removes only scoped task members, preserves case assets and execution snapshots, and retries idempotently", async () => {
        const f = await fixture(dialect);
        try {
          const selection = await f.service.matchDdtCases(
            f.suiteId,
            {
              projectVersionId: f.scope.projectVersionId,
              testStageId: f.scope.testStageId,
              caseIds: ["移除-Case", "NOT-MEMBER", "MISSING"],
            },
            [f.scope.projectId],
          );
          expect(selection).toEqual({
            items: [{ id: f.removedCaseId, caseId: "移除-CASE" }],
            unmatchedCaseIds: ["NOT-MEMBER", "MISSING"],
          });
          const before = await f.suites.getSummary(f.suiteId);
          const history = await f.read(
            "SELECT id,class_data_json,status FROM execution_runs WHERE batch_id=?",
            [f.batchId],
          );
          await f.service.removeDdtCases(
            f.suiteId,
            selection.items.map((item) => item.id),
          );
          expect((await f.suites.getSummary(f.suiteId))?.revision).toBe(before!.revision + 1);
          expect(
            (await f.suites.get(f.suiteId))?.ddtItems.map((item) => item.ddtCase.id).sort(),
          ).toEqual([f.keepCaseId, f.otherStageCaseId].sort());
          expect(
            (await f.suites.get(f.otherSuiteId))?.ddtItems.map((item) => item.ddtCase.id),
          ).toEqual([f.removedCaseId]);
          expect(await f.ddt.getCase(f.scope, "移除-CASE")).toMatchObject({
            id: f.removedCaseId,
            data: { CaseID: "移除-CASE" },
          });
          expect(
            await f.read("SELECT id,class_data_json,status FROM execution_runs WHERE batch_id=?", [
              f.batchId,
            ]),
          ).toEqual(history);
          const after = await f.suites.getSummary(f.suiteId);
          await f.service.removeDdtCases(f.suiteId, [f.removedCaseId]);
          expect((await f.suites.getSummary(f.suiteId))?.revision).toBe(after!.revision);
          expect(
            await f.service.matchDdtCases(f.suiteId, {
              projectVersionId: f.scope.projectVersionId,
              testStageId: f.scope.testStageId,
              caseIds: ["移除-CASE"],
            }),
          ).toEqual({ items: [], unmatchedCaseIds: ["移除-CASE"] });
        } finally {
          await f.close();
        }
      });
    },
  );
}

async function fixture(dialect: "sqlite" | "postgres") {
  const directory = await mkdtemp(resolve(tmpdir(), "suite-ddt-removal-"));
  const sqlite =
    dialect === "sqlite"
      ? createSqliteDatabase({
          databasePath: resolve(directory, "db.sqlite"),
          migrationsFolder: resolve("packages/db/drizzle/sqlite"),
        })
      : undefined;
  const postgres =
    dialect === "postgres"
      ? createPostgresDatabase({
          connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!,
          migrationsFolder: resolve("packages/db/drizzle/postgresql"),
        })
      : undefined;
  await postgres?.ready;
  const read = async (sql: string, values: string[] = []): Promise<Record<string, unknown>[]> => {
    if (sqlite) return sqlite.client.prepare(sql).all(...values) as Record<string, unknown>[];
    let index = 0;
    return (
      await postgres!.pool.query(
        sql.replaceAll("?", () => `$${++index}`),
        values,
      )
    ).rows as Record<string, unknown>[];
  };
  const execute = async (sql: string, values: Array<string | number> = []) => {
    if (sqlite) sqlite.client.prepare(sql).run(...values);
    else {
      let index = 0;
      await postgres!.pool.query(
        sql.replaceAll("?", () => `$${++index}`),
        values,
      );
    }
  };
  const structures = sqlite
    ? new SqliteProjectStructureRepository(sqlite)
    : new PostgresProjectStructureRepository(postgres!);
  const ddt = sqlite ? new SqliteDdtRepository(sqlite) : new PostgresDdtRepository(postgres!);
  const suites = sqlite
    ? new SqliteCaseSuiteRepository(sqlite)
    : new PostgresCaseSuiteRepository(postgres!);
  const operations = sqlite
    ? new SqlitePlatformOperationsRepository(sqlite)
    : new PostgresPlatformOperationsRepository(postgres!);
  const webhooks = sqlite
    ? new SqliteWebhookRepository(sqlite)
    : new PostgresWebhookRepository(postgres!);
  const scope = {
    projectId: DEFAULT_PROJECT_ID,
    projectVersionId: randomUUID(),
    testStageId: randomUUID(),
  };
  await structures.createVersion({
    id: scope.projectVersionId,
    projectId: scope.projectId,
    name: scope.projectVersionId,
    normalizedName: scope.projectVersionId,
    recordedAt: now,
  });
  const otherStageId = randomUUID();
  for (const stageId of [scope.testStageId, otherStageId])
    await structures.createStage({
      ...scope,
      id: stageId,
      name: stageId,
      normalizedName: stageId,
      description: "",
      recordedAt: now,
    });
  const removedCaseId = randomUUID(),
    keepCaseId = randomUUID(),
    otherStageCaseId = randomUUID();
  for (const [id, stageId, caseId] of [
    [removedCaseId, scope.testStageId, "移除-CASE"],
    [keepCaseId, scope.testStageId, "KEEP"],
    [otherStageCaseId, otherStageId, "移除-CASE"],
    [randomUUID(), scope.testStageId, "NOT-MEMBER"],
  ]) {
    await execute(
      "INSERT INTO ddt_cases (id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'standard',?,?,?)",
      [
        id!,
        scope.projectId,
        scope.projectVersionId,
        stageId!,
        caseId!,
        caseId!.toLowerCase(),
        "SR",
        "sr",
        JSON.stringify({ CaseID: caseId, srNum: "SR" }),
        now,
        now,
      ],
    );
  }
  const suiteId = randomUUID(),
    otherSuiteId = randomUUID();
  for (const id of [suiteId, otherSuiteId])
    await suites.create({
      id,
      name: id,
      projectId: scope.projectId,
      policy: { ...defaultCaseSuiteExecutionPolicy, projectVersionId: scope.projectVersionId },
      createdAt: now,
    });
  await suites.addDdtCases({
    suiteId,
    items: [removedCaseId, keepCaseId, otherStageCaseId].map((ddtCaseId) => ({
      id: randomUUID(),
      ddtCaseId,
    })),
    versionId: randomUUID(),
    updatedAt: now,
  });
  await suites.addDdtCases({
    suiteId: otherSuiteId,
    items: [{ id: randomUUID(), ddtCaseId: removedCaseId }],
    versionId: randomUUID(),
    updatedAt: now,
  });
  const batchId = randomUUID();
  await execute(
    "INSERT INTO run_batches (id,suite_id,suite_name,suite_version,status,retry_limit,environment_json,total_runs,project_id,created_at,updated_at) VALUES (?,?,?,1,'failed',0,'{}',1,?,?,?)",
    [batchId, suiteId, suiteId, scope.projectId, now, now],
  );
  await execute(
    "INSERT INTO execution_runs (id,batch_id,case_definition_id,case_version,display_name,class_name,case_type,class_data_json,status,created_at,updated_at) VALUES (?,?,?,1,?,'example.Ddt','ddt',?,'failed',?,?)",
    [
      randomUUID(),
      batchId,
      removedCaseId,
      "移除-CASE",
      JSON.stringify({ CaseID: "移除-CASE", srNum: "SR" }),
      now,
      now,
    ],
  );
  const service = new CaseSuiteService(
    suites,
    {} as CaseCatalogRepository,
    structures,
    { now: () => new Date(now) },
    { next: () => randomUUID() },
    undefined,
    ddt,
  );
  return {
    service,
    operations,
    webhooks,
    suites,
    ddt,
    scope,
    suiteId,
    otherSuiteId,
    batchId,
    read,
    execute,
    explainCase: async (caseId: string) => {
      const spy = sqlite ? vi.spyOn(sqlite.client, "prepare") : vi.spyOn(postgres!.pool, "query");
      let statement: string;
      try {
        await ddt.getCase(scope, caseId);
        statement = String(spy.mock.calls[0]![0]);
      } finally {
        spy.mockRestore();
      }
      return JSON.stringify(
        await read(`${sqlite ? "EXPLAIN QUERY PLAN" : "EXPLAIN (FORMAT JSON)"} ${statement}`, [
          scope.projectId,
          scope.projectVersionId,
          scope.testStageId,
          caseId.toLowerCase(),
        ]),
      );
    },
    removedCaseId,
    keepCaseId,
    otherStageCaseId,
    close: async () => {
      if (postgres) {
        await execute("DELETE FROM run_batches WHERE id=?", [batchId]);
        await execute("DELETE FROM case_suites WHERE id IN (?,?)", [suiteId, otherSuiteId]);
        await execute("DELETE FROM case_suite_versions WHERE suite_id IN (?,?)", [
          suiteId,
          otherSuiteId,
        ]);
        await execute("DELETE FROM audit_events WHERE details_json LIKE ?", [
          `%${scope.projectVersionId}%`,
        ]);
        await execute("DELETE FROM project_versions WHERE id=?", [scope.projectVersionId]);
      }
      sqlite?.close();
      await postgres?.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
