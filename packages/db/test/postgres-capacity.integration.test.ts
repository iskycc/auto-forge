import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createPostgresDatabase } from "../src/postgres-database";
import { PostgresCaseSuiteRepository } from "../src/postgres-platform-repository";
import { PostgresRunBatchRepository } from "../src/postgres-run-batch";

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const timestamp = "2026-08-21T00:00:00.000Z";

describe.skipIf(!connectionString)("PostgreSQL 100k task capacity", () => {
  it("persists 100,000 members in one task mutation", async () => {
    const handle = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    const repository = new PostgresCaseSuiteRepository(handle);
    const suffix = randomUUID();
    const sourceId = `capacity-source-${suffix}`;
    const suiteId = `capacity-suite-${suffix}`;
    const sha256 = createHash("sha256").update(suffix).digest("hex");
    try {
      await handle.ready;
      await handle.pool.query(
        `INSERT INTO case_sources
           (id, display_name, original_file_name, object_key, sha256, size_bytes,
            class_count, method_count, status, warnings_json, inspection_json,
            authoritative, lifecycle_status, revision, created_at, updated_at)
         VALUES ($1, 'capacity', 'capacity.jar', $2, $3, 1, 100000, 100000,
                 'ready', '[]', '{}', false, 'active', 1, $4, $4)`,
        [sourceId, `jars/${sourceId}.jar`, sha256, timestamp],
      );
      await handle.pool.query(
        `INSERT INTO case_definitions
           (id, source_id, class_name, package_name, display_name, enabled,
            groups_json, current_version, created_at, updated_at)
         SELECT 'capacity-case-' || $1 || '-' || lpad(value::text, 6, '0'), $2,
                'capacity.fixture.Test' || value, 'capacity.fixture', 'Case ' || value,
                true, '[]', 1, $3, $3
         FROM generate_series(0, 99999) AS value`,
        [suffix, sourceId, timestamp],
      );
      await repository.create({ id: suiteId, name: "100k capacity", createdAt: timestamp });
      const suite = await repository.addCases({
        suiteId,
        items: Array.from({ length: 100_000 }, (_, index) => ({
          id: `capacity-item-${suffix}-${index.toString().padStart(6, "0")}`,
          caseDefinitionId: `capacity-case-${suffix}-${index.toString().padStart(6, "0")}`,
        })),
        versionId: `capacity-suite-version-${suffix}`,
        updatedAt: timestamp,
      });

      expect(suite).toMatchObject({ caseCount: 100_000, version: 2, revision: 2 });
      const firstExportPage = await repository.listExportRowsPage({
        suiteId,
        memberType: "standard",
        limit: 1_000,
        projectIds: ["00000000-0000-7000-8000-000000000001"],
      });
      expect(firstExportPage).toHaveLength(1_000);
      expect(firstExportPage[0]).toMatchObject({
        casePath: "capacity.fixture.Test0",
        displayName: "Case 0",
      });
      await expect(
        repository.listExportRowsPage({
          suiteId,
          memberType: "standard",
          afterMemberId: firstExportPage.at(-1)!.memberId,
          limit: 1_000,
          projectIds: ["00000000-0000-7000-8000-000000000001"],
        }),
      ).resolves.toHaveLength(1_000);
    } finally {
      await handle.pool.query("DELETE FROM case_suites WHERE id = $1", [suiteId]);
      await handle.pool.query("DELETE FROM case_sources WHERE id = $1", [sourceId]);
      await handle.close();
    }
  }, 120_000);

  it("persists a 100,000-run batch and returns a bounded scheduling window", async () => {
    const handle = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    const repository = new PostgresRunBatchRepository(handle);
    const suffix = randomUUID();
    const batchId = `capacity-batch-${suffix}`;
    try {
      await handle.ready;
      const batch = await repository.create({
        id: batchId,
        suiteId: `capacity-suite-${suffix}`,
        suiteName: "100k capacity",
        suiteVersion: 1,
        retryLimit: 0,
        environmentVariables: [],
        runnerIds: [],
        runs: Array.from({ length: 100_000 }, (_, index) => ({
          id: `capacity-run-${suffix}-${index.toString().padStart(6, "0")}`,
          caseDefinitionId: `capacity-case-${suffix}-${index.toString().padStart(6, "0")}`,
          caseVersion: 1,
          displayName: `Case ${index}`,
          className: `capacity.fixture.Test${index}`,
        })),
        createdAt: timestamp,
      });
      const snapshot = await repository.getSchedulingSnapshot(batchId, "2026-08-20T23:59:00.000Z");

      expect(batch).toMatchObject({ totalRuns: 100_000, queuedRuns: 100_000 });
      expect(snapshot?.queuedRuns).toHaveLength(4_096);
      expect(snapshot?.batch).toMatchObject({ totalRuns: 100_000, queuedRuns: 100_000 });
    } finally {
      await handle.pool.query("DELETE FROM run_batches WHERE id = $1", [batchId]);
      await handle.close();
    }
  }, 120_000);
});
