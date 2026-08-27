import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { ExecutionControlRepository, RunBatchRepository } from "@autoforge/application";
import {
  createPostgresDatabase,
  createSqliteDatabase,
  PostgresRunBatchRepository,
  SqliteRunBatchRepository,
  type PostgresDatabaseHandle,
  type SqliteDatabaseHandle,
} from "@autoforge/db";
import { PostgresExecutionControlRepository } from "@autoforge/db/postgres";
import { createAttemptLogStore, SqliteExecutionControlRepository } from "@autoforge/db/sqlite";
import type { SchedulingEventType } from "@autoforge/domain";
import { describe, expect, it } from "vitest";

// 两个适配器的调度事件读写共享同一组契约用例：
// SQLite 使用真实临时库；PostgreSQL 仅在提供 AUTOFORGE_TEST_POSTGRES_URL 时运行
//（与 postgres-platform.integration.test.ts 的跳过方式一致）。
type SchedulingEventHarness = {
  batches: RunBatchRepository;
  executions: ExecutionControlRepository;
  batchIdA: string;
  batchIdB: string;
  runnerIdA: string;
  runnerIdB: string;
  executionRunId: string;
  attemptId: string;
  // 事件 ID 前缀按 harness 随机生成：PG 契约共享同一个数据库，
  // 固定 ID 会在用例之间主键冲突。
  eventPrefix: string;
  // 绕过仓储层直接执行 SQL，用于构造脏数据等场景。
  rawQuery(sql: string, parameters?: unknown[]): Promise<void>;
  dispose(): Promise<void>;
};

const temporaryDirectories: string[] = [];

