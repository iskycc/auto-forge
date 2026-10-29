import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { Client } from "pg";
import { describe, it, expect } from "vitest";
const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
for (const dialect of ["sqlite", "postgresql"] as const)
  for (const suffix of [
    "_daily_logs_and_monthly_archives.sql",
    "_log_archive_volumes_and_copy_lifecycle.sql",
  ])
    describe.skipIf(dialect === "postgresql" && !postgresUrl)(
      `${dialect} ${suffix} migration`,
      () => {
        it("rolls back partial DDL, upgrades legacy database bindings without rerouting, and reapplies safely", async () => {
          const directory = await mkdtemp(resolve(tmpdir(), "af-archive-upgrade-"));
          const sqlite =
            dialect === "sqlite" ? new Database(resolve(directory, "main.sqlite")) : undefined;
          let admin: Client | undefined, postgres: Client | undefined;
          const name = `af_archive_upgrade_${randomUUID().replaceAll("-", "")}`;
          try {
            if (!sqlite) {
              admin = new Client({ connectionString: postgresUrl });
              await admin.connect();
              await admin.query(`CREATE DATABASE "${name}"`);
              const connection = new URL(postgresUrl!);
              connection.pathname = `/${name}`;
              postgres = new Client({ connectionString: connection.toString() });
              await postgres.connect();
            }
            const execute = async (sql: string) => {
              if (sqlite) sqlite.exec(sql);
              else await postgres!.query(sql);
            };
            const rows = async (sql: string) =>
              sqlite ? sqlite.prepare(sql).all() : (await postgres!.query(sql)).rows;
            const folder = resolve("packages/db/drizzle", dialect);
            const files = (await readdir(folder)).filter((file) => file.endsWith(".sql")).sort();
            const migration = files.find((file) => file.endsWith(suffix))!;
            for (const file of files.filter((file) => file < migration))
              await execute(await readFile(resolve(folder, file), "utf8"));
            await execute(
              "INSERT INTO log_databases(id,name,address,connection_encrypted,created_at) VALUES('legacy','old','old-host:5432/logs','encrypted-fixture','2026-10-01'); INSERT INTO run_batch_log_storage(batch_id,database_id,stored_bytes) VALUES('old-batch','legacy',1234);",
            );
            const lifecycle = suffix.includes("volumes");
            if (lifecycle)
              await execute(
                "INSERT INTO log_archive_jobs(id,month,status,object_key,sha256,index_sha256,requested_by,created_at,updated_at) VALUES('old-archive','2026-10','completed','legacy.zip','sha','index-sha','admin','2026-10-28','2026-10-28');",
              );
            const sql = await readFile(resolve(folder, migration), "utf8");
            await execute("BEGIN");
            await expect(
              execute(sql + "\nSELECT * FROM missing_archive_fixture;"),
            ).rejects.toThrow();
            await execute("ROLLBACK");
            if (lifecycle) {
              await expect(rows("SELECT copy_state FROM log_archive_jobs")).rejects.toThrow();
              expect(
                await rows("SELECT object_key FROM log_archive_jobs WHERE id='old-archive'"),
              ).toEqual([{ object_key: "legacy.zip" }]);
            } else
              expect(
                await rows(
                  dialect === "sqlite"
                    ? "SELECT name FROM sqlite_schema WHERE type='table' AND name='log_archive_jobs'"
                    : "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='log_archive_jobs'",
                ),
              ).toEqual([]);
            await execute("BEGIN");
            await execute(sql);
            await execute("COMMIT");
            if (lifecycle) {
              expect(
                await rows(
                  "SELECT copy_state,group_id,volume_number,object_key FROM log_archive_jobs WHERE id='old-archive'",
                ),
              ).toEqual([
                {
                  copy_state: "retained",
                  group_id: null,
                  volume_number: 1,
                  object_key: "legacy.zip",
                },
              ]);
              expect(await rows("SELECT * FROM log_archive_download_receipts")).toEqual([]);
            }
            expect(
              await rows(
                "SELECT storage_mode,parent_database_id FROM log_databases WHERE id='legacy'",
              ),
            ).toEqual([{ storage_mode: "legacy", parent_database_id: null }]);
            expect(await rows("SELECT batch_id,database_id FROM run_batch_log_storage")).toEqual([
              { batch_id: "old-batch", database_id: "legacy" },
            ]);
            expect(
              await rows("SELECT owner,lease_expires_at FROM log_archive_worker_lock"),
            ).toEqual([{ owner: null, lease_expires_at: null }]);
          } finally {
            sqlite?.close();
            await postgres?.end();
            if (admin) {
              await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
              await admin.end();
            }
            await rm(directory, { recursive: true, force: true });
          }
        }, 30000);
      },
    );
