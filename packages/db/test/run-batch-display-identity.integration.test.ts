import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { pgRunBatches } from "../src/postgres-schema";
import { PostgresRunBatchRepository } from "../src/postgres-run-batch";
import { runBatches } from "../src/schema";
import { SqliteRunBatchRepository } from "../src/sqlite-run-batch";

const postgresConnectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("run batch display identity lookup", () => {
  it("returns natural batch numbers without duplicates in SQLite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "autoforge-batch-identity-"));
    temporaryDirectories.push(directory);
    const handle = createSqliteDatabase({
      databasePath: join(directory, "autoforge.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    const repository = new SqliteRunBatchRepository(handle);
    try {
      handle.db
        .insert(runBatches)
        .values([batchRecord("sqlite-batch-1", 314), batchRecord("sqlite-batch-2", 0)])
        .run();

      await expect(
        repository.listDisplayIdentities([
          "sqlite-batch-1",
          "missing-batch",
          "sqlite-batch-1",
          "sqlite-batch-2",
        ]),
      ).resolves.toEqual([{ id: "sqlite-batch-1", sequenceNumber: 314 }]);
      await expect(repository.listDisplayIdentities([])).resolves.toEqual([]);
    } finally {
      handle.close();
    }
  });

  it.skipIf(!postgresConnectionString)(
    "returns natural batch numbers without duplicates in PostgreSQL",
    async () => {
      const handle = createPostgresDatabase({
        connectionString: postgresConnectionString!,
        migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
      });
      const suffix = randomUUID();
      const visibleBatchId = `postgres-visible-${suffix}`;
      const legacyBatchId = `postgres-legacy-${suffix}`;
      const repository = new PostgresRunBatchRepository(handle);
      try {
        await handle.ready;
        await handle.db
          .insert(pgRunBatches)
          .values([batchRecord(visibleBatchId, 271_828), batchRecord(legacyBatchId, 0)]);

        await expect(
          repository.listDisplayIdentities([
            visibleBatchId,
            "missing-batch",
            visibleBatchId,
            legacyBatchId,
          ]),
        ).resolves.toEqual([{ id: visibleBatchId, sequenceNumber: 271_828 }]);
        await expect(repository.listDisplayIdentities([])).resolves.toEqual([]);
      } finally {
        await handle.pool.query("DELETE FROM run_batches WHERE id = ANY($1::text[])", [
          [visibleBatchId, legacyBatchId],
        ]);
        await handle.close();
      }
    },
  );
});

function batchRecord(id: string, sequenceNumber: number) {
  return {
    id,
    sequenceNumber,
    suiteId: `suite-${id}`,
    suiteName: "Display identity fixture",
    suiteVersion: 1,
    status: "succeeded" as const,
    retryLimit: 0,
    environmentJson: "[]",
    totalRuns: 1,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
}
