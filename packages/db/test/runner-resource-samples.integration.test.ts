import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import type { RunnerRepository } from "@autoforge/application";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteRunnerRepository } from "../src/sqlite-runner";
import { PostgresRunnerRepository } from "../src/postgres-platform-repository";

const epoch = Date.parse("2026-09-24T00:00:00.000Z");
const atMinute = (minute: number) => new Date(epoch + minute * 60_000).toISOString();
const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;

type Harness = { repository: RunnerRepository; close(): Promise<void> };
async function harness(dialect: "sqlite" | "postgres"): Promise<Harness> {
  if (dialect === "postgres") {
    const handle = createPostgresDatabase({
      connectionString: postgresUrl!,
      migrationsFolder: resolve("packages/db/drizzle/postgresql"),
    });
    await handle.ready;
    return { repository: new PostgresRunnerRepository(handle), close: () => handle.close() };
  }
  const directory = await mkdtemp(join(tmpdir(), "runner-samples-"));
  const handle = createSqliteDatabase({
    databasePath: join(directory, "db.sqlite"),
    migrationsFolder: resolve("packages/db/drizzle/sqlite"),
  });
  return {
    repository: new SqliteRunnerRepository(handle),
    async close() {
      handle.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const dialect of ["sqlite", "postgres"] as const)
  describe.skipIf(dialect === "postgres" && !postgresUrl)(
    `${dialect} bounded Runner telemetry`,
    () => {
      it("samples once per minute, keeps 360 persistent slots and isolates nodes / time windows", async () => {
        const context = await harness(dialect);
        const repository = context.repository;
        const runnerId = randomUUID();
        const base = {
          runnerId,
          labels: [],
          capabilities: [],
          maxConcurrency: 8,
          busySlots: 3,
          agentVersion: "1.18.1",
          terminalEnabled: true,
        };
        const heartbeat = (minute: number, cpu = 25) =>
          repository.heartbeat({
            ...base,
            recordedAt: atMinute(minute),
            resourceSnapshot: {
              cpuUtilizationPercent: cpu,
              memoryUtilizationPercent: 50,
              loadAverage1m: 2.5,
              logicalCpuCount: 8,
              observedAt: atMinute(minute),
            },
          });
        try {
          await repository.register({
            ...base,
            id: runnerId,
            bootstrapTokenHash: randomUUID(),
            credentialHash: randomUUID(),
            name: "telemetry",
            os: "linux",
            architecture: "amd64",
            protocolVersion: 1,
            recordedAt: atMinute(0),
          });
          await repository.heartbeat({ ...base, recordedAt: atMinute(0) });
          expect(await repository.resourceSamples(runnerId, atMinute(0), atMinute(500))).toEqual(
            [],
          );
          await heartbeat(0);
          await heartbeat(0.25, 80);
          const first = await repository.resourceSamples(runnerId, atMinute(0), atMinute(500));
          expect(first).toEqual([
            {
              observedAt: atMinute(0),
              cpuUtilizationPercent: 25,
              memoryUtilizationPercent: 50,
              loadAverage1m: 2.5,
              logicalCpuCount: 8,
              busySlots: 3,
              maxConcurrency: 8,
            },
          ]);
          expect(
            (await repository.get(runnerId, atMinute(-1)))?.resourceSnapshot?.cpuUtilizationPercent,
          ).toBe(80);
          for (let minute = 1; minute <= 361; minute++) await heartbeat(minute);
          await heartbeat(1, 99); // delayed earlier heartbeat must not overwrite the reused ring slot
          const retained = await repository.resourceSamples(runnerId, atMinute(0), atMinute(500));
          expect(retained).toHaveLength(360);
          expect(retained[0]?.observedAt).toBe(atMinute(2));
          expect(retained.at(-1)?.observedAt).toBe(atMinute(361));
          expect(retained.at(-1)?.cpuUtilizationPercent).toBe(25);
          expect(
            await repository.resourceSamples(randomUUID(), atMinute(0), atMinute(500)),
          ).toEqual([]);
          expect(
            await repository.resourceSamples(runnerId, atMinute(360), atMinute(360)),
          ).toHaveLength(1);
          expect(
            await repository.resourceSamples(runnerId, atMinute(1000), atMinute(1360)),
          ).toEqual([]);
          await repository.deregister({ runnerId, deregisteredAt: atMinute(362) });
          await repository.purge({ runnerId, purgedAt: atMinute(363) });
          expect(await repository.resourceSamples(runnerId, atMinute(0), atMinute(500))).toEqual(
            [],
          );
        } finally {
          await context.close();
        }
      });
    },
  );

for (const dialect of ["sqlite", "postgres"] as const)
  describe.skipIf(dialect === "postgres" && !postgresUrl)(
    `${dialect} resource history upgrade`,
    // This covers the entire historical schema plus failed and successful upgrades.
    { timeout: 30_000 },
    () => {
      it("upgrades an existing runner, rolls back a failed migration and starts with no invented samples", async () => {
        const database = await legacyDatabase(dialect);
        const migrations = resolve(
          `packages/db/drizzle/${dialect === "sqlite" ? "sqlite" : "postgresql"}`,
        );
        const migrationName =
          dialect === "sqlite"
            ? "0071_runner_resource_samples.sql"
            : "0069_runner_resource_samples.sql";
        try {
          for (const file of (await readdir(migrations))
            .filter((name) => name.endsWith(".sql") && name < migrationName)
            .sort())
            await database.execute(await readFile(join(migrations, file), "utf8"));
          await database.execute(
            `INSERT INTO runners (id, credential_hash, name, os, architecture, agent_version, protocol_version, labels_json, max_concurrency, busy_slots, last_seen_at, created_at, updated_at) VALUES ('upgrade', 'hash', 'upgrade', 'linux', 'amd64', '1.18.1', 1, '[]', 4, 0, '${atMinute(0)}', '${atMinute(0)}', '${atMinute(0)}')`,
          );
          const migration = await readFile(join(migrations, migrationName), "utf8");
          await database.execute("BEGIN");
          await database.execute(migration);
          await expect(
            database.execute("SELECT * FROM invalid_migration_fixture"),
          ).rejects.toThrow();
          await database.execute("ROLLBACK");
          await expect(database.query("SELECT * FROM runner_resource_samples")).rejects.toThrow();
          expect(await database.query("SELECT name FROM runners WHERE id = 'upgrade'")).toEqual([
            { name: "upgrade" },
          ]);
          await database.execute(migration);
          expect(await database.query("SELECT * FROM runner_resource_samples")).toEqual([]);
          await database.execute(
            `UPDATE runners SET metrics_observed_at = '${atMinute(1)}', cpu_utilization_percent = 10, memory_utilization_percent = 20, load_average_1m = 1, logical_cpu_count = 4 WHERE id = 'upgrade'`,
          );
          expect(await database.query("SELECT observed_at FROM runner_resource_samples")).toEqual([
            { observed_at: atMinute(1) },
          ]);
        } finally {
          await database.close();
        }
      });
    },
  );

async function legacyDatabase(dialect: "sqlite" | "postgres") {
  if (dialect === "sqlite") {
    const directory = await mkdtemp(join(tmpdir(), "runner-history-upgrade-"));
    const client = new Database(join(directory, "db.sqlite"));
    client.pragma("foreign_keys = ON");
    return {
      execute: async (sql: string) => {
        client.exec(sql);
      },
      query: async (sql: string) => client.prepare(sql).all(),
      close: async () => {
        client.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const name = `runner_history_${randomUUID().replaceAll("-", "")}`;
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
    query: async (sql: string) => (await client.query(sql)).rows as unknown[],
    close: async () => {
      await client.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
