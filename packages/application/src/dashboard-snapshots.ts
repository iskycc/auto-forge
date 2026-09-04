import type { DashboardSnapshot } from "@autoforge/contracts";

import type {
  CaseCatalogRepository,
  Clock,
  DashboardSnapshotRepository,
  PlatformOperationsRepository,
} from "./ports";
import { DASHBOARD_ANALYTICS_SAMPLE_LIMIT } from "./platform-operations";

const CURRENT_WINDOW_DAYS = 7;
const REFRESH_BATCH_SIZE = 25;

export type DashboardSnapshotScope = {
  projectId: string;
  projectVersionId: string;
  timeZone: string;
};

/**
 * 首页快照只是可重建的读模型。执行、用例和分析事实仍以各自仓储为准；
 * 缓存缺失时同步建立一次，之后由 Lite/Full worker 周期刷新。
 */
export class DashboardSnapshotService {
  private readonly pendingRefreshes = new Map<string, Promise<DashboardSnapshot>>();

  constructor(
    private readonly snapshots: DashboardSnapshotRepository,
    private readonly catalog: Pick<CaseCatalogRepository, "getDashboardSummary">,
    private readonly operations: Pick<PlatformOperationsRepository, "readAnalyticsOverview">,
    private readonly clock: Clock,
  ) {}

  async read(scope: DashboardSnapshotScope): Promise<DashboardSnapshot> {
    const existing = await this.snapshots.read(scope);
    return existing ?? this.refresh(scope);
  }

  async refreshTracked(limit = REFRESH_BATCH_SIZE): Promise<number> {
    const targets = await this.snapshots.listRefreshTargets(boundedRefreshLimit(limit));
    for (const target of targets) await this.refresh(target);
    return targets.length;
  }

  async refresh(scope: DashboardSnapshotScope): Promise<DashboardSnapshot> {
    const key = `${scope.projectId}:${scope.projectVersionId}:${scope.timeZone}`;
    const pending = this.pendingRefreshes.get(key);
    if (pending) return pending;
    const refresh = this.buildAndPersist(scope).finally(() => this.pendingRefreshes.delete(key));
    this.pendingRefreshes.set(key, refresh);
    return refresh;
  }

  private async buildAndPersist(scope: DashboardSnapshotScope): Promise<DashboardSnapshot> {
    const now = this.clock.now();
    const currentStartedAt = daysBefore(now, CURRENT_WINDOW_DAYS);
    const previousStartedAt = daysBefore(now, CURRENT_WINDOW_DAYS * 2);
    const generatedAt = now.toISOString();
    const baseFilter = {
      projectId: scope.projectId,
      projectVersionId: scope.projectVersionId,
      timeZone: scope.timeZone,
    } as const;
    const [catalog, currentAnalytics, previousAnalytics] = await Promise.all([
      this.catalog.getDashboardSummary([scope.projectId]),
      this.operations.readAnalyticsOverview({
        filter: { ...baseFilter, completedAfter: currentStartedAt },
        projectIds: [scope.projectId],
        generatedAt,
        maximumFacts: DASHBOARD_ANALYTICS_SAMPLE_LIMIT,
      }),
      this.operations.readAnalyticsOverview({
        filter: {
          ...baseFilter,
          completedAfter: previousStartedAt,
          completedBefore: currentStartedAt,
        },
        projectIds: [scope.projectId],
        generatedAt,
        maximumFacts: DASHBOARD_ANALYTICS_SAMPLE_LIMIT,
      }),
    ]);
    const snapshot: DashboardSnapshot = {
      schemaVersion: 1,
      ...scope,
      catalog,
      currentAnalytics,
      previousAnalytics,
      refreshedAt: generatedAt,
    };
    await this.snapshots.write(snapshot);
    return snapshot;
  }
}

function daysBefore(value: Date, days: number): string {
  return new Date(value.getTime() - days * 86_400_000).toISOString();
}

function boundedRefreshLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1) return REFRESH_BATCH_SIZE;
  return Math.min(100, value);
}