async function cleanupTemporaryDirectories(): Promise<void> {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

async function createSqliteHarness(): Promise<SchedulingEventHarness> {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-scheduling-events-"));
  temporaryDirectories.push(directory);
  const handle: SqliteDatabaseHandle = createSqliteDatabase({
    databasePath: resolve(directory, "autoforge.sqlite"),
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
  });
  const fixture = await seedFixture((sql, parameters) =>
    Promise.resolve(handle.client.prepare(sql).run(...(parameters ?? []))),
  );
  return {
    batches: new SqliteRunBatchRepository(handle),
    executions: new SqliteExecutionControlRepository(
      handle,
      createAttemptLogStore(resolve(directory, "attempt-logs")),
    ),
    ...fixture,
    eventPrefix: randomUUID(),
    rawQuery: async (sql, parameters) => {
      handle.client.prepare(sql).run(...(parameters ?? []));
    },
    async dispose() {
      handle.close();
    },
  };
}

function schedulingEventCases(createHarness: () => Promise<SchedulingEventHarness>): void {
  it("loads a bounded detail overview and pages case rows in the database", async () => {
    const harness = await createHarness();
    const extraRunId = `${harness.eventPrefix}-case-page-run`;
    try {
      await harness.rawQuery("UPDATE run_batches SET total_runs=2 WHERE id=?", [harness.batchIdA]);
      await harness.rawQuery(
        `INSERT INTO execution_runs
           (id,batch_id,case_definition_id,case_version,display_name,class_name,status,
            attempt_count,created_at,updated_at)
         VALUES (?,?,'case-extra',1,'Another case','com.example.AnotherTest','queued',0,?,?)`,
        [extraRunId, harness.batchIdA, "2026-08-10T00:00:01.000Z", "2026-08-10T00:00:01.000Z"],
      );

      const overview = await harness.batches.getDetailOverview(harness.batchIdA);
      expect(overview).toMatchObject({
        batch: { id: harness.batchIdA, totalRuns: 2 },
        roundSummaries: [{ round: 1, totalRuns: 2, executed: 1, notExecuted: 1 }],
        finalSummary: { totalRuns: 2, notExecuted: 2 },
      });
      expect(overview).not.toHaveProperty("runs");
      expect(overview).not.toHaveProperty("attempts");

      const firstPage = await harness.batches.listCasePage({
        batchId: harness.batchIdA,
        scope: 1,
        sort: "name",
        direction: "asc",
        offset: 0,
        limit: 1,
      });
      expect(firstPage).toMatchObject({ total: 2 });
      expect(firstPage?.items).toHaveLength(1);

      const pending = await harness.batches.listCasePage({
        batchId: harness.batchIdA,
        scope: 1,
        status: "pending",
        sort: "none",
        direction: "asc",
        offset: 0,
        limit: 50,
      });
      expect(pending).toMatchObject({
        total: 1,
        items: [{ run: { id: extraRunId, displayName: "Another case" }, round: 1 }],
      });
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("reads events back in time order with payload round-trip", async () => {
    const harness = await createHarness();
    const earlyId = `${harness.eventPrefix}-early`;
    const lateId = `${harness.eventPrefix}-late`;
    try {
      await harness.batches.appendSchedulingEvents([
        {
          id: lateId,
          batchId: harness.batchIdA,
          eventType: "batch_scheduled",
          message: "第二轮调度完成：分配 1 个运行任务。",
          recordedAt: "2026-08-10T00:01:00.000Z",
        },
        {
          id: earlyId,
          batchId: harness.batchIdA,
          runnerId: harness.runnerIdA,
          executionRunId: harness.executionRunId,
          attemptId: harness.attemptId,
          eventType: "run_assigned",
          message: "运行任务已分配到执行机。",
          payload: { round: 1, score: 0.85 },
          recordedAt: "2026-08-10T00:00:00.000Z",
        },
      ]);

      const page = await harness.batches.listSchedulingEvents({
        batchId: harness.batchIdA,
        limit: 10,
      });
      expect(page.nextAfterId).toBeUndefined();
      expect(page.items).toEqual([
        {
          id: earlyId,
          batchId: harness.batchIdA,
          runnerId: harness.runnerIdA,
          executionRunId: harness.executionRunId,
          attemptId: harness.attemptId,
          eventType: "run_assigned",
          message: "运行任务已分配到执行机。",
          payload: { round: 1, score: 0.85 },
          recordedAt: "2026-08-10T00:00:00.000Z",
        },
        {
          id: lateId,
          batchId: harness.batchIdA,
          eventType: "batch_scheduled",
          message: "第二轮调度完成：分配 1 个运行任务。",
          recordedAt: "2026-08-10T00:01:00.000Z",
        },
      ]);
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("filters by runnerId and ignores events from other batches", async () => {
    const harness = await createHarness();
    const runnerAEventId = `${harness.eventPrefix}-runner-a`;
    try {
      await harness.batches.appendSchedulingEvents([
        {
          id: runnerAEventId,
          batchId: harness.batchIdA,
          runnerId: harness.runnerIdA,
          eventType: "runner_metrics",
          message: "执行机资源快照。",
          payload: { cpuUtilizationPercent: 12 },
          recordedAt: "2026-08-10T00:00:00.000Z",
        },
        {
          id: `${harness.eventPrefix}-runner-b`,
          batchId: harness.batchIdA,
          runnerId: harness.runnerIdB,
          eventType: "runner_metrics",
          message: "另一台执行机的资源快照。",
          recordedAt: "2026-08-10T00:00:30.000Z",
        },
        {
          id: `${harness.eventPrefix}-other-batch`,
          batchId: harness.batchIdB,
          runnerId: harness.runnerIdA,
          eventType: "runner_metrics",
          message: "其他批次的资源快照。",
          recordedAt: "2026-08-10T00:00:45.000Z",
        },
      ]);

      const filtered = await harness.batches.listSchedulingEvents({
        batchId: harness.batchIdA,
        runnerId: harness.runnerIdA,
        limit: 10,
      });
      expect(filtered.items.map((event) => event.id)).toEqual([runnerAEventId]);
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("pages with the afterId cursor including exact-limit and exhausted boundaries", async () => {
    const harness = await createHarness();
    const pageIds = Array.from({ length: 3 }, (_, index) => `${harness.eventPrefix}-page-${index}`);
    try {
      await harness.batches.appendSchedulingEvents(
        pageIds.map((eventId, index) => ({
          id: eventId,
          batchId: harness.batchIdA,
          eventType: "batch_scheduled" as SchedulingEventType,
          message: `调度事件 ${index}。`,
          recordedAt: `2026-08-10T00:0${index}:00.000Z`,
        })),
      );

      const firstPage = await harness.batches.listSchedulingEvents({
        batchId: harness.batchIdA,
        limit: 2,
      });
      expect(firstPage.items.map((event) => event.id)).toEqual(pageIds.slice(0, 2));
      expect(firstPage.nextAfterId).toBe(pageIds[1]);
      const cursor = firstPage.nextAfterId!;

      const secondPage = await harness.batches.listSchedulingEvents({
        batchId: harness.batchIdA,
        afterId: cursor,
        limit: 2,
      });
      expect(secondPage.items.map((event) => event.id)).toEqual([pageIds[2]]);
      expect(secondPage.nextAfterId).toBeUndefined();

      // 游标指向最后一条时返回空页。
      const lastEventId = pageIds[2]!;
      const emptyPage = await harness.batches.listSchedulingEvents({
        batchId: harness.batchIdA,
        afterId: lastEventId,
        limit: 2,
      });
      expect(emptyPage.items).toEqual([]);
      expect(emptyPage.nextAfterId).toBeUndefined();
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("reads the latest page first and walks backwards without reversing display order", async () => {
    const harness = await createHarness();
    const eventIds = Array.from(
      { length: 5 },
      (_, index) => `${harness.eventPrefix}-backward-${index}`,
    );
    try {
      await harness.batches.appendSchedulingEvents(
        eventIds.map((eventId, index) => ({
          id: eventId,
          batchId: harness.batchIdA,
          eventType: "batch_scheduled" as SchedulingEventType,
          message: `反向事件 ${index}。`,
          recordedAt: `2026-08-10T00:0${index}:00.000Z`,
        })),
      );

      const latest = await harness.batches.listSchedulingEvents({
        batchId: harness.batchIdA,
        latest: true,
        limit: 2,
      });
      expect(latest.items.map((event) => event.id)).toEqual(eventIds.slice(3));
      expect(latest.nextBeforeId).toBe(eventIds[3]);

      const previous = await harness.batches.listSchedulingEvents({
        batchId: harness.batchIdA,
        beforeId: latest.nextBeforeId!,
        limit: 2,
      });
      expect(previous.items.map((event) => event.id)).toEqual(eventIds.slice(1, 3));
      expect(previous.nextBeforeId).toBe(eventIds[1]);

      const oldest = await harness.batches.listSchedulingEvents({
        batchId: harness.batchIdA,
        beforeId: previous.nextBeforeId!,
        limit: 2,
      });
      expect(oldest.items.map((event) => event.id)).toEqual(eventIds.slice(0, 1));
      expect(oldest.nextBeforeId).toBeUndefined();
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("clamps oversized limits to the 500 cap", async () => {
    const harness = await createHarness();
    try {
      await harness.batches.appendSchedulingEvents([
        {
          id: `${harness.eventPrefix}-clamp`,
          batchId: harness.batchIdA,
          eventType: "batch_scheduled",
          message: "调度周期汇总。",
          recordedAt: "2026-08-10T00:00:00.000Z",
        },
      ]);
      const page = await harness.batches.listSchedulingEvents({
        batchId: harness.batchIdA,
        limit: 10_000,
      });
      expect(page.items).toHaveLength(1);
      expect(page.nextAfterId).toBeUndefined();
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("ignores empty appends", async () => {
    const harness = await createHarness();
    try {
      await harness.batches.appendSchedulingEvents([]);
      const page = await harness.batches.listSchedulingEvents({
        batchId: harness.batchIdA,
        limit: 10,
      });
      expect(page.items).toEqual([]);
      expect(page.nextAfterId).toBeUndefined();
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("keeps reading when a stored payload is invalid JSON", async () => {
    const harness = await createHarness();
    const validEventId = `${harness.eventPrefix}-valid`;
    const corruptedEventId = `${harness.eventPrefix}-corrupted`;
    try {
      await harness.batches.appendSchedulingEvents([
        {
          id: validEventId,
          batchId: harness.batchIdA,
          eventType: "batch_scheduled",
          message: "正常事件。",
          recordedAt: "2026-08-10T00:00:00.000Z",
        },
        {
          id: corruptedEventId,
          batchId: harness.batchIdA,
          eventType: "batch_scheduled",
          message: "损坏事件。",
          recordedAt: "2026-08-10T00:01:00.000Z",
        },
      ]);
      // 直接写入非法 JSON，模拟历史脏数据，验证读取端容错。
      await harness.rawQuery("UPDATE scheduling_events SET payload_json = ? WHERE id = ?", [
        "{not-valid-json",
        corruptedEventId,
      ]);

      const page = await harness.batches.listSchedulingEvents({
        batchId: harness.batchIdA,
        limit: 10,
      });
      expect(page.items.map((event) => event.id)).toEqual([validEventId, corruptedEventId]);
      const corrupted = page.items.find((event) => event.id === corruptedEventId);
      expect(corrupted?.payload).toBeUndefined();
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });
  it("resolves the attempt scheduling context with batch, run, runner and attempt fields", async () => {
    const harness = await createHarness();
    try {
      const context = await harness.executions.resolveAttemptSchedulingContext(harness.attemptId);
      expect(context).toEqual({
        batchId: harness.batchIdA,
        executionRunId: harness.executionRunId,
        runnerId: harness.runnerIdA,
        attemptNumber: 1,
        displayName: "FixtureTest",
      });
      // held_round 为 0 时按约定省略该字段（exactOptionalPropertyTypes）。
      expect(context).not.toHaveProperty("heldRound");
      const missing = await harness.executions.resolveAttemptSchedulingContext(
        `${harness.eventPrefix}-missing`,
      );
      expect(missing).toBeNull();
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });

  it("exposes heldRound only after the run is held for a later round", async () => {
    const harness = await createHarness();
    try {
      await harness.rawQuery("UPDATE execution_runs SET held_round = ? WHERE id = ?", [
        2,
        harness.executionRunId,
      ]);
      const context = await harness.executions.resolveAttemptSchedulingContext(harness.attemptId);
      expect(context).toMatchObject({ heldRound: 2 });
    } finally {
      await harness.dispose();
      await cleanupTemporaryDirectories();
    }
  });
}

type FixtureIds = {
  batchIdA: string;
  batchIdB: string;
  runnerIdA: string;
  runnerIdB: string;
  executionRunId: string;
  attemptId: string;
};

// fixture 需要真实的父行满足外键：runner、run_batch、execution_run、run_attempt。
// SQL 统一用 ? 占位符书写；PG 侧由 toPostgresPlaceholders 转为 $N。
async function seedFixture(
  execute: (sql: string, parameters?: unknown[]) => Promise<unknown>,
): Promise<FixtureIds> {
  const ids: FixtureIds = {
    batchIdA: randomUUID(),
    batchIdB: randomUUID(),
    runnerIdA: randomUUID(),
    runnerIdB: randomUUID(),
    executionRunId: randomUUID(),
    attemptId: randomUUID(),
  };
  const projectId = "00000000-0000-7000-8000-000000000001";
  const now = "2026-08-10T00:00:00.000Z";
  await execute(
    `INSERT INTO runners
       (id, credential_hash, name, os, architecture, agent_version, protocol_version,
        labels_json, max_concurrency, busy_slots, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, 'linux', 'amd64', '0.2.2', 1, '[]', 2, 0, ?, ?, ?)`,
    [ids.runnerIdA, `hash-${ids.runnerIdA}`, "runner-a", now, now, now],
  );
  await execute(
    `INSERT INTO runners
       (id, credential_hash, name, os, architecture, agent_version, protocol_version,
        labels_json, max_concurrency, busy_slots, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, 'linux', 'amd64', '0.2.2', 1, '[]', 2, 0, ?, ?, ?)`,
    [ids.runnerIdB, `hash-${ids.runnerIdB}`, "runner-b", now, now, now],
  );
  for (const batchId of [ids.batchIdA, ids.batchIdB]) {
    await execute(
      `INSERT INTO run_batches
         (id, suite_id, suite_name, suite_version, status, retry_limit, environment_json,
          total_runs, project_id, created_at, updated_at)
       VALUES (?, 'suite-fixture', 'Fixture Suite', 1, 'queued', 0, '[]', 1, ?, ?, ?)`,
      [batchId, projectId, now, now],
    );
  }
  await execute(
    `INSERT INTO execution_runs
       (id, batch_id, case_definition_id, case_version, display_name, class_name, status,
        attempt_count, created_at, updated_at)
     VALUES (?, ?, 'case-fixture', 1, 'FixtureTest', 'com.example.FixtureTest', 'queued', 0, ?, ?)`,
    [ids.executionRunId, ids.batchIdA, now, now],
  );
  await execute(
    `INSERT INTO run_attempts
       (id, execution_run_id, runner_id, attempt_number, status, scheduling_score, created_at)
     VALUES (?, ?, ?, 1, 'assigned', 0.85, ?)`,
    [ids.attemptId, ids.executionRunId, ids.runnerIdA, now],
  );
  return ids;
}

describe("SQLite scheduling events contract", () => {
  schedulingEventCases(createSqliteHarness);
});

const postgresConnectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;

describe.skipIf(!postgresConnectionString)("PostgreSQL scheduling events contract", () => {
  schedulingEventCases(async (): Promise<SchedulingEventHarness> => {
    const handle: PostgresDatabaseHandle = createPostgresDatabase({
      connectionString: postgresConnectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    await handle.ready;
    const fixture = await seedFixture((sql, parameters) =>
      handle.pool.query(toPostgresPlaceholders(sql), parameters ?? []).then(() => undefined),
    );
    // 日志外置后 PG 执行仓储也需要批次日志 store；测试用临时目录承载。
    const logsDirectory = await mkdtemp(resolve(tmpdir(), "autoforge-pg-scheduling-logs-"));
    const attemptLogs = createAttemptLogStore(logsDirectory);
    return {
      batches: new PostgresRunBatchRepository(handle),
      executions: new PostgresExecutionControlRepository(handle, attemptLogs),
      ...fixture,
      eventPrefix: randomUUID(),
      rawQuery: async (sql, parameters) => {
        await handle.pool.query(toPostgresPlaceholders(sql), parameters ?? []);
      },
      async dispose() {
        attemptLogs.close();
        await rm(logsDirectory, { recursive: true, force: true });
        await handle.close();
      },
    };
  });
});

// fixture 与脏数据 SQL 统一用 ? 书写；pg 驱动需要 $N，按每条语句独立编号替换。
function toPostgresPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}
