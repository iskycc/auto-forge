import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { DashboardSnapshot } from "@autoforge/contracts";
import { describe, expect, it } from "vitest";

import { PostgresDashboardSnapshotRepository } from "../src/postgres-dashboard-snapshot";
import { createPostgresDatabase } from "../src/postgres-database";

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;

describe.skipIf(!connectionString)("PostgreSQL dashboard snapshot repository", () => {
  it("persists the same validated snapshot contract as Lite", async () => {
    const handle = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    await handle.ready;
    const suffix = randomUUID();
    const projectVersionId = `dashboard-version-${suffix}`;
    try {
      await handle.pool.query(
        `INSERT INTO project_versions
          (id,project_id,name,normalized_name,status,revision,created_at,updated_at)
         VALUES ($1,'00000000-0000-7000-8000-000000000001',$2,$2,'active',1,$3,$3)`,
        [projectVersionId, `dashboard-${suffix}`, "2026-09-04T08:00:00.000Z"],
      );
      const repository = new PostgresDashboardSnapshotRepository(handle);
      const snapshot = dashboardSnapshot(projectVersionId);
      await repository.write(snapshot);
      await expect(repository.read(snapshot)).resolves.toEqual(snapshot);
      await expect(repository.read({ ...snapshot, timeZone: "UTC" })).resolves.toBeNull();
    } finally {
      await handle.pool.query("DELETE FROM project_versions WHERE id=$1", [projectVersionId]);
      await handle.close();
    }
  });
});

function dashboardSnapshot(projectVersionId: string): DashboardSnapshot {
  const generatedAt = "2026-09-04T08:00:00.000Z";
  const analytics = {
    sampleCount: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    successRate: 0,
    failureRate: 0,
    skippedRate: 0,
    generatedAt,
    dimensions: { projects: [], suites: [], runners: [], outcomes: [] },
    trend: [],
    failures: [],
    flakyCases: [],
  };
  return {
    schemaVersion: 1,
    projectId: "00000000-0000-7000-8000-000000000001",
    projectVersionId,
    timeZone: "Asia/Shanghai",
    catalog: { sourceCount: 1, caseCount: 2, methodCount: 3, enabledMethodCount: 2 },
    currentAnalytics: analytics,
    previousAnalytics: analytics,
    refreshedAt: generatedAt,
  };
}
