import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { runSqliteMigrations } from "../src/migrations";
import { createPostgresDatabase } from "../src/postgres-database";

for (const dialect of ["sqlite", "postgresql"] as const)
  describe.skipIf(dialect === "postgresql" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} rejected contact migration`,
    () => {
      it("upgrades the previous release without changing Runner identity and rolls back failed DDL", async () => {
        const directory = await mkdtemp(resolve(tmpdir(), "rejected-migration-"));
        const migration =
          dialect === "sqlite"
            ? "0100_runner_rejected_contacts.sql"
            : "0099_runner_rejected_contacts.sql";
        const source = resolve(`packages/db/drizzle/${dialect}`);
        for (const name of (await readdir(source)).filter(
          (name) => name.endsWith(".sql") && name < migration,
        ))
          await writeFile(resolve(directory, name), await readFile(resolve(source, name)));
        const sql = await readFile(resolve(source, migration), "utf8");
        const sqlite = dialect === "sqlite" ? new Database(":memory:") : undefined;
        const admin =
          dialect === "postgresql"
            ? new Client({ connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL! })
            : undefined;
        const schema = `rejected_migration_${randomUUID().replaceAll("-", "")}`;
        let client: Client | undefined;
        try {
          if (sqlite) {
            sqlite.pragma("foreign_keys=ON");
            runSqliteMigrations(sqlite, directory);
          }
          if (admin) {
            await admin.connect();
            await admin.query(`CREATE SCHEMA ${schema}`);
            const url = new URL(process.env.AUTOFORGE_TEST_POSTGRES_URL!);
            url.searchParams.set("options", `-c search_path=${schema}`);
            const previous = createPostgresDatabase({
              connectionString: url.toString(),
              migrationsFolder: directory,
              poolMax: 1,
            });
            await previous.ready;
            await previous.close();
            client = new Client({ connectionString: url.toString() });
            await client.connect();
          }
          const execute = async (statement: string) => {
            if (sqlite) sqlite.exec(statement);
            else await client!.query(statement);
          };
          const rows = async (statement: string) =>
            sqlite ? sqlite.prepare(statement).all() : (await client!.query(statement)).rows;
          const columns =
            "id,credential_hash,name,disabled,draining,os,architecture,agent_version,protocol_version,labels_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at,deregistered_at,purged_at";
          await execute(
            `INSERT INTO runners (${columns}) VALUES ('preserved-runner','purged:preserved-runner','History Runner',TRUE,FALSE,'linux','amd64','1.22.11',1,'[]',1,0,'2026-11-11','2026-11-11','2026-11-11','2026-11-11','2026-11-11')`,
          );
          const before = await rows("SELECT * FROM runners");
          await execute("BEGIN");
          await execute(sql);
          await expect(execute("SELECT * FROM deliberately_missing_table")).rejects.toThrow();
          await execute("ROLLBACK");
          await expect(rows("SELECT * FROM runner_rejected_contacts")).rejects.toThrow();
          await execute("BEGIN");
          await execute(sql);
          await execute("COMMIT");
          expect(await rows("SELECT * FROM runners")).toEqual(before);
          expect(await rows("SELECT * FROM runner_rejected_contacts")).toEqual([]);
        } finally {
          sqlite?.close();
          await client?.end();
          if (admin) {
            await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
            await admin.end();
          }
          await rm(directory, { recursive: true, force: true });
        }
      });
    },
  );
