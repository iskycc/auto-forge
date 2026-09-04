import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { DashboardSnapshot } from "@autoforge/contracts";
import { describe, expect, it } from "vitest";

import { createSqliteDatabase } from "../src/database";
import { SqliteDashboardSnapshotRepository } from "../src/sqlite-dashboard-snapshot";

describe("SQLite dashboard snapshot repository", () => {
  it("persists a validated project/version snapshot and returns refresh targets", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-dashboard-snapshot-"));
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "autoforge.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    try {
      handle.client
        .prepare(
          `INSERT INTO project_versions
            (id,project_id,name,normalized_name,status,revision,created_at,updated_at)
           VALUES (?,?,?,?, 'active',1,?,?)`,
        )
        .run(
          "00000000-0000-7000-8200-000000000001",
          "00000000-0000-7000-8000-000000000001",
          "Dashboard version",
          "dashboard version",
          "2026-09-04T08:00:00.000Z",
          "2026-09-04T08:00:00.000Z",
        );
      const repository = new SqliteDashboardSnapshotRepository(handle);
      const snapshot = dashboardSnapshot();
      await repository.write(snapshot);
      await expect(repository.read(snapshot)).resolves.toEqual(snapshot);
      await expect(repository.listRefreshTargets(10)).resolves.toEqual([
        {
          projectId: snapshot.projectId,
          projectVersionId: snapshot.projectVersionId,
          timeZone: snapshot.timeZone,
        },
      ]);
      await expect(repository.read({ ...snapshot, timeZone: "UTC" })).resolves.toBeNull();
    } finally {
      handle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function dashboardSnapshot(): DashboardSnapshot {
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
    projectVersionId: "00000000-0000-7000-8200-000000000001",
    timeZone: "Asia/Shanghai",
    catalog: { sourceCount: 1, caseCount: 2, methodCount: 3, enabledMethodCount: 2 },
    currentAnalytics: analytics,
    previousAnalytics: analytics,
    refreshedAt: generatedAt,
  };
}
