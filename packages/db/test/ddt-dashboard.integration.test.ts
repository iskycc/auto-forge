import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import {
  ReadModelSnapshotService,
  ReadModelSnapshotWorker,
  readModelKey,
} from "@autoforge/application";
import type { ReadModelQuery } from "@autoforge/contracts";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteDdtRepository } from "../src/sqlite-ddt";
import { PostgresDdtRepository } from "../src/postgres-ddt";
import { SqliteReadModelSnapshotRepository } from "../src/sqlite-read-model-snapshots";
import { PostgresReadModelSnapshotRepository } from "../src/postgres-read-model-snapshots";

const generatedAt = "2026-09-18T12:00:00.000Z";

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} DDT execution dashboard`,
    () => {
      it("counts scoped DDT executions once, retains recycled cases and fills all seven UTC days", async () => {
        const database = await fixture(dialect);
        try {
          const summary = await database.repository.dashboard(database.scope, generatedAt);
          expect(summary.execution).toEqual({
            generatedAt,
            timeline: [
              { date: "2026-09-12", total: 1, passed: 1, failed: 0, cancelled: 0, pending: 0 },
              ...[13, 14, 15, 16, 17].map((day) => ({
                date: `2026-09-${day}`,
                total: 0,
                passed: 0,
                failed: 0,
                cancelled: 0,
                pending: 0,
              })),
              { date: "2026-09-18", total: 5, passed: 1, failed: 2, cancelled: 1, pending: 1 },
            ],
          });
          const empty = await database.repository.dashboard(
            { ...database.scope, testStageId: "unused" },
            generatedAt,
          );
          expect(empty.execution.timeline).toHaveLength(7);
          expect(empty.execution.timeline.every((day) => day.total === 0)).toBe(true);
          const otherVersion = await database.repository.dashboard(
            { ...database.scope, projectVersionId: "unused" },
            generatedAt,
          );
          expect(otherVersion.execution.timeline.every((day) => day.total === 0)).toBe(true);
        } finally {
          await database.close();
        }
      });
      it("serves a fixed snapshot until the background worker publishes the next generation", async () => {
        const database = await fixture(dialect);
        try {
          let currentTime = generatedAt;
          const clock = { now: () => new Date(currentTime) };
          const service = new ReadModelSnapshotService(database.snapshots, clock);
          const query: ReadModelQuery = {
            kind: "ddt_dashboard",
            ...database.scope,
            statisticsVersion: 2,
          };
          expect(readModelKey(query)).not.toBe(
            readModelKey({ kind: "ddt_dashboard", ...database.scope }),
          );
          let builds = 0;
          const worker = new ReadModelSnapshotWorker(
            database.snapshots,
            async () => {
              builds++;
              return database.repository.dashboard(database.scope, currentTime);
            },
            clock,
            { next: randomUUID },
            (error) => {
              throw error;
            },
          );
          expect((await service.read(query)).state).toBe("pending");
          expect(builds).toBe(0);
          expect(await worker.refreshOne()).toBe(true);
          const first = await service.read(query);
          expect(first.payload).toMatchObject({ execution: { generatedAt } });
          await database.execute(
            "UPDATE execution_runs SET terminal_outcome='failed',status='failed' WHERE batch_id=?",
            [database.batchIds[1]!],
          );
          expect((await service.read(query)).payload).toEqual(first.payload);
          expect(await worker.refreshOne()).toBe(false);
          expect(builds).toBe(1);
          currentTime = "2026-09-18T12:01:01.000Z";
          expect(await worker.refreshOne()).toBe(true);
          expect(builds).toBe(2);
          const next = await service.read(query);
          expect(next.generation).not.toBe(first.generation);
          expect(next.payload).toMatchObject({ execution: { generatedAt: currentTime } });
          expect(next.payload).not.toEqual(first.payload);
        } finally {
          await database.close();
        }
      });
    },
  );
}

async function fixture(dialect: "sqlite" | "postgres") {
  const directory = await mkdtemp(resolve(tmpdir(), "ddt-dashboard-"));
  const sqlite =
    dialect === "sqlite"
      ? createSqliteDatabase({
          databasePath: resolve(directory, "test.sqlite"),
          migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
        })
      : undefined;
  const postgres =
    dialect === "postgres"
      ? createPostgresDatabase({
          connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!,
          migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
        })
      : undefined;
  if (postgres) await postgres.ready;
  const suffix = randomUUID();
  const scope = {
    projectId: DEFAULT_PROJECT_ID,
    projectVersionId: `v-${suffix}`,
    testStageId: `s-${suffix}`,
  };
  const otherProjectId = `other-project-${suffix}`;
  const execute = async (sql: string, parameters: Array<string | number | null> = []) => {
    if (sqlite) sqlite.client.prepare(sql).run(...parameters);
    else {
      let index = 0;
      await postgres!.pool.query(
        sql.replaceAll("?", () => `$${++index}`),
        parameters,
      );
    }
  };
  const batchIds: string[] = [];
  const close = async () => {
    if (postgres) {
      await execute("DELETE FROM read_model_snapshots WHERE query_json LIKE ?", [
        `%${scope.projectVersionId}%`,
      ]);
      for (const id of batchIds) await execute("DELETE FROM run_batches WHERE id = ?", [id]);
      await execute("DELETE FROM project_versions WHERE id = ?", [scope.projectVersionId]);
      await execute("DELETE FROM projects WHERE id = ?", [otherProjectId]);
      await postgres.close();
    }
    sqlite?.close();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await execute(`INSERT INTO projects (id,name,slug,created_at,updated_at) VALUES (?,?,?,?,?)`, [
      otherProjectId,
      suffix,
      suffix,
      generatedAt,
      generatedAt,
    ]);
    await execute(
      `INSERT INTO project_versions (id,project_id,name,normalized_name,status,revision,created_at,updated_at)
      VALUES (?,?,?,?,'active',1,?,?)`,
      [scope.projectVersionId, scope.projectId, suffix, suffix, generatedAt, generatedAt],
    );
    for (const [position, stage] of [scope.testStageId, `other-${suffix}`].entries()) {
      await execute(
        `INSERT INTO test_stages (id,project_id,project_version_id,name,normalized_name,description,position,revision,created_at,updated_at)
        VALUES (?,?,?,?,?,'',?,1,?,?)`,
        [
          stage,
          scope.projectId,
          scope.projectVersionId,
          stage,
          stage,
          position,
          generatedAt,
          generatedAt,
        ],
      );
    }
    const insertCase = async (id: string, stage = scope.testStageId) => {
      await execute(
        `INSERT INTO ddt_cases (id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,revision,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'SR','sr','standard','{}',1,?,?)`,
        [id, scope.projectId, scope.projectVersionId, stage, id, id, generatedAt, generatedAt],
      );
    };
    const active = `active-${suffix}`;
    const recycled = `recycled-${suffix}`;
    const other = `other-case-${suffix}`;
    await insertCase(active);
    await insertCase(other, `other-${suffix}`);
    // Repeated recycle history must not multiply a single execution; restored cases
    // may also have an older recycle record in the same scope.
    for (const caseId of [recycled, recycled, active]) {
      await execute(
        `INSERT INTO ddt_deleted_cases (id,ddt_case_id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,case_created_at,case_updated_at,deleted_at)
        VALUES (?,?,?,?,?,?,?,'SR','sr','standard','{}',?,?,?)`,
        [
          randomUUID(),
          caseId,
          scope.projectId,
          scope.projectVersionId,
          scope.testStageId,
          caseId,
          caseId,
          generatedAt,
          generatedAt,
          generatedAt,
        ],
      );
    }
    const addRun = async (
      caseId: string,
      createdAt: string,
      outcome: string | null,
      options: { type?: string; kind?: string; projectId?: string } = {},
    ) => {
      const batchId = randomUUID();
      batchIds.push(batchId);
      await execute(
        `INSERT INTO run_batches (id,suite_id,suite_name,suite_version,status,retry_limit,environment_json,total_runs,project_id,batch_kind,created_at,updated_at)
        VALUES (?,'suite','Suite',1,'running',3,'{}',1,?,?,?,?)`,
        [
          batchId,
          options.projectId ?? scope.projectId,
          options.kind ?? "standard",
          createdAt,
          createdAt,
        ],
      );
      await execute(
        `INSERT INTO execution_runs (id,batch_id,case_definition_id,case_version,display_name,class_name,case_type,status,terminal_outcome,attempt_count,created_at,updated_at)
        VALUES (?,?,?,1,'DDT','test.Class',?,?,?,?,?,?)`,
        [
          randomUUID(),
          batchId,
          caseId,
          options.type ?? "ddt",
          outcome === "timed_out" ? "failed" : (outcome ?? "running"),
          outcome,
          3,
          createdAt,
          createdAt,
        ],
      );
    };
    await addRun(active, "2026-09-12T00:00:00.000Z", "succeeded");
    await addRun(active, generatedAt, "succeeded");
    await addRun(active, generatedAt, "failed");
    await addRun(recycled, generatedAt, "timed_out");
    await addRun(active, generatedAt, "cancelled");
    await addRun(active, generatedAt, null);
    await addRun(active, "2026-09-11T23:59:59.999Z", "succeeded");
    await addRun(active, "2026-09-18T12:00:00.001Z", "succeeded");
    await addRun(active, generatedAt, "succeeded", { type: "testng" });
    await addRun(active, generatedAt, "succeeded", { kind: "case_log_rerun" });
    await addRun(other, generatedAt, "succeeded");
    await addRun(active, generatedAt, "succeeded", { projectId: otherProjectId });
    return {
      scope,
      repository: sqlite ? new SqliteDdtRepository(sqlite) : new PostgresDdtRepository(postgres!),
      snapshots: sqlite
        ? new SqliteReadModelSnapshotRepository(sqlite)
        : new PostgresReadModelSnapshotRepository(postgres!),
      execute,
      batchIds,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
