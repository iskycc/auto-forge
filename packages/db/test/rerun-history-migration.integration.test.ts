import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgresUrl)(
    `${dialect} rerun/history upgrade`,
    () => {
      it("upgrades old tasks conservatively, preserving history, and can roll back interrupted DDL", async () => {
        const directory = await mkdtemp(resolve(tmpdir(), "autoforge-rerun-upgrade-"));
        const sqlite =
          dialect === "sqlite" ? new Database(resolve(directory, "db.sqlite")) : undefined;
        const pg = sqlite ? undefined : new Client({ connectionString: postgresUrl });
        const schema = `history_upgrade_${randomUUID().replaceAll("-", "")}`;
        const execute = async (statement: string) => {
          if (sqlite) sqlite.exec(statement);
          else await pg!.query(statement);
        };
        const rows = async (statement: string) =>
          sqlite ? sqlite.prepare(statement).all() : (await pg!.query(statement)).rows;
        try {
          if (pg) {
            await pg.connect();
            await pg.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
          }
          const folder = resolve("packages/db/drizzle", dialect);
          const files = (await readdir(folder)).filter((name) => name.endsWith(".sql")).sort();
          const target = files.find((name) =>
            name.endsWith("_suite_rerun_and_history_snapshots.sql"),
          )!;
          for (const file of files.filter((name) => name < target))
            await execute(await readFile(resolve(folder, file), "utf8"));
          await execute(
            "INSERT INTO case_suites(id,name,version,created_at,updated_at) VALUES ('legacy','Origin Rerun-2026100701',1,'2026-10-30','2026-10-30'),('normal','Normal',1,'2026-10-30','2026-10-30'),('similar','Rerun-20261007-not-generated',1,'2026-10-30','2026-10-30')",
          );
          const ddl = await readFile(resolve(folder, target), "utf8");
          await execute("BEGIN");
          await expect(execute(`${ddl}\nSELECT * FROM invalid_history_upgrade;`)).rejects.toThrow();
          await execute("ROLLBACK");
          const columns = await rows(
            sqlite
              ? "SELECT name FROM pragma_table_info('case_suites') WHERE name='is_rerun'"
              : `SELECT column_name FROM information_schema.columns WHERE table_schema='${schema}' AND table_name='case_suites' AND column_name='is_rerun'`,
          );
          expect(columns).toEqual([]);
          await execute("BEGIN");
          await execute(ddl);
          await execute("COMMIT");
          const tasks = (await rows("SELECT id,is_rerun FROM case_suites ORDER BY id")) as Array<{
            id: string;
            is_rerun: number | boolean;
          }>;
          expect(tasks.map((task) => ({ id: task.id, isRerun: Boolean(task.is_rerun) }))).toEqual([
            { id: "legacy", isRerun: true },
            { id: "normal", isRerun: false },
            { id: "similar", isRerun: false },
          ]);
          expect(await rows("SELECT * FROM run_batch_history_snapshots")).toEqual([]);
        } finally {
          sqlite?.close();
          if (pg) {
            try {
              await pg.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
            } finally {
              await pg.end();
            }
          }
          await rm(directory, { recursive: true, force: true });
        }
      }, 30000);
    },
  );
}
