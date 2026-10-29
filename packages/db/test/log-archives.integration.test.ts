import { randomBytes } from "node:crypto";
import { AesGcmSecretCipher } from "../../../apps/web/src/lib/secret-cipher-core";
import { PostgresLogDatabaseRepository } from "../src/postgres-log-databases";
import { PostgresRoutedAttemptLogStore } from "../src/postgres-routed-attempt-logs";
import type { AsyncAttemptLogStore, AttemptLogStore } from "../src/attempt-log-store";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { describe, it, expect, vi } from "vitest";
import { unzipSync } from "fflate";
import { LocalObjectStore } from "../../object-store/src/local-object-store";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteLogArchiveRepository } from "../src/sqlite-log-archives";
import { PostgresLogArchiveRepository } from "../src/postgres-log-archives";
import { createAttemptLogStore, isolatedThreadLogCompression } from "../src/attempt-log-store";
import { LogArchiveWorker } from "../src/log-archive-worker";
import { ArchivedAttemptLogStore } from "../src/archived-attempt-log-store";
import { Pool } from "pg";
const pgUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const now = "2026-11-03T00:00:00.000Z",
  finished = "2026-10-27T12:00:00.000Z";
for (const dialect of ["sqlite", "postgres"] as const)
  describe.skipIf(dialect === "postgres" && !pgUrl)(
    `${dialect} recoverable monthly log archives`,
    () => {
      it("independently verifies ZIP and all source content before cleanup, preserves old links, and excludes running batches", async () => {
        const directory = await mkdtemp(join(tmpdir(), "af-monthly-logs-"));
        const databaseName = `af_archive_${randomUUID().replaceAll("-", "")}`;
        const maintenanceName = `${databaseName}_admin`;
        let admin: Pool | undefined;
        if (dialect === "postgres") {
          admin = new Pool({ connectionString: pgUrl });
          await admin.query(`CREATE DATABASE "${databaseName}"`);
          await admin.query(`CREATE DATABASE "${maintenanceName}"`);
        }
        const pgConnection = new URL(pgUrl ?? "postgres://localhost/postgres");
        pgConnection.pathname = `/${databaseName}`;
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
                connectionString: pgConnection.toString(),
                migrationsFolder: resolve("packages/db/drizzle/postgresql"),
                poolMax: 1,
              })
            : undefined;
        if (postgres) await postgres.ready;
        const repository = sqlite
          ? new SqliteLogArchiveRepository(sqlite)
          : new PostgresLogArchiveRepository(postgres!);
        let logs: AttemptLogStore | AsyncAttemptLogStore = createAttemptLogStore(
          join(directory, "attempt-logs"),
          isolatedThreadLogCompression,
        );
        const databasePrefix = `af_arc_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        if (postgres) {
          const connection = new URL(pgUrl!);
          const registry = new PostgresLogDatabaseRepository(
            postgres,
            new AesGcmSecretCipher(randomBytes(32).toString("base64")),
            "archive-platform",
            resolve("packages/db/drizzle/log-postgresql"),
          );
          const root = await registry.registerDaily(
            randomUUID(),
            {
              name: "归档专用按日服务器",
              host: connection.hostname,
              port: Number(connection.port || 5432),
              username: decodeURIComponent(connection.username),
              password: decodeURIComponent(connection.password),
              maintenanceDatabase: maintenanceName,
              databasePrefix,
              sslMode: "disable",
            },
            now,
          );
          await registry.select(root.id, 1);
          logs = new PostgresRoutedAttemptLogStore(registry, logs);
        }
        const objects = new LocalObjectStore(directory);
        await objects.ready();
        const archived = new ArchivedAttemptLogStore(logs, repository, objects);
        const execute = async (sql: string, params: unknown[] = []) => {
          if (postgres) return (await postgres.pool.query(sql, params)).rows;
          const bindings: unknown[] = [];
          const query = sql.replace(/\$(\d+)/g, (_match, index: string) => {
            bindings.push(params[Number(index) - 1]);
            return "?";
          });
          return sqlite!.client.prepare(query).all(...bindings);
        };
        const runner = randomUUID();
        const batchId = randomUUID(),
          running = randomUUID();
        const attempts: string[] = [];
        const content = "Wallet 中文测试\0🚀\n".repeat(800);
        try {
          await execute(
            `INSERT INTO runners(id,credential_hash,name,disabled,draining,os,architecture,agent_version,protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at) VALUES($1,$1,'runner',${dialect === "sqlite" ? "0,0" : "FALSE,FALSE"},'linux','amd64','test',1,'{}','[]',10,0,$2,$2,$2) RETURNING id`,
            [runner, finished],
          );
          for (const [id, status] of [
            [batchId, "failed"],
            [running, "running"],
          ])
            await execute(
              "INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,created_at,updated_at) VALUES($1,'suite','月度日志任务',1,$2,0,4,'[]',$3,$3) RETURNING id",
              [id, status, finished],
            );
          for (let run = 0; run < 60; run++) {
            const runId = randomUUID();
            await execute(
              "INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,created_at,updated_at) VALUES($1,$2,$1,1,'中文 DDT 用例','example.Wallet','failed',2,$3,$3) RETURNING id",
              [runId, batchId, finished],
            );
            for (let round = 1; round <= 2; round++) {
              const id = randomUUID();
              attempts.push(id);
              await execute(
                "INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,execution_round,status,scheduling_score,created_at,finished_at) VALUES($1,$2,$3,$4,$4,'failed',1,$5,$5) RETURNING id",
                [id, runId, runner, round, finished],
              );
              await logs.appendChunks({
                batchId,
                attemptId: id,
                receivedAt: finished,
                chunks: Array.from({ length: 10 }, (_, sequence) => ({
                  stream: "stdout",
                  sequence,
                  content,
                  recordedAt: finished,
                })),
              });
            }
          }
          const jobId = randomUUID();
          await repository.create(jobId, "2026-10", undefined, "fixture-admin", now);
          const worker = new LogArchiveWorker({
            ids: { next: randomUUID },
            repository,
            logs,
            objects,
            dataDirectory: directory,
            viewerResourcesDirectory: resolve("resources/log-archive-viewer"),
            clock: { now: () => new Date(now) },
            backgroundAllowed: () => true,
          });
          expect(await worker.run(new AbortController().signal)).toBe(true);
          const ready = await repository.find(jobId);
          expect(ready.status).toBe("ready");
          expect(ready.totalBatches).toBe(1);
          expect(ready.attemptCount).toBe(120);
          expect(ready.chunkCount).toBe(1200);
          expect((await logs.batchStoreStats([batchId])).get(batchId)).toBeGreaterThan(0);
          const payload = await objects.read(ready.objectKey!);
          const zipPath = join(directory, "export.zip");
          await writeFile(zipPath, payload);
          await verify(zipPath);
          const files = unzipSync(payload);
          expect(files["viewer-windows-amd64.exe"]?.length).toBeGreaterThan(0);
          expect(files["viewer-linux-arm64"]?.length).toBeGreaterThan(0);
          const manifest = JSON.parse(Buffer.from(files["manifest.json"]!).toString("utf8")) as {
            files: Array<{ path: string; sizeBytes: number; sha256: string }>;
          };
          expect(
            manifest.files.filter((f) => f.path.endsWith("logs.aflog"))[0]!.sizeBytes,
          ).toBeLessThan((Buffer.byteLength(content) * 1200) / 10);
          // A missing source chunk must fail even if ZIP CRC and all encoded-file checksums are recomputed.
          const extracted = join(directory, "corrupt");
          await mkdir(extracted);
          for (const [name, bytes] of Object.entries(files)) {
            const path = join(extracted, name);
            await mkdir(join(path, ".."), { recursive: true });
            await writeFile(path, bytes);
          }
          const catalogKey = `batches/${batchId}/catalog.aflog`;
          const catalog = Buffer.from(files[catalogKey]!);
          catalog[catalog.length - 1] = catalog[catalog.length - 1]! ^ 1;
          await writeFile(join(extracted, catalogKey), catalog);
          const file = manifest.files.find((file) => file.path === catalogKey)!;
          file.sha256 = createHash("sha256").update(catalog).digest("hex");
          await writeFile(join(extracted, "manifest.json"), JSON.stringify(manifest));
          await expect(
            pack(extracted, join(directory, "corrupt.zip"), join(directory, "corrupt.index.json")),
          ).rejects.toThrow();
          const damaged = Buffer.from(payload);
          damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
          await writeFile(join(directory, "objects", ready.objectKey!), damaged);
          await repository.requestCleanup(jobId, now);
          await worker.run(new AbortController().signal);
          expect((await repository.find(jobId)).status).toBe("failed");
          expect(await repository.archivedBatch(batchId)).toBeUndefined();
          expect((await logs.batchStoreStats([batchId])).get(batchId)).toBeGreaterThan(0);
          await writeFile(join(directory, "objects", ready.objectKey!), payload);
          await repository.requestCleanup(jobId, now);
          await worker.run(new AbortController().signal);
          expect((await repository.find(jobId)).status).toBe("completed");
          expect((await logs.batchStoreStats([batchId])).get(batchId) ?? 0).toBe(0);
          expect(await archived.acknowledgedSequence(batchId, attempts[0]!, "stdout")).toBe(9);
          const page = await archived.listChunks({
            batchId,
            attemptId: attempts[0]!,
            stream: "stdout",
            afterSequence: -1,
            limit: 2,
          });
          expect(page.items.map((c) => c.content)).toEqual([content, content]);
          expect(page.hasMore).toBe(true);
          expect(
            (
              await archived.listChunks({
                batchId,
                attemptId: attempts[0]!,
                stream: "stdout",
                afterSequence: 8,
                limit: 2,
              })
            ).items.map((c) => c.sequence),
          ).toEqual([9]);
          expect((await execute("SELECT count(*) AS total FROM run_attempts"))[0]!.total).toBe(
            dialect === "sqlite" ? 120 : "120",
          );
          await expect(
            archived.appendChunks({
              batchId,
              attemptId: attempts[0]!,
              receivedAt: now,
              chunks: [],
            }),
          ).rejects.toMatchObject({ code: "LOG_ARCHIVE_READ_ONLY" });
          if (postgres) {
            const days = await postgres.pool.query<{ physical_name: string }>(
              "SELECT physical_name FROM log_databases WHERE storage_mode='day'",
            );
            expect(days.rows.length).toBeGreaterThan(0);
            expect(
              (
                await admin!.query(
                  "SELECT datname FROM pg_database WHERE datname=ANY($1::text[])",
                  [days.rows.map((row) => row.physical_name)],
                )
              ).rows,
            ).toEqual([]);
          }
          const emptyId = randomUUID();
          await repository.create(emptyId, "2026-10", undefined, "fixture-admin", now);
          await worker.run(new AbortController().signal);
          expect((await repository.find(emptyId)).errorMessage).toContain("没有可归档");
          const cancelledId = randomUUID();
          await repository.create(cancelledId, "2026-10", undefined, "fixture-admin", now);
          const abandoned = join(directory, "archive-staging", `${cancelledId}-abandoned`);
          await mkdir(abandoned, { recursive: true });
          await writeFile(join(abandoned, "partial.aflog"), "incomplete");
          const orphanKey = `log-archives/2026-10/${cancelledId}/unfinished.zip`,
            orphanBytes = Buffer.from("unfinished");
          await objects.putObject({
            objectKey: orphanKey,
            sha256: createHash("sha256").update(orphanBytes).digest("hex"),
            sizeBytes: orphanBytes.length,
            mediaType: "application/zip",
            content: (async function* () {
              yield orphanBytes;
            })(),
          });
          await repository.cancel(cancelledId, now);
          await worker.run(new AbortController().signal);
          expect((await repository.find(cancelledId)).status).toBe("cancelled");
          expect(await objects.exists(orphanKey)).toBe(false);
          await expect(readdir(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
          expect(await objects.exists(ready.objectKey!)).toBe(true);
          const interruptedId = randomUUID();
          await repository.create(interruptedId, "2026-09", undefined, "fixture-admin", now);
          const expiry = new Date(Date.parse(now) + 10000).toISOString(),
            afterExpiry = new Date(Date.parse(now) + 11000).toISOString(),
            nextExpiry = new Date(Date.parse(now) + 101000).toISOString();
          expect((await repository.claim("first-worker", now, expiry))?.id).toBe(interruptedId);
          await repository.update(interruptedId, "first-worker", { status: "building" }, now);
          expect(await repository.claim("second-worker", now, expiry)).toBeUndefined();
          expect((await repository.claim("second-worker", afterExpiry, nextExpiry))?.id).toBe(
            interruptedId,
          );
          await expect(
            repository.update(interruptedId, "first-worker", { status: "ready" }, afterExpiry),
          ).rejects.toMatchObject({ code: "LOG_ARCHIVE_LEASE_LOST" });
          await repository.update(
            interruptedId,
            "second-worker",
            { status: "cancelled" },
            afterExpiry,
          );
          await repository.release("first-worker");
          expect(await repository.renew("second-worker", afterExpiry, nextExpiry)).toBe(true);
          await repository.release("second-worker");
          await expect(
            repository.requestCopyRemoval(jobId, "fixture-admin", ready.sha256!, now),
          ).rejects.toMatchObject({ code: "LOG_ARCHIVE_DOWNLOAD_REQUIRED" });
          await expect(
            repository.recordDownload(
              jobId,
              "fixture-admin",
              ready.sha256!,
              ready.archiveBytes - 1,
              now,
            ),
          ).rejects.toMatchObject({ code: "LOG_ARCHIVE_DOWNLOAD_CONFLICT" });
          await repository.recordDownload(
            jobId,
            "fixture-admin",
            ready.sha256!,
            ready.archiveBytes,
            now,
          );
          expect(
            (await repository.list(undefined, "fixture-admin")).items.find(
              (job) => job.id === jobId,
            )?.downloadedAt,
          ).toBe(now);
          await expect(
            repository.requestCopyRemoval(jobId, "another-admin", ready.sha256!, now),
          ).rejects.toMatchObject({ code: "LOG_ARCHIVE_DOWNLOAD_REQUIRED" });
          await expect(
            repository.requestCopyRemoval(jobId, "fixture-admin", "0".repeat(64), now),
          ).rejects.toMatchObject({ code: "LOG_ARCHIVE_DOWNLOAD_CONFLICT" });
          const originalDelete = objects.delete.bind(objects);
          const deletion = vi.spyOn(objects, "delete").mockImplementation(async (key) => {
            if (key === `${ready.objectKey}.index.json`)
              throw new Error("injected object-store interruption");
            return originalDelete(key);
          });
          await repository.requestCopyRemoval(jobId, "fixture-admin", ready.sha256!, now);
          await expect(worker.run(new AbortController().signal)).rejects.toThrow(
            "Removing archive copy",
          );
          expect(await repository.find(jobId)).toMatchObject({
            status: "completed",
            copyState: "delete_failed",
          });
          await expect(
            archived.listChunks({
              batchId,
              attemptId: attempts[0]!,
              stream: "stdout",
              afterSequence: -1,
              limit: 10,
            }),
          ).rejects.toMatchObject({ code: "LOG_ARCHIVE_OFFLINE" });
          deletion.mockRestore();
          await repository.requestCopyRemoval(jobId, "fixture-admin", ready.sha256!, now);
          await worker.run(new AbortController().signal);
          expect(await repository.find(jobId)).toMatchObject({
            status: "completed",
            copyState: "deleted",
          });
          expect(await objects.exists(ready.objectKey!)).toBe(false);
          expect(await objects.exists(`${ready.objectKey}.index.json`)).toBe(false);
          expect(
            (
              await execute("SELECT count(*) AS total FROM execution_runs WHERE batch_id=$1", [
                batchId,
              ])
            )[0]!.total,
          ).toBeTruthy();
          await repository.requestCopyRemoval(jobId, "fixture-admin", ready.sha256!, now);
        } finally {
          await archived.close();
          sqlite?.close();
          await postgres?.close();
          if (admin) {
            const leftover = await admin.query<{ datname: string }>(
              "SELECT datname FROM pg_database WHERE starts_with(datname,$1)",
              [databasePrefix + "_"],
            );
            for (const row of leftover.rows) await admin.query(`DROP DATABASE "${row.datname}"`);
            await admin.query(`DROP DATABASE "${databaseName}"`);
            await admin.query(`DROP DATABASE "${maintenanceName}"`);
            await admin.end();
          }
          await rm(directory, { recursive: true, force: true });
        }
      }, 60000);
    },
  );
function command(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(resolvePath(), args, {
      shell: false,
      env: { ...process.env, GOMAXPROCS: "1" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (chunk: Buffer) => {
      error += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(error))));
  });
}
function resolvePath() {
  return resolve(
    `resources/log-archive-viewer/viewer-linux-${process.arch === "arm64" ? "arm64" : "amd64"}`,
  );
}
function verify(filename: string) {
  return command(["--verify", filename]);
}
function pack(directory: string, output: string, index: string) {
  return command(["--pack", directory, "--output", output, "--index", index]);
}
