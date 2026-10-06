import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { RunBatchRepository } from "@autoforge/application";

import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteRunBatchRepository } from "../src/sqlite-run-batch";
import { PostgresRunBatchRepository } from "../src/postgres-run-batch";

const timestamp = "2026-10-06T00:00:00.000Z";
const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;

type SnapshotFixture = {
  batches: RunBatchRepository;
  execute(statement: string, parameters?: Array<string | number>): Promise<void>;
  close(): Promise<void>;
};

async function createFixture(mode: "sqlite" | "postgres"): Promise<SnapshotFixture> {
  if (mode === "sqlite") {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-log-snapshot-"));
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "test.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    return {
      batches: new SqliteRunBatchRepository(handle),
      execute: async (statement, parameters = []) => {
        handle.client.prepare(statement).run(...parameters);
      },
      close: async () => {
        handle.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const schema = `log_snapshot_${randomUUID().replaceAll("-", "")}`;
  const administration = new Pool({ connectionString: postgresUrl!, max: 1 });
  await administration.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(postgresUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const handle = createPostgresDatabase({
    connectionString: url.toString(),
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    poolMax: 2,
  });
  await handle.ready;
  return {
    batches: new PostgresRunBatchRepository(handle),
    execute: async (statement, parameters = []) => {
      let index = 0;
      await handle.pool.query(
        statement.replaceAll("?", () => `$${++index}`),
        parameters,
      );
    },
    close: async () => {
      await handle.close();
      await administration.query(`DROP SCHEMA ${schema} CASCADE`);
      await administration.end();
    },
  };
}

async function seedSnapshot(fixture: SnapshotFixture): Promise<void> {
  const runtime = JSON.stringify({
    suiteName: "Suite",
    testName: "Test",
    environmentAddresses: ["https://adapter.internal"],
    environmentAddressByRunId: Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [`run-${index}`, "https://adapter.internal"]),
    ),
    fallbackEnvironmentAddress: "",
    jarBundle: {
      id: "bundle",
      sourceType: "upload",
      sha256: "a".repeat(64),
      sizeBytes: 1,
      archiveFormat: "zip",
      createdAt: timestamp,
    },
  });
  await fixture.execute(
    `INSERT INTO run_batches
     (id, sequence_number, suite_id, suite_name, suite_version, status, retry_limit,
      total_runs, environment_json, adapter_runtime_json, created_at, updated_at)
     VALUES ('batch', 7, 'suite', 'Active task', 1, 'running', 3, 10000, '[]', ?, ?, ?)`,
    [runtime, timestamp, timestamp],
  );
  for (const [runId, caseType, displayName] of [
    ["run-testng", "testng", "Checkout"],
    ["run-ddt", "ddt", "DDT001"],
  ]) {
    await fixture.execute(
      `INSERT INTO execution_runs
       (id, batch_id, case_definition_id, case_version, display_name, class_name,
        case_type, status, attempt_count, created_at, updated_at)
       VALUES (?, 'batch', ?, 1, ?, 'example.Checkout', ?, 'succeeded', 1, ?, ?)`,
      [runId!, runId!, displayName!, caseType!, timestamp, timestamp],
    );
  }
  await fixture.execute(
    `WITH RECURSIVE members(n) AS (
       SELECT 1 UNION ALL SELECT n + 1 FROM members WHERE n < 9998
     )
     INSERT INTO execution_runs
       (id, batch_id, case_definition_id, case_version, display_name, class_name,
        status, created_at, updated_at)
     SELECT 'live-' || CAST(n AS TEXT), 'batch', 'live-' || CAST(n AS TEXT), 1,
            'Live case ' || CAST(n AS TEXT), 'example.Live', 'running', ?, ?
     FROM members`,
    [timestamp, timestamp],
  );
}

for (const mode of ["sqlite", "postgres"] as const) {
  describe.skipIf(mode === "postgres" && !postgresUrl)(`${mode} attempt log snapshot`, () => {
    it("reads TestNG/DDT execution facts without batch counters or rerun preparation", async () => {
      const fixture = await createFixture(mode);
      try {
        await seedSnapshot(fixture);
        const counters = vi.spyOn(fixture.batches, "getSummary");
        const rerun = vi.spyOn(fixture.batches, "getRerunSnapshot");
        for (const [runId, caseType, displayName] of [
          ["run-testng", "testng", "Checkout"],
          ["run-ddt", "ddt", "DDT001"],
        ]) {
          expect(await fixture.batches.getAttemptLogSnapshot("batch", runId!)).toEqual({
            batchId: "batch",
            batchSequenceNumber: 7,
            executionRunId: runId,
            displayName,
            className: "example.Checkout",
            caseType,
            dependencyUpdatedAt: timestamp,
          });
        }
        expect(await fixture.batches.getMetadata("batch")).toMatchObject({ status: "running" });
        expect(counters).not.toHaveBeenCalled();
        expect(rerun).not.toHaveBeenCalled();
      } finally {
        await fixture.close();
      }
    });

    it("rejects a case from another batch and preserves missing historical dependency dates", async () => {
      const fixture = await createFixture(mode);
      try {
        await seedSnapshot(fixture);
        expect(await fixture.batches.getAttemptLogSnapshot("other-batch", "run-testng")).toBeNull();
        expect(await fixture.batches.getAttemptLogSnapshot("batch", "missing-run")).toBeNull();
        await fixture.execute(
          "UPDATE run_batches SET adapter_runtime_json = NULL WHERE id = 'batch'",
        );
        expect(await fixture.batches.getAttemptLogSnapshot("batch", "run-testng")).toMatchObject({
          dependencyUpdatedAt: null,
        });
      } finally {
        await fixture.close();
      }
    });
  });
}
