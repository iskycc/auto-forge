import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
for (const dialect of ["sqlite", "postgresql"] as const)
  describe.skipIf(dialect === "postgresql" && !postgresUrl)(
    `${dialect} task lock and DDT reason upgrade`,
    () => {
      it("upgrades existing history without locking tasks, rolls back failed DDL and recovers", async () => {
        const directory = await mkdtemp(resolve(tmpdir(), "task-lock-upgrade-"));
        const sqlite =
          dialect === "sqlite" ? new Database(resolve(directory, "db.sqlite")) : undefined;
        let admin: Client | undefined;
        let postgres: Client | undefined;
        let databaseName = "";
        try {
          if (!sqlite) {
            admin = new Client({ connectionString: postgresUrl });
            await admin.connect();
            databaseName = `task_lock_upgrade_${randomUUID().replaceAll("-", "")}`;
            await admin.query(`CREATE DATABASE ${databaseName}`);
            const url = new URL(postgresUrl!);
            url.pathname = `/${databaseName}`;
            postgres = new Client({ connectionString: url.toString() });
            await postgres.connect();
          }
          const execute = async (statement: string) => {
            if (sqlite) sqlite.exec(statement);
            else await postgres!.query(statement);
          };
          const rows = async (statement: string) =>
            sqlite ? sqlite.prepare(statement).all() : (await postgres!.query(statement)).rows;
          const folder = resolve("packages/db/drizzle", dialect);
          const files = (await readdir(folder)).filter((file) => file.endsWith(".sql")).sort();
          const latest = files.find((file) =>
            file.endsWith("_suite_locks_ddt_import_reasons.sql"),
          )!;
          for (const file of files.filter((file) => file < latest))
            await execute(await readFile(resolve(folder, file), "utf8"));
          await execute(
            "INSERT INTO case_suites(id,name,version,created_at,updated_at) VALUES ('old','旧任务',1,'2026-11-09','2026-11-09')",
          );
          const migration = await readFile(resolve(folder, latest), "utf8");
          await execute("BEGIN");
          await expect(
            execute(`${migration}\nSELECT * FROM missing_public_task_migration;`),
          ).rejects.toThrow();
          await execute("ROLLBACK");
          await expect(rows("SELECT locked_by FROM case_suites")).rejects.toThrow();
          await execute("BEGIN");
          await execute(migration);
          await execute("COMMIT");
          expect(
            await rows("SELECT id,locked_by,locked_by_name,locked_at FROM case_suites"),
          ).toEqual([{ id: "old", locked_by: null, locked_by_name: null, locked_at: null }]);
          expect(await rows("SELECT overwrite_reason FROM ddt_import_jobs")).toEqual([]);
          expect(await rows("SELECT change_reason FROM ddt_case_history")).toEqual([]);
        } finally {
          sqlite?.close();
          await postgres?.end();
          if (admin) {
            try {
              if (databaseName) await admin.query(`DROP DATABASE ${databaseName}`);
            } finally {
              await admin.end();
            }
          }
          await rm(directory, { recursive: true, force: true });
        }
      });
    },
  );
