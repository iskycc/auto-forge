import type { AnalyticsSummary } from "@autoforge/contracts";
import { hasPermission, type RunBatch, type Runner, type RunnerGroup } from "@autoforge/domain";
import {
  Activity,
  AlertTriangle,
  BookOpenText,
  CheckCircle2,
  CircleDashed,
  Clock3,
  FileArchive,
  UsersRound,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { CSSProperties } from "react";

import { PublicDashboard } from "@/components/public-dashboard";
import { currentIdentity, hasPermissionInAnyScope } from "@/lib/auth";
import {
  isActiveRunBatch,
  runBatchCompletionPercent,
  runBatchStatusLabel,
} from "@/lib/run-batch-presentation";
import { getPlatformServices } from "@/lib/services";
import { selectableProjectIds, selectedProjectId } from "@/lib/selected-project";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const services = await getPlatformServices();
  const identity = await currentIdentity();
  if (!identity) {
    const [statistics, setupRequired] = await Promise.all([
      services.publicStatistics.read(),
      services.identityAccess.setupRequired(),
    ]);
    return <PublicDashboard initialStatistics={statistics} setupRequired={setupRequired} />;
  }
  if (identity.user.forcePasswordChange) redirect("/account/security");
  const projects = await services.identities
    .listProjects(selectableProjectIds(identity))
    .catch(() => []);
  const activeProjectId = await selectedProjectId(identity, projects);
  const canReadCases = Boolean(
    activeProjectId && hasPermission(identity, "case.read", activeProjectId),
  );
  const canReadRuns = Boolean(
    activeProjectId && hasPermission(identity, "run.read", activeProjectId),
  );
  const caseProjectIds = canReadCases && activeProjectId ? [activeProjectId] : [];
  const runProjectIds = canReadRuns && activeProjectId ? [activeProjectId] : [];
  const canReadRunners = hasPermissionInAnyScope(identity, "runner.read");
  const canReadSources = Boolean(
    activeProjectId && hasPermission(identity, "case_source.read", activeProjectId),
  );
  const canManageSources = Boolean(
    activeProjectId && hasPermission(identity, "case_source.manage", activeProjectId),
  );
  const now = new Date();
  const currentWeekStartedAt = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const previousWeekStartedAt = new Date(now.getTime() - 14 * 86_400_000).toISOString();

  const [
    catalogSummary,
    runners,
    runnerGroups,
    recentBatches,
    recentSources,
    currentAnalytics,
    previousAnalytics,
  ] = await Promise.all([
    services.catalog.getDashboardSummary(caseProjectIds),
    canReadRunners ? services.runnerControl.list(500) : Promise.resolve([]),
    canReadRunners ? services.runnerGroups.list() : Promise.resolve([]),
    canReadRuns ? services.runBatches.list(8, runProjectIds) : Promise.resolve([]),
    canReadSources ? services.catalog.listRecentSources(5, caseProjectIds) : Promise.resolve([]),
    canReadRuns
      ? services.platformOperations.analytics(identity, {
          ...(runProjectIds?.[0] ? { projectId: runProjectIds[0] } : {}),
          completedAfter: currentWeekStartedAt,
        })
      : Promise.resolve(null),
    canReadRuns
      ? services.platformOperations.analytics(identity, {
          ...(runProjectIds?.[0] ? { projectId: runProjectIds[0] } : {}),
          completedAfter: previousWeekStartedAt,
          completedBefore: currentWeekStartedAt,
        })
      : Promise.resolve(null),
  ]);

  const activeBatch = recentBatches.find((batch) => isActiveRunBatch(batch.status));
  const onlineRunners = runners.filter((runner) => runner.state === "online");
  const qualityScore = currentAnalytics ? currentAnalytics.successRate * 100 : null;
  const previousQualityScore = previousAnalytics ? previousAnalytics.successRate * 100 : null;
  const qualityDelta =
    qualityScore === null || previousQualityScore === null
      ? null
      : qualityScore - previousQualityScore;
  const recentActivity = buildRecentActivity(recentBatches, recentSources);

  return (
    <div className="dashboard-page">
      <header className="dashboard-welcome">
        <h1>
          <span>{greeting(now)}，</span>
          <strong>{identity.user.displayName}</strong>
        </h1>
        <p>这里是自动化质量、执行进度和资源容量的实时概览。</p>
      </header>

      <section className="design-dashboard-grid" aria-label="工作台概览">
        <article className="card design-quality-card">
          <header className="design-card-heading">
            <div>
              <h2>本周质量</h2>
              <span className="dashboard-info" title="最近 7 天已确认 TestNG 方法结果">
                i
              </span>
            </div>
            <span className="dashboard-period">最近 7 天</span>
          </header>
          <div className="quality-score-row">
            <strong>
              {qualityScore === null || currentAnalytics?.sampleCount === 0
                ? "—"
                : qualityScore.toFixed(1)}
            </strong>
            <span>/ 100</span>
            {qualityDelta !== null && currentAnalytics && currentAnalytics.sampleCount > 0 ? (
              <b className={qualityDelta >= 0 ? "trend-positive" : "trend-negative"}>
                {qualityDelta >= 0 ? "↑" : "↓"} {Math.abs(qualityDelta).toFixed(1)}
              </b>
            ) : null}
          </div>
          <p className="quality-caption">
            {currentAnalytics?.sampleCount
              ? `基于 ${currentAnalytics.sampleCount} 次已确认执行样本`
              : "完成首轮执行后生成质量趋势"}
          </p>
          <QualityTrend analytics={currentAnalytics} />
          <div className="quality-metric-strip">
            <DashboardMetric
              label="总执行数"
              value={currentAnalytics?.sampleCount ?? 0}
              detail={`${currentAnalytics?.passed ?? 0} 个通过方法`}
              tone="info"
            />
            <DashboardMetric
              label="通过率"
              value={percent(currentAnalytics?.successRate ?? 0)}
              detail={
                qualityDelta === null
                  ? "暂无上周基线"
                  : `${qualityDelta >= 0 ? "↑" : "↓"} ${Math.abs(qualityDelta).toFixed(1)}%`
              }
              tone="success"
            />
            <DashboardMetric
              label="失败数"
              value={currentAnalytics?.failed ?? 0}
              detail={percent(currentAnalytics?.failureRate ?? 0)}
              tone="danger"
            />
            <DashboardMetric
              label="跳过数"
              value={currentAnalytics?.skipped ?? 0}
              detail={percent(currentAnalytics?.skippedRate ?? 0)}
              tone="warning"
            />
          </div>
        </article>

        {canReadRuns ? (
          <article className="card design-active-card">
            <header className="design-card-heading">
              <h2>活动执行</h2>
              <Link href="/execution-records">查看全部</Link>
            </header>
            {activeBatch ? (
              <>
                <div className="active-run-overview">
                  <div
                    aria-label={`活动执行共 ${activeBatch.totalRuns} 个用例：运行中 ${activeBatch.runningRuns}，通过 ${activeBatch.succeededRuns}，失败 ${activeBatch.failedRuns + activeBatch.timedOutRuns}，排队中 ${activeBatch.queuedRuns}`}
                    className="active-run-donut"
                    role="img"
                    style={activeRunDonutStyle(activeBatch)}
                  >
                    <span>
                      <strong>{activeBatch.totalRuns}</strong>
                      <small>总计</small>
                    </span>
                  </div>
                  <dl>
                    <ActiveCount color="blue" label="运行中" value={activeBatch.runningRuns} />
                    <ActiveCount color="green" label="通过" value={activeBatch.succeededRuns} />
                    <ActiveCount
                      color="orange"
                      label="失败"
                      value={activeBatch.failedRuns + activeBatch.timedOutRuns}
                    />
                    <ActiveCount color="violet" label="排队中" value={activeBatch.queuedRuns} />
                  </dl>
                </div>
                <Link className="active-batch-summary" href={`/run-batches/${activeBatch.id}`}>
                  <span className="active-batch-icon">
                    <Activity size={17} />
                  </span>
                  <span>
                    <strong>{activeBatch.suiteName}</strong>
                    <small>
                      {runBatchStatusLabel(activeBatch.status)} ·{" "}
                      {activeBatch.selectedRunnerIds.length} 台执行机
                    </small>
                  </span>
                  <span className="active-batch-progress">
                    <b>{runBatchCompletionPercent(activeBatch)}%</b>
                    <i>
                      <em style={{ width: `${runBatchCompletionPercent(activeBatch)}%` }} />
                    </i>
                  </span>
                </Link>
              </>
            ) : (
              <div className="design-empty-state">
                <CircleDashed size={28} />
                <strong>当前没有活动执行</strong>
                <p>点击顶栏“开始执行”，选择任务或单个用例。</p>
              </div>
            )}
          </article>
        ) : null}

        <article className="card design-library-card">
          <header className="design-card-heading">
            <h2>用例库</h2>
            <Link href="/cases">查看全部</Link>
          </header>
          <dl className="design-stat-list">
            <LibraryCount icon={BookOpenText} label="用例总数" value={catalogSummary.caseCount} />
            <LibraryCount
              icon={CheckCircle2}
              label="启用方法"
              value={catalogSummary.enabledMethodCount}
            />
            <LibraryCount icon={Activity} label="测试方法" value={catalogSummary.methodCount} />
            <LibraryCount icon={FileArchive} label="JAR 来源" value={catalogSummary.sourceCount} />
          </dl>
          <Link
            className="design-library-action"
            href={canManageSources ? "/cases/import" : "/cases"}
          >
            {canManageSources ? "+ 导入新用例" : "打开用例库"}
          </Link>
        </article>

        {canReadRunners ? (
          <article className="card design-runner-groups-card">
            <header className="design-card-heading">
              <div>
                <h2>执行机组</h2>
                <span className="runner-health-label">
                  <i /> 在线 {onlineRunners.length}/{runners.length}
                </span>
              </div>
              <Link href="/runners?section=groups">查看全部</Link>
            </header>
            {runnerGroups.length === 0 ? (
              <div className="design-empty-state compact">
                <UsersRound size={25} />
                <strong>尚未配置执行机组</strong>
                <p>将执行机按机房或能力分组后，可在发起执行时整组选择。</p>
                <Link href="/runners?section=groups">创建执行机组</Link>
              </div>
            ) : (
              <div className="dashboard-runner-group-grid">
                {runnerGroups.slice(0, 6).map((group) => (
                  <RunnerGroupCard group={group} key={group.id} runners={runners} />
                ))}
              </div>
            )}
            <div className="runner-total-strip">
              <span>
                <small>总执行机</small>
                <strong>{runners.length}</strong>
              </span>
              <span>
                <small>在线</small>
                <strong>{onlineRunners.length}</strong>
              </span>
              <span>
                <small>离线</small>
                <strong>{runners.length - onlineRunners.length}</strong>
              </span>
              <span>
                <small>可用槽位</small>
                <strong>{availableRunnerSlots(runners)}</strong>
              </span>
            </div>
          </article>
        ) : null}

        {canReadRuns ? (
          <article className="card design-failure-card">
            <header className="design-card-heading">
              <h2>失败洞察</h2>
              <Link href="/insights">查看全部</Link>
            </header>
            <div className="failure-overview">
              <div
                aria-label={`本周失败率 ${percent(currentAnalytics?.failureRate ?? 0)}`}
                className="failure-donut"
                role="img"
                style={failureDonutStyle(currentAnalytics?.failures ?? [])}
              >
                <span>
                  <strong>{currentAnalytics?.failed ?? 0}</strong>
                  <small>失败方法</small>
                </span>
              </div>
              <div className="failure-reason-list">
                {(currentAnalytics?.failures ?? []).slice(0, 5).map((failure, index) => (
                  <div key={failure.signature}>
                    <i data-index={index} />
                    <span title={failure.description}>{failure.description}</span>
                    <strong>{failure.count}</strong>
                  </div>
                ))}
                {(currentAnalytics?.failures.length ?? 0) === 0 ? (
                  <p className="muted">本周暂无可聚类失败。</p>
                ) : null}
              </div>
            </div>
            <div className="failure-top-list">
              <strong>高频失败 TOP 3</strong>
              {(currentAnalytics?.failures ?? []).slice(0, 3).map((failure) => (
                <div key={failure.signature}>
                  <span title={failure.description}>{failure.description}</span>
                  <b>{failure.count} 次</b>
                </div>
              ))}
            </div>
          </article>
        ) : null}

        <article className="card design-recent-card">
          <header className="design-card-heading">
            <h2>最近动态</h2>
            <Link
              href={canReadRuns ? "/execution-records" : canReadSources ? "/objects" : "/cases"}
            >
              查看全部
            </Link>
          </header>
          {recentActivity.length === 0 ? (
            <div className="design-empty-state compact">
              <Clock3 size={25} />
              <strong>暂无最近动态</strong>
              <p>批次执行与用例导入会显示在这里。</p>
            </div>
          ) : (
            <div className="design-activity-list">
              {recentActivity.slice(0, 5).map((item) => (
                <Link href={item.href} key={`${item.kind}:${item.id}`}>
                  <span className={`design-activity-icon ${item.tone}`}>
                    {item.tone === "success" ? (
                      <CheckCircle2 size={16} />
                    ) : item.tone === "danger" ? (
                      <XCircle size={16} />
                    ) : item.tone === "warning" ? (
                      <AlertTriangle size={16} />
                    ) : item.kind === "source" ? (
                      <FileArchive size={16} />
                    ) : (
                      <Activity size={16} />
                    )}
                  </span>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.detail}</small>
                  </span>
                  <time dateTime={item.at}>{formatDate(item.at)}</time>
                </Link>
              ))}
            </div>
          )}
        </article>
      </section>
    </div>
  );
}

