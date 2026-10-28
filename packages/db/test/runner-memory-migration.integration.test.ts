import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
for (const migration of [
  "runner_memory_budget",
  "runner_memory_credit",
  "runner_disk_capacity",
] as const)
  for (const dialect of ["sqlite", "postgresql"] as const)
    describe.skipIf(dialect === "postgresql" && !postgresUrl)(
      `${dialect} ${migration} upgrade`,
      () => {
        it("upgrades the previous schema, rolls back interrupted DDL and preserves existing Runners and nullable legacy metrics", async () => {
          const directory = await mkdtemp(resolve(tmpdir(), "memory-budget-upgrade-"));
          const sqlite =
            dialect === "sqlite" ? new Database(resolve(directory, "db.sqlite")) : undefined;
          let admin: Client | undefined;
          let postgres: Client | undefined;
          let databaseName = "";
          try {
            if (!sqlite) {
              admin = new Client({ connectionString: postgresUrl });
              await admin.connect();
              databaseName = `memory_upgrade_${randomUUID().replaceAll("-", "")}`;
              await admin.query(`CREATE DATABASE ${databaseName}`);
              const url = new URL(postgresUrl!);
              url.pathname = `/${databaseName}`;
              postgres = new Client({ connectionString: url.toString() });
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
            const latest = files.find((file) => file.endsWith(`_${migration}.sql`))!;
            for (const file of files.filter((file) => file < latest))
              await execute(await readFile(resolve(folder, file), "utf8"));
            await execute(
              "INSERT INTO runners(id,credential_hash,name,disabled,os,architecture,agent_version,protocol_version,labels_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at) VALUES ('legacy','hash','旧执行节点',FALSE,'linux','amd64','1.20.0',1,'[]',4,0,'2026-10-24','2026-10-24','2026-10-24')",
            );
            const column =
              migration === "runner_memory_budget"
                ? "memory_total_bytes"
                : migration === "runner_memory_credit"
                  ? "memory_execution_credit_bytes"
                  : "disk_total_bytes";
            const sql = await readFile(resolve(folder, latest), "utf8");
            await execute("BEGIN");
            await expect(
              execute(`${sql}\nSELECT * FROM missing_memory_migration_fixture;`),
            ).rejects.toThrow();
            await execute("ROLLBACK");
            expect(
              await rows(
                dialect === "sqlite"
                  ? `SELECT name FROM pragma_table_info('runners') WHERE name='${column}'`
                  : `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='runners' AND column_name='${column}'`,
              ),
            ).toEqual([]);
            await execute("BEGIN");
            await execute(sql);
            await execute("COMMIT");
            expect(
              await rows("SELECT name, max_concurrency FROM runners WHERE id='legacy'"),
            ).toEqual([{ name: "旧执行节点", max_concurrency: 4 }]);
            expect(await rows(`SELECT ${column} FROM runners WHERE id='legacy'`)).toEqual([
              { [column]: null },
            ]);
            if (migration === "runner_disk_capacity") {
              expect(
                await rows("SELECT disk_path, disk_available_bytes FROM runners WHERE id='legacy'"),
              ).toEqual([{ disk_path: null, disk_available_bytes: null }]);
            }
          } finally {
            sqlite?.close();
            await postgres?.end();
            if (admin) {
              if (databaseName) await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
              await admin.end();
            }
            await rm(directory, { recursive: true, force: true });
          }
        }, 30000);
      },
    );
