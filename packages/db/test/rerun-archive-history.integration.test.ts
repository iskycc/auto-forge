import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteCaseSuiteRepository } from "../src/sqlite-case-suite";
import { PostgresCaseSuiteRepository } from "../src/postgres-platform-repository";
import { SqliteRunBatchRepository } from "../src/sqlite-run-batch";
import { PostgresRunBatchRepository } from "../src/postgres-run-batch";

const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const now = "2026-10-31T00:00:00.000Z";
for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !postgresUrl)(
    `${dialect} rerun archives and history snapshots`,
    () => {
      it("archives beyond one page, skips active executions and leaves ordinary tasks and history intact", async () => {
        await withHarness(dialect, async (h) => {
          for (let index = 0; index < 122; index++)
            await h.query(
              "INSERT INTO case_suites(id,project_id,name,version,status,enabled,revision,policy_json,created_at,updated_at,is_rerun) VALUES (?,?,?,1,'active',?,1,?,?,?,?)",
              [
                `${h.prefix}-${index}`,
                DEFAULT_PROJECT_ID,
                `Task ${index}`,
                true,
                JSON.stringify({ projectVersionId: h.version }),
                now,
                now,
                index !== 121,
              ],
            );
          await h.query(
            "INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,created_at,updated_at) VALUES (?,?,?,1,'running',0,1,'[]',?,?)",
            [h.prefix, `${h.prefix}-120`, "Active", now, now],
          );
          await h.query(
            "INSERT INTO case_suite_schedules(id,suite_id,project_id,cron_expression,time_zone,missed_run_policy,enabled,next_trigger_at,created_at,updated_at) VALUES (?,?,?,'0 * * * *','Asia/Shanghai','skip',TRUE,?,?,?)",
            [h.prefix, `${h.prefix}-0`, DEFAULT_PROJECT_ID, now, now, now],
          );
          const input = {
            projectId: DEFAULT_PROJECT_ID,
            projectVersionId: h.version,
            actorId: h.actor,
            auditId: randomUUID(),
            requestId: "archive-request",
            archivedAt: now,
          };
          const first = await h.suites.archiveReruns(input);
          expect(first).toMatchObject({ hasMore: true, skippedActive: 1 });
          expect(first.archivedIds).toHaveLength(100);
          const second = await h.suites.archiveReruns({ ...input, auditId: randomUUID() });
          expect(second).toMatchObject({ hasMore: false, skippedActive: 1 });
          expect(second.archivedIds).toHaveLength(20);
          const schedule = (await h.query(
            "SELECT enabled,revision FROM case_suite_schedules WHERE id=?",
            [h.prefix],
          )) as Array<{ enabled: boolean | number; revision: number }>;
          expect(Boolean(schedule[0]!.enabled)).toBe(false);
          expect(schedule[0]!.revision).toBe(2);
          expect(
            (await h.suites.list(200, [DEFAULT_PROJECT_ID], h.version, { status: "active" }))
              .map(({ id }) => id)
              .sort(),
          ).toEqual([`${h.prefix}-120`, `${h.prefix}-121`]);
          expect(
            await h.suites.list(200, [DEFAULT_PROJECT_ID], h.version, { status: "archived" }),
          ).toHaveLength(120);
          expect(await h.batches.getMetadata(h.prefix)).toMatchObject({ status: "running" });
          expect(await h.suites.archiveReruns({ ...input, auditId: randomUUID() })).toMatchObject({
            archivedIds: [],
            hasMore: false,
          });
          expect(
            await h.suites.archiveReruns({
              ...input,
              projectVersionId: "wrong-version",
              auditId: randomUUID(),
            }),
          ).toMatchObject({ archivedIds: [] });
        });
      });

      it("serves immutable counters without reading runs and rejects wrong scopes or obsolete batch versions", async () => {
        await withHarness(dialect, async (h) => {
          await h.query(
            "INSERT INTO run_batches(id,project_id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,created_at,updated_at) VALUES (?,?,?,?,1,'failed',0,1,'[]',?,?)",
            [h.prefix, DEFAULT_PROJECT_ID, h.prefix, "Historical", now, now],
          );
          const batch = (await h.batches.getSummary(h.prefix))!;
          await h.batches.saveHistorySnapshot(batch);
          expect(
            await h.query(
              "SELECT batch_id,batch_version FROM run_batch_history_snapshots WHERE batch_id=?",
              [batch.id],
            ),
          ).toEqual([{ batch_id: batch.id, batch_version: batch.version }]);
          const references = [{ id: batch.id, projectId: batch.projectId, version: batch.version }];
          expect(
            await h.query("SELECT id,project_id,version FROM run_batches WHERE id=?", [batch.id]),
          ).toEqual([{ id: batch.id, project_id: batch.projectId, version: batch.version }]);
          h.clearQueries();
          const saved = await h.batches.readHistorySnapshots(references);
          expect(saved).toHaveLength(1);
          expect(saved[0]).toMatchObject({
            id: batch.id,
            failedRuns: batch.failedRuns,
            succeededRuns: batch.succeededRuns,
          });
          expect(h.queries()).not.toMatch(/execution_runs|run_attempts/i);
          expect(
            await h.batches.readHistorySnapshots([
              { ...references[0]!, projectId: "wrong-project" },
            ]),
          ).toEqual([]);
          await h.query("UPDATE run_batches SET version=version+1 WHERE id=?", [batch.id]);
          expect(await h.batches.readHistorySnapshots(references)).toEqual([]);
          await h.batches.saveHistorySnapshot(batch);
          expect(
            await h.batches.readHistorySnapshots([
              { ...references[0]!, version: batch.version + 1 },
            ]),
          ).toEqual([]);
          const updated = (await h.batches.getSummary(batch.id))!;
          await h.batches.saveHistorySnapshot(updated);
          expect(
            await h.batches.readHistorySnapshots([{ ...references[0]!, version: updated.version }]),
          ).toHaveLength(1);
        });
      });
    },
  );
}