function QualityTrend({ analytics }: { analytics: AnalyticsSummary | null }) {
  const trend = analytics?.trend ?? [];
  if (trend.length === 0) return <div className="quality-chart-empty">暂无趋势数据</div>;
  const points = trend.map((bucket, index) => {
    const samples = bucket.passed + bucket.failed + bucket.skipped;
    const rate = samples === 0 ? 0 : (bucket.passed / samples) * 100;
    const x = trend.length === 1 ? 300 : 20 + (index / (trend.length - 1)) * 560;
    const y = 155 - rate * 1.25;
    return { x, y, label: bucket.bucket.slice(5, 10), rate };
  });
  const polyline = points.map(({ x, y }) => `${x},${y}`).join(" ");
  const area = `20,165 ${polyline} 580,165`;
  return (
    <div className="quality-trend-chart" role="img" aria-label="最近七天通过率趋势">
      <svg aria-hidden="true" viewBox="0 0 600 175">
        {[40, 80, 120, 160].map((y) => (
          <line key={y} x1="20" x2="580" y1={y} y2={y} />
        ))}
        <polygon points={area} />
        <polyline points={polyline} />
        {points.map((point) => (
          <circle cx={point.x} cy={point.y} key={point.label} r="4" />
        ))}
      </svg>
      <div>
        {points.map((point) => (
          <span key={point.label} title={`${point.rate.toFixed(1)}%`}>
            {point.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function DashboardMetric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string | number;
  detail: string;
  tone: "info" | "success" | "danger" | "warning";
}) {
  return (
    <span>
      <small>{label}</small>
      <strong>{value}</strong>
      <em className={`metric-tone-${tone}`}>{detail}</em>
    </span>
  );
}

function ActiveCount({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div>
      <dt>
        <i className={`active-color-${color}`} /> {label}
      </dt>
      <dd>{value}</dd>
    </div>
  );
}

function LibraryCount({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof BookOpenText;
  label: string;
  value: number;
}) {
  return (
    <div>
      <dt>
        <span>
          <Icon size={15} />
        </span>
        {label}
      </dt>
      <dd>{value.toLocaleString("zh-CN")}</dd>
    </div>
  );
}

function RunnerGroupCard({ group, runners }: { group: RunnerGroup; runners: readonly Runner[] }) {
  const members = runners.filter((runner) => group.runnerIds.includes(runner.id));
  const totalSlots = members.reduce((sum, runner) => sum + runner.maxConcurrency, 0);
  const availableSlots = members
    .filter((runner) => runner.state === "online")
    .reduce((sum, runner) => sum + Math.max(0, runner.maxConcurrency - runner.busySlots), 0);
  const availablePercent = totalSlots === 0 ? 0 : Math.round((availableSlots / totalSlots) * 100);
  return (
    <Link href="/runners?section=groups">
      <span>
        <strong>{group.name}</strong>
        <i className={members.some((runner) => runner.state === "online") ? "online" : "offline"} />
      </span>
      <span>
        {availableSlots} / {totalSlots} 槽位 <b>{availablePercent}%</b>
      </span>
      <em>
        <i style={{ width: `${availablePercent}%` }} />
      </em>
    </Link>
  );
}

type RecentActivity = {
  id: string;
  kind: "batch" | "source";
  title: string;
  detail: string;
  at: string;
  href: string;
  tone: "success" | "danger" | "warning" | "info";
};

function buildRecentActivity(
  batches: readonly RunBatch[],
  sources: readonly {
    id: string;
    displayName: string;
    classCount: number;
    methodCount: number;
    createdAt: string;
  }[],
): RecentActivity[] {
  return [
    ...batches.map((batch): RecentActivity => ({
      id: batch.id,
      kind: "batch",
      title:
        batch.status === "succeeded"
          ? `执行完成 · ${batch.suiteName}`
          : batch.status === "failed"
            ? `执行失败 · ${batch.suiteName}`
            : `执行${runBatchStatusLabel(batch.status)} · ${batch.suiteName}`,
      detail: `通过 ${batch.succeededRuns} / ${batch.totalRuns} · 失败 ${batch.failedRuns + batch.timedOutRuns}`,
      at: batch.updatedAt,
      href: `/run-batches/${batch.id}`,
      tone:
        batch.status === "succeeded"
          ? "success"
          : batch.status === "failed"
            ? "danger"
            : isActiveRunBatch(batch.status)
              ? "info"
              : "warning",
    })),
    ...sources.map((source): RecentActivity => ({
      id: source.id,
      kind: "source",
      title: `导入用例 · ${source.displayName}`,
      detail: `${source.classCount} 个测试类 · ${source.methodCount} 个方法`,
      at: source.createdAt,
      href: `/case-sources/${source.id}`,
      tone: "info",
    })),
  ].sort((left, right) => right.at.localeCompare(left.at));
}

function availableRunnerSlots(runners: readonly Runner[]): number {
  return runners
    .filter((runner) => runner.state === "online")
    .reduce((sum, runner) => sum + Math.max(0, runner.maxConcurrency - runner.busySlots), 0);
}

function activeRunDonutStyle(batch: RunBatch): CSSProperties {
  return {
    background: conicGradient(
      [
        { count: batch.runningRuns, color: "var(--color-info)" },
        { count: batch.succeededRuns, color: "var(--color-success)" },
        { count: batch.failedRuns + batch.timedOutRuns, color: "var(--color-danger)" },
        { count: batch.queuedRuns, color: "var(--color-violet)" },
      ],
      batch.totalRuns,
      "#e8eef6",
    ),
  };
}

function failureDonutStyle(failures: AnalyticsSummary["failures"]): CSSProperties {
  const palette = [
    "var(--color-danger)",
    "#ff9f0a",
    "#ffcc00",
    "var(--color-violet)",
    "var(--color-text-tertiary)",
  ];
  const segments = failures.slice(0, palette.length).map((failure, index) => ({
    count: failure.count,
    color: palette[index]!,
  }));
  return {
    background: conicGradient(
      segments,
      segments.reduce((total, segment) => total + segment.count, 0),
      "#ebedf0",
    ),
  };
}

function conicGradient(
  segments: ReadonlyArray<{ count: number; color: string }>,
  total: number,
  remainderColor: string,
): string {
  if (total <= 0) return remainderColor;
  let cursor = 0;
  const stops = segments.flatMap((segment) => {
    if (segment.count <= 0) return [];
    const start = cursor;
    cursor = Math.min(360, cursor + (segment.count / total) * 360);
    return `${segment.color} ${start.toFixed(2)}deg ${cursor.toFixed(2)}deg`;
  });
  if (cursor < 360) stops.push(`${remainderColor} ${cursor.toFixed(2)}deg 360deg`);
  return stops.length > 0 ? `conic-gradient(${stops.join(", ")})` : remainderColor;
}

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
