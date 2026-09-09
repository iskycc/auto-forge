import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} SR mapping upgrade`,
    () => {
      it("preserves uniform and recycled associations, marks ambiguity and rolls back failed upgrades", async () => {
        const database = await legacyDatabase(dialect);
        const folder = resolve(
          import.meta.dirname,
          `../drizzle/${dialect === "sqlite" ? "sqlite" : "postgresql"}`,
        );
        const migrationName =
          dialect === "sqlite" ? "0068_ddt_sr_execution.sql" : "0066_ddt_sr_execution.sql";
        const enabled = dialect === "sqlite" ? "1" : "TRUE";
        const disabled = dialect === "sqlite" ? "0" : "FALSE";
        const project = "00000000-0000-7000-8000-000000000001";
        const timestamp = "2026-09-01T00:00:00.000Z";
        try {
          for (const file of (await readdir(folder))
            .filter((name) => name.endsWith(".sql") && name < migrationName)
            .sort())
            await database.execute(await readFile(resolve(folder, file), "utf8"));
          await database.execute(`
      INSERT INTO project_versions (id, project_id, name, normalized_name, created_at, updated_at)
      VALUES ('version','${project}','v1','v1','${timestamp}','${timestamp}');
      INSERT INTO test_stages (id, project_id, project_version_id, name, normalized_name, position, created_at, updated_at)
      VALUES ('stage','${project}','version','stage','stage',0,'${timestamp}','${timestamp}');
      INSERT INTO case_sources (id,project_id,project_version_id,test_stage_id,display_name,original_file_name,object_key,sha256,size_bytes,class_count,method_count,status,warnings_json,inspection_json,authoritative,lifecycle_status,revision,created_at,updated_at)
      VALUES ('source','${project}','version','stage','Source','s.jar','jars/s.jar','${"a".repeat(64)}',128,2,2,'ready','[]','{}',${enabled},'active',1,'${timestamp}','${timestamp}');
    `);
          for (const id of ["class-a", "class-b"])
            await database.execute(`
      INSERT INTO case_definitions (id,project_id,project_version_id,test_stage_id,directory_path,source_id,class_name,package_name,display_name,description,tags_json,parameters_json,enabled,archived,revision,groups_json,current_version,created_at,updated_at)
      VALUES ('${id}','${project}','version','stage','example','source','example.${id}','example','${id}','','[]','{}',${enabled},${disabled},1,'[]',1,'${timestamp}','${timestamp}');
    `);
          for (const [id, sr, definition] of [
            ["case-a", "uniform", "class-a"],
            ["case-b", "uniform", "class-a"],
            ["case-c", "ambiguous", "class-a"],
            ["case-d", "ambiguous", "class-b"],
            ["case-e", "unassigned", null],
          ] as const) {
            await database.execute(`INSERT INTO ddt_cases (id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,revision,created_at,updated_at,execution_case_definition_id)
      VALUES ('${id}','${project}','version','stage','${id}','${id}','${sr}','${sr}','standard','{}',7,'${timestamp}','${timestamp}',${definition ? "'" + definition + "'" : "NULL"});`);
          }
          await database.execute(`INSERT INTO ddt_deleted_cases (id,ddt_case_id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,case_created_at,case_updated_at,deleted_at,execution_case_definition_id)
      VALUES ('recycled','deleted','${project}','version','stage','deleted','deleted','recycled','recycled','standard','{}','${timestamp}','${timestamp}','${timestamp}','class-b');`);
          const original = await database.query(
            "SELECT id,execution_case_definition_id,revision FROM ddt_cases ORDER BY id",
          );
          const migration = await readFile(resolve(folder, migrationName), "utf8");
          await database.execute("BEGIN");
          await database.execute(migration);
          await expect(database.execute("SELECT * FROM missing_upgrade_fixture")).rejects.toThrow();
          await database.execute("ROLLBACK");
          await expect(database.query("SELECT * FROM ddt_sr_execution_mappings")).rejects.toThrow();
          expect(
            await database.query(
              "SELECT id,execution_case_definition_id,revision FROM ddt_cases ORDER BY id",
            ),
          ).toEqual(original);
          await database.execute("BEGIN");
          await database.execute(migration);
          await database.execute("COMMIT");
          expect(
            await database.query(
              "SELECT sr_num_normalized,execution_case_definition_id,legacy_conflict FROM ddt_sr_execution_mappings ORDER BY sr_num_normalized",
            ),
          ).toEqual([
            {
              sr_num_normalized: "ambiguous",
              execution_case_definition_id: null,
              legacy_conflict: 1,
            },
            {
              sr_num_normalized: "recycled",
              execution_case_definition_id: "class-b",
              legacy_conflict: 0,
            },
            {
              sr_num_normalized: "uniform",
              execution_case_definition_id: "class-a",
              legacy_conflict: 0,
            },
          ]);
          expect(
            await database.query(
              "SELECT execution_case_definition_id FROM ddt_execution_class_range ORDER BY execution_case_definition_id",
            ),
          ).toEqual([
            { execution_case_definition_id: "class-a" },
            { execution_case_definition_id: "class-b" },
          ]);
          expect(
            await database.query(
              "SELECT id,execution_case_definition_id,revision FROM ddt_cases ORDER BY id",
            ),
          ).toEqual(original);
        } finally {
          await database.dispose();
        }
      });
    },
  );
}

async function legacyDatabase(dialect: "sqlite" | "postgres") {
  if (dialect === "sqlite") {
    const directory = await mkdtemp(resolve(tmpdir(), "ddt-sr-migration-"));
    const database = new DatabaseSync(resolve(directory, "legacy.sqlite"));
    database.exec("PRAGMA foreign_keys = ON");
    return {
      execute: async (statement: string) => {
        database.exec(statement);
      },
      query: async (statement: string) => database.prepare(statement).all(),
      dispose: async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const databaseName = `ddt_sr_migration_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const connectionString = new URL(process.env.AUTOFORGE_TEST_POSTGRES_URL!);
  connectionString.pathname = `/${databaseName}`;
  const client = new Client({ connectionString: connectionString.toString() });
  await client.connect();
  return {
    execute: async (statement: string) => {
      await client.query(statement);
    },
    query: async (statement: string) =>
      (await client.query<Record<string, unknown>>(statement)).rows,
    dispose: async () => {
      await client.end();
      await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
      await admin.end();
    },
  };
}