async function withHarness(
  dialect: "sqlite" | "postgres",
  test: (h: {
    prefix: string;
    version: string;
    actor: string;
    query: (statement: string, values: unknown[]) => Promise<unknown[]>;
    suites: SqliteCaseSuiteRepository | PostgresCaseSuiteRepository;
    batches: SqliteRunBatchRepository | PostgresRunBatchRepository;
    queries: () => string;
    clearQueries: () => void;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-history-"));
  const sqlite =
    dialect === "sqlite"
      ? createSqliteDatabase({
          databasePath: resolve(directory, "db.sqlite"),
          migrationsFolder: resolve("packages/db/drizzle/sqlite"),
        })
      : undefined;
  const pg = sqlite
    ? undefined
    : createPostgresDatabase({
        connectionString: postgresUrl!,
        migrationsFolder: resolve("packages/db/drizzle/postgresql"),
      });
  const prefix = randomUUID(),
    actor = randomUUID(),
    version = randomUUID();
  await pg?.ready;
  const query = async (statement: string, values: unknown[]) => {
    if (sqlite) {
      const prepared = sqlite.client.prepare(statement);
      const bindings = values.map((value) => (typeof value === "boolean" ? Number(value) : value));
      return prepared.reader ? prepared.all(...bindings) : (prepared.run(...bindings), []);
    }
    let index = 0;
    return (
      await pg!.pool.query(
        statement.replace(/\?/g, () => `$${++index}`),
        values,
      )
    ).rows;
  };
  const spy = sqlite ? vi.spyOn(sqlite.client, "prepare") : vi.spyOn(pg!.pool, "query");
  try {
    await query(
      "INSERT INTO users(id,username,normalized_username,display_name,source,status,created_at,updated_at) VALUES (?,?,?,?,'local','active',?,?)",
      [actor, actor, actor, "Archiver", now, now],
    );
    await test({
      prefix,
      actor,
      version,
      query,
      suites: sqlite ? new SqliteCaseSuiteRepository(sqlite) : new PostgresCaseSuiteRepository(pg!),
      batches: sqlite ? new SqliteRunBatchRepository(sqlite) : new PostgresRunBatchRepository(pg!),
      queries: () => spy.mock.calls.map((args) => String(args[0])).join("\n"),
      clearQueries: () => spy.mockClear(),
    });
  } finally {
    spy.mockRestore();
    if (pg) {
      await query("DELETE FROM run_batches WHERE id=?", [prefix]);
      await query("DELETE FROM case_suites WHERE policy_json LIKE ?", [`%${version}%`]);
      await query("DELETE FROM audit_events WHERE actor_id=?", [actor]);
      await query("DELETE FROM users WHERE id=?", [actor]);
      await pg.close();
    }
    sqlite?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
