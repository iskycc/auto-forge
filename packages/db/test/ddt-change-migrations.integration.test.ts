import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { runSqliteMigrations } from "../src/migrations";
import { createPostgresDatabase } from "../src/postgres-database";

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} DDT review migration`,
    () => {
      it("upgrades the previous schema without changing cases and rolls back failed DDL", async () => {
        const directory = await mkdtemp(resolve(tmpdir(), "ddt-review-migration-"));
        const migrationsFolder = resolve(`packages/db/drizzle/${dialect}`);
        const migration =
          dialect === "sqlite" ? "0074_ddt_change_requests.sql" : "0072_ddt_change_requests.sql";
        const previous = (await readdir(migrationsFolder)).filter(
          (name) => name.endsWith(".sql") && name < migration,
        );
        for (const name of previous)
          await writeFile(
            resolve(directory, name),
            await readFile(resolve(migrationsFolder, name)),
          );
        const migrationSql = await readFile(resolve(migrationsFolder, migration), "utf8");
        const sqlite = dialect === "sqlite" ? new Database(":memory:") : undefined;
        const scratch = `ddt_review_${randomUUID().replaceAll("-", "")}`;
        const admin =
          dialect === "postgresql"
            ? new Client({ connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL! })
            : undefined;
        let client: Client | undefined;
        try {
          if (sqlite) {
            sqlite.pragma("foreign_keys = ON");
            runSqliteMigrations(sqlite, directory);
          } else {
            await admin!.connect();
            await admin!.query(`CREATE DATABASE ${scratch}`);
            const url = new URL(process.env.AUTOFORGE_TEST_POSTGRES_URL!);
            url.pathname = `/${scratch}`;
            const initial = createPostgresDatabase({
              connectionString: url.toString(),
              migrationsFolder: directory,
            });
            try {
              await initial.ready;
            } finally {
              await initial.close();
            }
            client = new Client({ connectionString: url.toString() });
            await client.connect();
          }
          const execute = async (sql: string) => {
            if (sqlite) sqlite.exec(sql);
            else await client!.query(sql);
          };
          const rows = async (sql: string) =>
            sqlite ? sqlite.prepare(sql).all() : (await client!.query(sql)).rows;
          await execute(`
            INSERT INTO users (id, username, normalized_username, display_name, source, status, created_at, updated_at)
              VALUES ('review-owner', 'review-owner', 'review-owner', 'Owner', 'local', 'active', '2026-09-29', '2026-09-29');
            INSERT INTO project_versions (id, project_id, name, normalized_name, created_at, updated_at)
              VALUES ('review-version', '00000000-0000-7000-8000-000000000001', 'Review version', 'review version', '2026-09-29', '2026-09-29');
            INSERT INTO test_stages (id, project_id, project_version_id, name, normalized_name, position, created_at, updated_at)
              VALUES ('review-stage', '00000000-0000-7000-8000-000000000001', 'review-version', 'SIT', 'sit', 1, '2026-09-29', '2026-09-29');
            INSERT INTO ddt_cases (id, project_id, project_version_id, test_stage_id, case_id, case_id_normalized, sr_num, sr_num_normalized, case_kind, data_json, source_name, revision, created_at, updated_at)
              VALUES ('formal-case', '00000000-0000-7000-8000-000000000001', 'review-version', 'review-stage', 'CASE-1', 'case-1', 'SR', 'sr', 'standard', '{"CaseID":"CASE-1","srNum":"SR","account":"formal"}', 'fixture', 3, '2026-09-29', '2026-09-29');
            INSERT INTO ddt_debug_cases (id, project_id, project_version_id, test_stage_id, owner_user_id, case_id, case_id_normalized, data_json, source_name, revision, created_at, updated_at)
              VALUES ('personal-case', '00000000-0000-7000-8000-000000000001', 'review-version', 'review-stage', 'review-owner', 'CASE-1', 'case-1', '{"CaseID":"CASE-1","srNum":"SR","account":"private"}', 'personal', 2, '2026-09-29', '2026-09-29');
          `);
          const formalCases = await rows("SELECT * FROM ddt_cases");
          const personalCases = await rows("SELECT * FROM ddt_debug_cases");
          await execute("BEGIN");
          await execute(migrationSql);
          await expect(
            execute("SELECT * FROM missing_table_to_force_migration_failure"),
          ).rejects.toThrow();
          await execute("ROLLBACK");
          await expect(rows("SELECT * FROM ddt_change_requests")).rejects.toThrow();
          await execute("BEGIN");
          await execute(migrationSql);
          await execute("COMMIT");
          expect(await rows("SELECT * FROM ddt_cases")).toEqual(formalCases);
          expect(await rows("SELECT * FROM ddt_debug_cases")).toEqual(personalCases);
          expect(await rows("SELECT * FROM ddt_change_requests")).toEqual([]);
          expect(await rows("SELECT * FROM ddt_change_request_items")).toEqual([]);
        } finally {
          sqlite?.close();
          await client?.end();
          if (admin) {
            await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
            await admin.end();
          }
          await rm(directory, { recursive: true, force: true });
        }
      }, 30_000);
    },
  );
}
