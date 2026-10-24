import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
for (const dialect of ["sqlite", "postgresql"] as const)
  describe.skipIf(dialect === "postgresql" && !postgresUrl)(
    `${dialect} version-copy upgrade`,
    () => {
      it("upgrades the previous schema, rolls back interrupted DDL and preserves existing versions", async () => {
        const directory = await mkdtemp(resolve(tmpdir(), "version-copy-upgrade-"));
        const sqlite =
          dialect === "sqlite" ? new Database(resolve(directory, "db.sqlite")) : undefined;
        let admin: Client | undefined;
        let postgres: Client | undefined;
        let databaseName = "";
        try {
          if (!sqlite) {
            admin = new Client({ connectionString: postgresUrl });
            await admin.connect();
            databaseName = `copy_upgrade_${randomUUID().replaceAll("-", "")}`;
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
          const latest = files.find((file) => file.endsWith("_project_version_copies.sql"))!;
          for (const file of files.filter((file) => file < latest))
            await execute(await readFile(resolve(folder, file), "utf8"));
          await execute(
            "INSERT INTO project_versions(id,project_id,name,normalized_name,created_at,updated_at) VALUES ('preserved','00000000-0000-7000-8000-000000000001','旧版本','旧版本','2026-10-23','2026-10-23')",
          );
          const sql = await readFile(resolve(folder, latest), "utf8");
          await execute("BEGIN");
          await expect(
            execute(`${sql}\nSELECT * FROM missing_copy_migration_fixture;`),
          ).rejects.toThrow();
          await execute("ROLLBACK");
          expect(
            await rows(
              dialect === "sqlite"
                ? "SELECT name FROM sqlite_master WHERE name='project_version_copies'"
                : "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='project_version_copies'",
            ),
          ).toEqual([]);
          await execute("BEGIN");
          await execute(sql);
          await execute("COMMIT");
          expect(await rows("SELECT name FROM project_versions WHERE id='preserved'")).toEqual([
            { name: "旧版本" },
          ]);
          expect(await rows("SELECT id FROM project_version_copies")).toEqual([]);
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
