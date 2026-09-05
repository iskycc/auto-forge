import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReadModelQuery } from "@autoforge/contracts";
import {
  ReadModelSnapshotService,
  ReadModelSnapshotWorker,
  readModelKey,
} from "@autoforge/application";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteReadModelSnapshotRepository } from "../src/sqlite-read-model-snapshots";
import { PostgresReadModelSnapshotRepository } from "../src/postgres-read-model-snapshots";

const now = "2026-09-05T00:00:00.000Z";
const later = "2026-09-05T00:01:00.000Z";
const projectId = "00000000-0000-7000-8000-000000000001";

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} background read model snapshots`,
    () => {
      it("upgrades an existing schema transactionally and recovers from a failed migration", async () => {
        const harness = await database(dialect);
        try {
          await harness.execute(
            "DROP TABLE read_model_snapshot_parts; DROP TABLE read_model_snapshots; DROP INDEX case_definitions_snapshot_page_idx;",
          );
          const migration = await readFile(
            resolve(
              import.meta.dirname,
              `../drizzle/${dialect === "sqlite" ? "sqlite/0064" : "postgresql/0063"}_read_model_snapshots.sql`,
            ),
            "utf8",
          );
          await harness.execute("BEGIN");
          await harness.execute(migration);
          await expect(
            harness.execute("SELECT * FROM intentionally_missing_migration_table"),
          ).rejects.toThrow();
          await harness.execute("ROLLBACK");
          await expect(harness.repository.get("missing")).rejects.toThrow();
          await harness.execute("BEGIN");
          await harness.execute(migration);
          await harness.execute("COMMIT");
          const query: ReadModelQuery = {
            kind: "dashboard",
            projectId,
            projectVersionId: "preserved-project",
            timeZone: "UTC",
          };
          expect(await harness.repository.request(readModelKey(query), query, now)).toMatchObject({
            payload: null,
          });
        } finally {
          await harness.close();
        }
      });

      it("upgrades bounded page indexes and rolls back an interrupted index migration", async () => {
        const harness = await database(dialect);
        try {
          const indexes = [
            "case_suite_items_member_page_idx",
            "case_suite_ddt_items_member_page_idx",
            "case_sources_object_page_idx",
            "case_suite_items_definition_idx",
            "ddt_deleted_cases_execution_class_idx",
          ];
          await harness.execute(indexes.map((index) => `DROP INDEX ${index}`).join(";"));
          const migration =
            (await readFile(
              resolve(
                import.meta.dirname,
                `../drizzle/${dialect === "sqlite" ? "sqlite/0065" : "postgresql/0064"}_bounded_page_indexes.sql`,
              ),
              "utf8",
            )) +
            (await readFile(
              resolve(
                import.meta.dirname,
                `../drizzle/${dialect === "sqlite" ? "sqlite/0066" : "postgresql/0065"}_case_reference_indexes.sql`,
              ),
              "utf8",
            ));
          await harness.execute("BEGIN");
          await harness.execute(migration);
          await expect(
            harness.execute("SELECT * FROM interrupted_page_index_upgrade"),
          ).rejects.toThrow();
          await harness.execute("ROLLBACK");
          await harness.execute("BEGIN");
          await harness.execute(migration);
          await harness.execute("COMMIT");
          // A second creation would succeed if the first publication had been lost.
          await expect(harness.execute(migration)).rejects.toThrow();
          await harness.execute("SELECT id FROM projects");
        } finally {
          await harness.close();
        }
      });

      it("never computes on read, persists warm results and preserves stale data during refresh", async () => {
        const harness = await database(dialect);
        const query: ReadModelQuery = {
          kind: "case_directory",
          projectId,
          projectVersionId: randomUUID(),
          testStageId: "stage",
        };
        let builds = 0;
        let currentTime = now;
        const clock = { now: () => new Date(currentTime) };
        const service = new ReadModelSnapshotService(harness.repository, clock);
        const errors: unknown[] = [];
        const worker = new ReadModelSnapshotWorker(
          harness.repository,
          async () => {
            builds += 1;
            return { caseCount: 100_000, partCount: 400 };
          },
          clock,
          { next: randomUUID },
          (error) => errors.push(error),
        );
        try {
          expect(await service.read(query)).toMatchObject({ state: "pending", payload: null });
          expect(builds).toBe(0);
          expect(await worker.refreshOne()).toBe(true);
          for (let index = 0; index < 5; index++)
            expect(await service.read(query)).toMatchObject({
              state: "ready",
              payload: { caseCount: 100_000 },
            });
          expect(builds).toBe(1);
          currentTime = later;
          expect(await service.read(query)).toMatchObject({
            state: "stale",
            payload: { caseCount: 100_000 },
          });
          expect(builds).toBe(1);
          expect(errors).toEqual([]);
        } finally {
          await harness.close();
        }
      });

      it("discards a concurrent edit without reporting a failed snapshot", async () => {
        const harness = await database(dialect);
        const query: ReadModelQuery = {
          kind: "case_directory",
          projectId,
          projectVersionId: "version",
          testStageId: "stage",
        };
        const clock = { now: () => new Date(now) };
        const errors: unknown[] = [];
        const service = new ReadModelSnapshotService(harness.repository, clock);
        const worker = new ReadModelSnapshotWorker(
          harness.repository,
          async (_query, writePart) => {
            await service.invalidate(projectId);
            await writePart(0, { items: [] });
            return {};
          },
          clock,
          { next: randomUUID },
          (error) => errors.push(error),
        );
        try {
          await service.read(query);
          await worker.refreshOne();
          expect(await service.read(query)).toMatchObject({ state: "pending", generation: null });
          expect(errors).toEqual([]);
        } finally {
          await harness.close();
        }
      });

      it("deduplicates concurrent refreshes and rejects an owner invalidated during a build", async () => {
        const harness = await database(dialect);
        const query: ReadModelQuery = {
          kind: "dashboard",
          projectId,
          projectVersionId: randomUUID(),
          timeZone: "UTC",
        };
        const id = readModelKey(query);
        try {
          await harness.repository.request(id, query, now);
          const claims = await Promise.all([
            harness.repository.claim(now, later, "owner-a"),
            harness.repository.claim(now, later, "owner-b"),
          ]);
          expect(claims.filter(Boolean)).toHaveLength(1);
          const lease = claims.find((entry) => entry !== null)!;
          await harness.repository.invalidate(projectId, now);
          expect(await harness.repository.complete(lease, { count: 1 }, now, later)).toBe(false);
          const next = await harness.repository.claim(now, later, "owner-next");
          expect(next).not.toBeNull();
          await harness.repository.putPart(next!, 0, { items: ["case-a"] });
          expect(await harness.repository.complete(next!, { count: 2 }, now, later)).toBe(true);
          expect(await harness.repository.getPart(id, "owner-next", 0)).toEqual({
            items: ["case-a"],
          });
          expect(await harness.repository.getPart(id, "owner-a", 0)).toBeNull();
        } finally {
          await harness.close();
        }
      });

      it("refuses expired publication, stops after five failures and allows an explicit retry", async () => {
        const harness = await database(dialect);
        const query: ReadModelQuery = {
          kind: "dashboard",
          projectId,
          projectVersionId: randomUUID(),
          timeZone: "UTC",
        };
        const id = readModelKey(query);
        try {
          await harness.repository.request(id, query, now);
          const expired = await harness.repository.claim(now, later, "expired");
          expect(await harness.repository.renew(expired!, later, "2026-09-05T00:03:00.000Z")).toBe(
            false,
          );
          expect(await harness.repository.complete(expired!, {}, later, later)).toBe(false);
          for (let index = 0; index < 5; index++) {
            const lease = await harness.repository.claim(
              later,
              "2026-09-05T00:03:00.000Z",
              `failure-${index}`,
            );
            expect(lease).not.toBeNull();
            await harness.repository.fail(lease!, later);
          }
          expect(await harness.repository.claim(later, later, "blocked")).toBeNull();
          await harness.repository.invalidate(projectId, later);
          expect(
            await harness.repository.claim(later, "2026-09-05T00:03:00.000Z", "retry"),
          ).not.toBeNull();
        } finally {
          await harness.close();
        }
      });

      it("keeps versions isolated, survives service recreation and removes abandoned chunks", async () => {
        const harness = await database(dialect);
        const query: ReadModelQuery = {
          kind: "dashboard",
          projectId,
          projectVersionId: "version-a",
          timeZone: "UTC",
        };
        const clock = { now: () => new Date(now) };
        try {
          const service = new ReadModelSnapshotService(harness.repository, clock);
          const first = await service.read(query);
          const lease = await harness.repository.claim(now, later, "generation-a");
          await harness.repository.putPart(lease!, 0, { count: 7 });
          await harness.repository.complete(lease!, { count: 7 }, now, later);
          expect(
            await new ReadModelSnapshotService(harness.repository, clock).read(query),
          ).toMatchObject({ payload: { count: 7 }, generation: "generation-a" });
          const different = await service.read({ ...query, projectVersionId: "version-b" });
          expect(different.id).not.toBe(first.id);
          expect(different.payload).toBeNull();
          expect(
            readModelKey({
              timeZone: "UTC",
              projectVersionId: "version-a",
              projectId,
              kind: "dashboard",
            }),
          ).toBe(first.id);
          await harness.repository.cleanup("2026-09-06T00:00:01.000Z", 25);
          expect(await harness.repository.get(first.id)).toBeNull();
          expect(await harness.repository.getPart(first.id, "generation-a", 0)).toBeNull();
        } finally {
          await harness.close();
        }
      });

      it("recovers expired leases and retains the previous snapshot when rebuilding fails", async () => {
        const harness = await database(dialect);
        const query: ReadModelQuery = {
          kind: "dashboard",
          projectId,
          projectVersionId: randomUUID(),
          timeZone: "UTC",
        };
        const id = readModelKey(query);
        try {
          await harness.repository.request(id, query, now);
          const lost = await harness.repository.claim(now, later, "lost");
          const recovered = await harness.repository.claim(
            later,
            "2026-09-05T00:02:00.000Z",
            "recovered",
          );
          expect(recovered).not.toBeNull();
          expect(await harness.repository.complete(lost!, {}, now, later)).toBe(false);
          expect(await harness.repository.complete(recovered!, { count: 3 }, later, later)).toBe(
            true,
          );
          const failing = await harness.repository.claim(
            later,
            "2026-09-05T00:02:00.000Z",
            "failing",
          );
          await harness.repository.fail(failing!, "2026-09-05T00:03:00.000Z");
          expect(await harness.repository.get(id)).toMatchObject({
            failed: true,
            payload: { count: 3 },
          });
        } finally {
          await harness.close();
        }
      });
    },
  );
}

async function database(dialect: "sqlite" | "postgres") {
  const directory = await mkdtemp(resolve(tmpdir(), "read-model-test-"));
  if (dialect === "sqlite") {
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "test.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    return {
      repository: new SqliteReadModelSnapshotRepository(handle),
      execute: async (statement: string) => {
        handle.client.exec(statement);
      },
      close: async () => {
        handle.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const schema = `read_model_${randomUUID().replaceAll("-", "")}`;
  const admin = createPostgresDatabase({
    connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!,
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
  });
  await admin.ready;
  await admin.pool.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.AUTOFORGE_TEST_POSTGRES_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const handle = createPostgresDatabase({
    connectionString: url.toString(),
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
  });
  await handle.ready;
  return {
    repository: new PostgresReadModelSnapshotRepository(handle),
    execute: async (statement: string) => {
      await handle.pool.query(statement);
    },
    close: async () => {
      await handle.close();
      await admin.pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
