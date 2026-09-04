import type { AnalyticsSummary, DashboardSnapshot } from "@autoforge/contracts";
import { describe, expect, it, vi } from "vitest";

import { DashboardSnapshotService } from "../src/dashboard-snapshots";
import type {
  CaseCatalogRepository,
  DashboardSnapshotRepository,
  PlatformOperationsRepository,
} from "../src/ports";

const SCOPE = {
  projectId: "project-a",
  projectVersionId: "version-a",
  timeZone: "Asia/Shanghai",
} as const;
const NOW = new Date("2026-09-04T08:00:00.000Z");

describe("dashboard snapshots", () => {
  it("serves a persisted snapshot without querying dashboard facts again", async () => {
    const snapshot = dashboardSnapshot();
    const read = vi.fn().mockResolvedValue(snapshot);
    const catalogRead = vi.fn();
    const analyticsRead = vi.fn();
    const service = createService({ read, catalogRead, analyticsRead });

    await expect(service.read(SCOPE)).resolves.toEqual(snapshot);
    expect(catalogRead).not.toHaveBeenCalled();
    expect(analyticsRead).not.toHaveBeenCalled();
  });

  it("builds a missing snapshot once and refreshes tracked scopes in bounded batches", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const catalogRead = vi.fn().mockResolvedValue({
      sourceCount: 2,
      caseCount: 3,
      methodCount: 5,
      enabledMethodCount: 4,
    });
    const analyticsRead = vi.fn().mockResolvedValue(analyticsSummary());
    const listRefreshTargets = vi.fn().mockResolvedValue([SCOPE]);
    const service = createService({
      read: vi.fn().mockResolvedValue(null),
      write,
      listRefreshTargets,
      catalogRead,
      analyticsRead,
    });

    const snapshot = await service.read(SCOPE);
    expect(snapshot.catalog.enabledMethodCount).toBe(4);
    expect(analyticsRead).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledWith(snapshot);
    await expect(service.refreshTracked(1_000)).resolves.toBe(1);
    expect(listRefreshTargets).toHaveBeenCalledWith(100);
    expect(analyticsRead).toHaveBeenCalledTimes(4);
  });
});

function createService(input: {
  read: ReturnType<typeof vi.fn>;
  write?: ReturnType<typeof vi.fn>;
  listRefreshTargets?: ReturnType<typeof vi.fn>;
  catalogRead: ReturnType<typeof vi.fn>;
  analyticsRead: ReturnType<typeof vi.fn>;
}) {
  const snapshots = {
    read: input.read,
    write: input.write ?? vi.fn(),
    listRefreshTargets: input.listRefreshTargets ?? vi.fn(),
  } as unknown as DashboardSnapshotRepository;
  const catalog = {
    getDashboardSummary: input.catalogRead,
  } as unknown as CaseCatalogRepository;
  const operations = {
    readAnalyticsOverview: input.analyticsRead,
  } as unknown as PlatformOperationsRepository;
  return new DashboardSnapshotService(snapshots, catalog, operations, { now: () => NOW });
}

function dashboardSnapshot(): DashboardSnapshot {
  return {
    schemaVersion: 1,
    ...SCOPE,
    catalog: { sourceCount: 1, caseCount: 1, methodCount: 1, enabledMethodCount: 1 },
    currentAnalytics: analyticsSummary(),
    previousAnalytics: analyticsSummary(),
    refreshedAt: NOW.toISOString(),
  };
}

function analyticsSummary(): AnalyticsSummary {
  return {
    sampleCount: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    successRate: 0,
    failureRate: 0,
    skippedRate: 0,
    generatedAt: NOW.toISOString(),
    dimensions: { projects: [], suites: [], runners: [], outcomes: [] },
    trend: [],
    failures: [],
    flakyCases: [],
  };
}
