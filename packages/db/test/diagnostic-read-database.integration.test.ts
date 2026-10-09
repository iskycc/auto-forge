import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";

const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !postgresUrl)(
    `${dialect} diagnostic read isolation`,
    () => {
      it("attaches without migration writes, reads committed diagnostics and rejects writes", async () => {
        const directory = await mkdtemp(join(tmpdir(), "diagnostic-reader-"));
        const migrationsFolder = resolve(
          `packages/db/drizzle/${dialect === "sqlite" ? "sqlite" : "postgresql"}`,
        );
        const eventId = randomUUID();
        if (dialect === "sqlite") {
          const databasePath = join(directory, "platform.sqlite");
          const writer = createSqliteDatabase({ databasePath, migrationsFolder });
          try {
            writer.client
              .prepare(
                "INSERT INTO scheduling_events (id, batch_id, event_type, message, recorded_at) VALUES (?, 'batch', 'batch_scheduled', 'committed', '2026-10-09T00:00:00.000Z')",
              )
              .run(eventId);
            writer.client.exec("BEGIN IMMEDIATE");
            // A new reader must not run even an already-applied migration's BEGIN IMMEDIATE.
            const reader = createSqliteDatabase({
              databasePath,
              migrationsFolder: "unused",
              access: "read-only",
              busyTimeoutMs: 25,
            });
            try {
              expect(
                reader.client
                  .prepare("SELECT message FROM scheduling_events WHERE id = ?")
                  .get(eventId),
              ).toEqual({ message: "committed" });
              expect(() =>
                reader.client.prepare("DELETE FROM scheduling_events WHERE id = ?").run(eventId),
              ).toThrow();
            } finally {
              reader.close();
            }
            writer.client.exec("ROLLBACK");
          } finally {
            if (writer.client.inTransaction) writer.client.exec("ROLLBACK");
            writer.close();
            await rm(directory, { recursive: true, force: true });
          }
          return;
        }
        const writer = createPostgresDatabase({
          connectionString: postgresUrl!,
          migrationsFolder,
          poolMax: 1,
        });
        let reader: ReturnType<typeof createPostgresDatabase> | undefined;
        try {
          await writer.ready;
          await writer.pool.query(
            "INSERT INTO scheduling_events (id, batch_id, event_type, message, recorded_at) VALUES ($1, 'batch', 'batch_scheduled', 'committed', '2026-10-09T00:00:00.000Z')",
            [eventId],
          );
          reader = createPostgresDatabase({
            connectionString: postgresUrl!,
            migrationsFolder: "unused",
            access: "read-only",
            poolMax: 1,
            statementTimeoutMs: 4_000,
            lockTimeoutMs: 25,
          });
          await reader.ready;
          expect(
            (
              await reader.pool.query("SELECT message FROM scheduling_events WHERE id = $1", [
                eventId,
              ])
            ).rows,
          ).toEqual([{ message: "committed" }]);
          await expect(
            reader.pool.query("DELETE FROM scheduling_events WHERE id = $1", [eventId]),
          ).rejects.toMatchObject({ code: "25006" });
        } finally {
          await reader?.close();
          await writer.pool.query("DELETE FROM scheduling_events WHERE id = $1", [eventId]);
          await writer.close();
          await rm(directory, { recursive: true, force: true });
        }
      });

      it.each([
        {
          sqlite: "0077_scheduling_events_batch_runner_index.sql",
          postgres: "0075_scheduling_events_batch_runner_index.sql",
          index: "scheduling_events_batch_runner_idx",
        },
        {
          sqlite: "0078_execution_export_order_index.sql",
          postgres: "0076_execution_export_order_index.sql",
          index: "execution_runs_batch_export_order_idx",
        },
      ])(
        "upgrades $index, rolls back failed creation and preserves history",
        async (indexMigration) => {
          const database = await legacyDatabase(dialect);
          const migrations = resolve(
            `packages/db/drizzle/${dialect === "sqlite" ? "sqlite" : "postgresql"}`,
          );
          const migrationName = indexMigration[dialect];
          try {
            for (const file of (await readdir(migrations))
              .filter((name) => name.endsWith(".sql") && name < migrationName)
              .sort())
              await database.execute(await readFile(join(migrations, file), "utf8"));
            await database.execute(
              "INSERT INTO scheduling_events (id, batch_id, runner_id, event_type, message, recorded_at) VALUES ('old-event', 'batch', 'runner', 'run_assigned', 'historical log', '2026-10-09T00:00:00.000Z')",
            );
            const previous = await database.query("SELECT * FROM scheduling_events");
            const migration = await readFile(join(migrations, migrationName), "utf8");
            const indexes =
              dialect === "sqlite"
                ? `SELECT name FROM sqlite_master WHERE type = 'index' AND name = '${indexMigration.index}'`
                : `SELECT indexname AS name FROM pg_indexes WHERE indexname = '${indexMigration.index}'`;
            await database.execute("BEGIN");
            await database.execute(migration);
            await expect(
              database.execute("SELECT * FROM diagnostic_migration_failure_fixture"),
            ).rejects.toThrow();
            await database.execute("ROLLBACK");
            expect(await database.query(indexes)).toEqual([]);
            expect(await database.query("SELECT * FROM scheduling_events")).toEqual(previous);
            await database.execute(migration);
            expect(await database.query(indexes)).toEqual([{ name: indexMigration.index }]);
            expect(await database.query("SELECT * FROM scheduling_events")).toEqual(previous);
          } finally {
            await database.close();
          }
        },
      );
    },
  );
}

async function legacyDatabase(dialect: "sqlite" | "postgres") {
  if (dialect === "sqlite") {
    const directory = await mkdtemp(join(tmpdir(), "diagnostic-index-upgrade-"));
    const client = new Database(join(directory, "platform.sqlite"));
    client.pragma("foreign_keys = ON");
    return {
      execute: async (sql: string) => {
        client.exec(sql);
      },
      query: async (sql: string): Promise<unknown[]> => client.prepare(sql).all(),
      close: async () => {
        client.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const name = `diagnostic_index_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: postgresUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(postgresUrl!);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  return {
    execute: async (sql: string) => {
      await client.query(sql);
    },
    query: async (sql: string): Promise<unknown[]> => (await client.query(sql)).rows as unknown[],
    close: async () => {
      await client.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
