import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqlitePlatformOperationsRepository } from "../src/sqlite-platform-operations";
import { PostgresPlatformOperationsRepository } from "../src/postgres-platform-operations";

const now = "2026-09-10T00:00:00.000Z";
for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} notification generation`,
    () => {
      it("advances past previously notified rows and performs no idle SQLite writes", async () => {
        const harness = await database(dialect);
        try {
          await harness.execute(`INSERT INTO users (id,username,normalized_username,display_name,source,status,created_at,updated_at)
          VALUES ('recipient','recipient','recipient','Recipient','local','active','${now}','${now}');
          INSERT INTO roles (id,role_key,name,description,scope,permissions_json,created_at,updated_at)
          VALUES ('notify-admin','notify-admin','Notify admin','','system','["settings.manage"]','${now}','${now}');
          INSERT INTO user_system_roles (user_id,role_id,assigned_at)
          SELECT 'recipient',id,'${now}' FROM roles WHERE permissions_json LIKE '%settings.manage%';`);
          for (let index = 0; index < 3; index++) {
            await harness.execute(`INSERT INTO cleanup_jobs (id,category,resource_type,resource_id,status,available_at,created_at,updated_at)
            VALUES ('cleanup-${index}','retention-artifact','artifact','artifact-${index}','dead_letter','${now}','${now}','${now}');`);
          }
          const input = { now, runnerOfflineBefore: now, limit: 1 };
          expect(await harness.repository.generateNotifications(input)).toBe(1);
          expect(await harness.repository.generateNotifications(input)).toBe(1);
          expect(await harness.repository.generateNotifications(input)).toBe(1);
          const release = harness.holdWriter();
          try {
            expect(await harness.repository.generateNotifications(input)).toBe(0);
          } finally {
            release();
          }
        } finally {
          await harness.close();
        }
      });
    },
  );
}

async function database(dialect: "sqlite" | "postgres") {
  const directory = await mkdtemp(resolve(tmpdir(), "notification-test-"));
  if (dialect === "sqlite") {
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "test.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    return {
      repository: new SqlitePlatformOperationsRepository(handle),
      holdWriter: () => {
        const writer = new Database(resolve(directory, "test.sqlite"));
        writer.exec("BEGIN IMMEDIATE");
        return () => {
          writer.exec("ROLLBACK");
          writer.close();
        };
      },
      execute: async (statement: string) => {
        handle.client.exec(statement);
      },
      close: async () => {
        handle.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const schema = `notification_${randomUUID().replaceAll("-", "")}`;
  const admin = createPostgresDatabase({
    connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!,
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
  });
  await admin.ready;
  await admin.pool.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.AUTOFORGE_TEST_POSTGRES_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const handle = createPostgresDatabase({
    connectionString: url.toString(),
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
  });
  await handle.ready;
  return {
    repository: new PostgresPlatformOperationsRepository(handle),
    holdWriter: () => () => undefined,
    execute: async (statement: string) => {
      await handle.pool.query(statement);
    },
    close: async () => {
      await handle.close();
      await admin.pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
