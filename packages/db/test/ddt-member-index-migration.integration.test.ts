import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} DDT reverse member index`,
    () => {
      it("upgrades the previous schema and rolls back a failed index migration", async () => {
        const directory = await mkdtemp(resolve(tmpdir(), "ddt-member-index-"));
        const sqlite =
          dialect === "sqlite" ? new Database(resolve(directory, "db.sqlite")) : undefined;
        const pg = sqlite
          ? undefined
          : new Client({ connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL });
        const schema = `ddt_member_upgrade_${randomUUID().replaceAll("-", "")}`;
        const execute = async (statement: string) => {
          if (sqlite) sqlite.exec(statement);
          else await pg!.query(statement);
        };
        const indexes = async () =>
          sqlite
            ? sqlite
                .prepare(
                  "SELECT name FROM sqlite_schema WHERE type='index' AND name='case_suite_ddt_items_case_idx'",
                )
                .all()
            : (
                await pg!.query(
                  "SELECT indexname AS name FROM pg_indexes WHERE schemaname=$1 AND indexname='case_suite_ddt_items_case_idx'",
                  [schema],
                )
              ).rows;
        try {
          if (pg) {
            await pg.connect();
            await pg.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
          }
          const folder = resolve("packages/db/drizzle", dialect);
          const files = (await readdir(folder)).filter((name) => name.endsWith(".sql")).sort();
          const target = files.find((name) => name.endsWith("_ddt_member_reverse_lookup.sql"))!;
          for (const file of files.filter((name) => name < target))
            await execute(await readFile(resolve(folder, file), "utf8"));
          expect(await indexes()).toEqual([]);
          const ddl = await readFile(resolve(folder, target), "utf8");
          await execute("BEGIN");
          await expect(
            execute(ddl + "\nSELECT * FROM invalid_ddt_member_migration;"),
          ).rejects.toThrow();
          await execute("ROLLBACK");
          expect(await indexes()).toEqual([]);
          await execute("BEGIN");
          await execute(ddl);
          await execute("COMMIT");
          expect(await indexes()).toEqual([{ name: "case_suite_ddt_items_case_idx" }]);
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
      }, 30_000);
    },
  );
}
