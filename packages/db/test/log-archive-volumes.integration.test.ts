import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { describe, it, expect, vi } from "vitest";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteLogArchiveRepository } from "../src/sqlite-log-archives";
import { PostgresLogArchiveRepository } from "../src/postgres-log-archives";
import { LocalObjectStore } from "../../object-store/src/local-object-store";
import { LogArchiveWorker } from "../src/log-archive-worker";
import type { AsyncAttemptLogStore } from "../src/attempt-log-store";
import { unreservedArchiveBatch } from "../src/log-archive-retention-guard";
const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const now = "2026-11-03T00:00:00.000Z",
  finished = "2026-10-20T00:00:00.000Z";
for (const dialect of ["sqlite", "postgres"] as const)
  describe.skipIf(dialect === "postgres" && !postgresUrl)(
    `${dialect} archive volume planning`,
    () => {
      it("freezes the source horizon, pins unplanned logs, resumes the same volume and creates its successor once after verification", async () => {
        const directory = await mkdtemp(join(tmpdir(), "af-archive-volumes-"));
        const databaseName = `af_archive_volumes_${randomUUID().replaceAll("-", "")}`;
        const admin =
          dialect === "postgres" ? new Client({ connectionString: postgresUrl }) : undefined;
        if (admin) {
          await admin.connect();
          await admin.query(`CREATE DATABASE "${databaseName}"`);
        }
        const url = new URL(postgresUrl ?? "postgres://unused/postgres");
        url.pathname = `/${databaseName}`;
        const sqlite =
          dialect === "sqlite"
            ? createSqliteDatabase({
                databasePath: join(directory, "main.sqlite"),
                migrationsFolder: resolve("packages/db/drizzle/sqlite"),
              })
            : undefined;
        const postgres =
          dialect === "postgres"
            ? createPostgresDatabase({
                connectionString: url.toString(),
                migrationsFolder: resolve("packages/db/drizzle/postgresql"),
                poolMax: 1,
              })
            : undefined;
        await postgres?.ready;
        const repository = sqlite
          ? new SqliteLogArchiveRepository(sqlite)
          : new PostgresLogArchiveRepository(postgres!);
        async function rows(
          sql: string,
          parameters: unknown[] = [],
        ): Promise<Record<string, unknown>[]> {
          if (postgres) return (await postgres.pool.query(sql, parameters)).rows;
          const values: unknown[] = [];
          const prepared = sql.replace(/\$(\d+)/g, (_match, index: string) => {
            values.push(parameters[Number(index) - 1]);
            return "?";
          });
          return sqlite!.client.prepare(prepared).all(...values) as Record<string, unknown>[];
        }
        try {
          const batchIds = Array.from({ length: 3 }, () => randomUUID()).sort();
          const lateId = randomUUID();
          for (const id of [...batchIds, lateId])
            await rows(
              "INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,created_at,updated_at) VALUES($1,'suite','日志归档分卷',1,'succeeded',0,1,'[]',$2,$2) RETURNING id",
              [id, id === lateId ? "2026-10-30T00:00:00.000Z" : finished],
            );
          // Creation in October must not later acquire a batch which only becomes terminal after the click.
          const cutoff = "2026-10-25T00:00:00.000Z";
          const id = randomUUID();
          await repository.create(id, "2026-10", undefined, "operator", cutoff, {
            targetVolumeMiB: 1,
            minimumFreeMiB: 1024,
            minimumFreePercent: 10,
          });
          const job = (await repository.claim("worker", now, "2026-11-03T00:01:30.000Z"))!;
          const volume = {
            maximumSourceBytes: 150,
            sizes: async (ids: readonly string[]) => new Map(ids.map((batchId) => [batchId, 100])),
          };
          expect(await repository.reserveBatches(job, "worker", now, undefined, volume)).toBe(1);
          expect((await repository.batches(id)).map((batch) => batch.id)).toEqual([batchIds[0]]);
          expect((await repository.list()).items).toHaveLength(1);
          expect(
            await rows(
              `SELECT b.id FROM run_batches b WHERE b.id=$1 AND ${unreservedArchiveBatch("b.id")}`,
              [batchIds[2]],
            ),
          ).toEqual([]);
          const resumed = await repository.find(id);
          expect(await repository.reserveBatches(resumed, "worker", now, undefined, volume)).toBe(
            1,
          );
          await repository.update(id, "worker", { status: "ready" }, now);
          // A user can request source cleanup between publishing this volume and enqueueing the next.
          await repository.update(id, "worker", { status: "cleaning" }, now);
          await expect(repository.enqueueNextVolume(id, "worker", id, now)).rejects.toThrow();
          expect((await repository.find(id)).nextVolumePending).toBe(true);
          await repository.enqueueNextVolume(id, "worker", randomUUID(), now);
          await repository.enqueueNextVolume(id, "worker", randomUUID(), now);
          await repository.update(id, "worker", { status: "completed" }, now);
          const next = (await repository.list()).items.find((item) => item.id !== id)!;
          expect(next).toMatchObject({ groupId: id, volumeNumber: 2, status: "queued" });
          expect((await repository.list()).items).toHaveLength(2);
          await repository.release("worker");
          const second = (await repository.claim("worker-2", now, "2026-11-03T00:01:30.000Z"))!;
          expect(second.id).toBe(next.id);
          expect(second.sourceCutoffAt).toBe(cutoff);
          expect(await repository.reserveBatches(second, "worker-2", now, undefined, volume)).toBe(
            1,
          );
          expect((await repository.batches(next.id)).map((batch) => batch.id)).toEqual([
            batchIds[1],
          ]);
          await repository.update(next.id, "worker-2", { status: "cancelled" }, now);
          await repository.release("worker-2");
          expect(
            await rows(
              `SELECT b.id FROM run_batches b WHERE b.id=$1 AND ${unreservedArchiveBatch("b.id")}`,
              [batchIds[2]],
            ),
          ).toEqual([{ id: batchIds[2] }]);
          expect(
            await rows("SELECT * FROM log_archive_batches WHERE batch_id=$1", [lateId]),
          ).toEqual([]);
          const cancellationId = randomUUID();
          await repository.create(cancellationId, "2026-09", undefined, "operator", now);
          await repository.claim("cancellation-worker", now, "2026-11-03T00:01:30.000Z");
          await repository.update(
            cancellationId,
            "cancellation-worker",
            { status: "verifying" },
            now,
          );
          await repository.cancel(cancellationId, now);
          await expect(
            repository.update(
              cancellationId,
              "cancellation-worker",
              { status: "ready", objectKey: "never-published.zip" },
              now,
            ),
          ).rejects.toMatchObject({ code: "LOG_ARCHIVE_CANCELLED" });
          expect((await repository.find(cancellationId)).objectKey).toBeUndefined();
          await repository.update(
            cancellationId,
            "cancellation-worker",
            { status: "cancelled" },
            now,
          );
          await repository.release("cancellation-worker");

          const budgetJobId = randomUUID();
          await repository.create(budgetJobId, "2026-10", undefined, "operator", now, {
            targetVolumeMiB: 1,
            minimumFreeMiB: 1024,
            minimumFreePercent: 10,
          });
          const logRead = vi.fn(async () => ({ items: [], hasMore: false }));
          const fakeLogs: AsyncAttemptLogStore = {
            appendChunks: vi.fn(),
            listChunks: logRead,
            acknowledgedSequence: async () => -1,
            recordWatermarks: vi.fn(),
            removeBatchStore: vi.fn(),
            batchStoreStats: async (ids) => new Map(ids.map((id) => [id, 1024 ** 3])),
            directoryBytes: async () => 0,
            relativeStorePath: (id) => `${id}.sqlite`,
            close: vi.fn(),
          };
          const objects = new LocalObjectStore(directory);
          await objects.ready();
          let availableBytes = 3 * 1024 ** 3;
          const worker = new LogArchiveWorker({
            ids: { next: randomUUID },
            repository,
            logs: fakeLogs,
            objects,
            dataDirectory: directory,
            viewerResourcesDirectory: resolve("resources/log-archive-viewer"),
            clock: { now: () => new Date(now) },
            backgroundAllowed: () => true,
            diskSpace: async () => ({ totalBytes: 10 * 1024 ** 3, availableBytes }),
          });
          await worker.run(new AbortController().signal);
          const blocked = await repository.find(budgetJobId);
          expect(blocked.status).toBe("failed");
          expect(blocked.errorMessage).toContain("空间不足");
          expect(blocked.estimatedTemporaryBytes).toBeGreaterThan(3 * 1024 ** 3);
          expect(logRead).not.toHaveBeenCalled();
          expect((await objects.list({ prefix: "log-archives/", limit: 10 })).items).toEqual([]);
          const pinned = (await repository.batches(budgetJobId)).map((batch) => batch.id);
          availableBytes = 9 * 1024 ** 3;
          await repository.retry(budgetJobId, now);
          await worker.run(new AbortController().signal);
          expect((await repository.find(budgetJobId)).status).toBe("ready");
          expect((await repository.batches(budgetJobId)).map((batch) => batch.id)).toEqual(pinned);
          expect(logRead).not.toHaveBeenCalled(); // This fixture has no attempts; the metadata-only volume is valid.
        } finally {
          sqlite?.close();
          await postgres?.close();
          if (admin) {
            await admin.query(`DROP DATABASE "${databaseName}"`);
            await admin.end();
          }
          await rm(directory, { recursive: true, force: true });
        }
      }, 30000);
    },
  );
