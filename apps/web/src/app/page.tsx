import type { AnalyticsSummary } from "@autoforge/contracts";
import { DASHBOARD_ANALYTICS_SAMPLE_LIMIT } from "@autoforge/application";
import { hasPermission, type RunBatch, type Runner, type RunnerGroup } from "@autoforge/domain";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  BookOpenText,
  Boxes,
  CheckCircle2,
  CircleDashed,
  Clock3,
  FileArchive,
  Gauge,
  Layers3,
  SearchCheck,
  ServerCog,
  Sparkles,
  TimerReset,
  UsersRound,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";

import { PublicDashboard } from "@/components/public-dashboard";
import { currentIdentity, hasPermissionInAnyScope } from "@/lib/auth";
import {
  isActiveRunBatch,
  runBatchCompletionPercent,
  runBatchPassRate,
  runBatchStatusLabel,
} from "@/lib/run-batch-presentation";
import { getPlatformServices } from "@/lib/services";
import {
  selectableProjectIds,
  selectedProjectHierarchy,
  selectedProjectId,
} from "@/lib/selected-project";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import {
  calculateQualityDelta,
  selectDashboardFocus,
  summarizeActiveRuns,
  summarizeRunnerCapacity,
  type ActiveRunSummary,
} from "@/lib/dashboard-presentation";

export const dynamic = "force-dynamic";

const DASHBOARD_RUN_BATCH_LIMIT = 8;
const DASHBOARD_RUNNER_GROUP_LIMIT = 6;

export default async function DashboardPage() {
  const services = await getPlatformServices();
  const timeZone = services.configurationStore.read().web.timeZone;
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
  const projectStructure = activeProjectId
    ? await services.projectStructures.list(activeProjectId).catch(() => undefined)
    : undefined;
  const hierarchy = await selectedProjectHierarchy(projectStructure);
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
  const canReadSuites = Boolean(
    activeProjectId && hasPermission(identity, "case_suite.read", activeProjectId),
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
    canReadRunners ? services.runnerGroups.list(DASHBOARD_RUNNER_GROUP_LIMIT) : Promise.resolve([]),
    canReadRuns && hierarchy.projectVersionId
      ? services.runBatches.list(
          DASHBOARD_RUN_BATCH_LIMIT,
          runProjectIds,
          hierarchy.projectVersionId,
        )
      : Promise.resolve([]),
    canReadSources ? services.catalog.listRecentSources(5, caseProjectIds) : Promise.resolve([]),
    canReadRuns && hierarchy.projectVersionId
      ? services.platformOperations.analyticsOverview(
          identity,
          {
            ...(runProjectIds?.[0] ? { projectId: runProjectIds[0] } : {}),
            projectVersionId: hierarchy.projectVersionId,
            completedAfter: currentWeekStartedAt,
            timeZone,
          },
          { maximumFacts: DASHBOARD_ANALYTICS_SAMPLE_LIMIT },
        )
      : Promise.resolve(null),
    canReadRuns && hierarchy.projectVersionId
      ? services.platformOperations.analyticsOverview(
          identity,
          {
            ...(runProjectIds?.[0] ? { projectId: runProjectIds[0] } : {}),
            projectVersionId: hierarchy.projectVersionId,
            completedAfter: previousWeekStartedAt,
            completedBefore: currentWeekStartedAt,
            timeZone,
          },
          { maximumFacts: DASHBOARD_ANALYTICS_SAMPLE_LIMIT },
        )
      : Promise.resolve(null),
  ]);

  const activeBatches = recentBatches.filter((batch) => isActiveRunBatch(batch.status));
  const activeBatch = activeBatches[0];
  const activeRunSummary = summarizeActiveRuns(activeBatches);
  const runnerCapacity = summarizeRunnerCapacity(runners);
  const qualityScore = currentAnalytics ? currentAnalytics.successRate * 100 : null;
  const qualityDelta = calculateQualityDelta(currentAnalytics, previousAnalytics);
  const qualityAssessment = qualityGrade(
    currentAnalytics && currentAnalytics.sampleCount > 0 ? qualityScore : null,
  );
  const recentActivity = buildRecentActivity(recentBatches, recentSources);
  const methodResultCount = currentAnalytics
    ? currentAnalytics.passed + currentAnalytics.failed + currentAnalytics.skipped
    : 0;
  const enabledMethodPercent = percentageOf(
    catalogSummary.enabledMethodCount,
    catalogSummary.methodCount,
  );
  const focus = selectDashboardFocus({
    ...(activeBatch ? { activeBatch } : {}),
    failedMethods: currentAnalytics?.failed ?? 0,
    unavailableRunners: runnerCapacity.unavailableRunnerCount,
    enabledMethods: catalogSummary.enabledMethodCount,
    canReadRuns,
    canReadRunners,
    canReadCases,
  });

  return (
    <div className="dashboard-page">
      <header className="dashboard-welcome">
        <div className="dashboard-welcome-copy">
          <div className="dashboard-welcome-meta">
            <span className="dashboard-eyebrow">
              <Sparkles aria-hidden="true" size={14} /> 工作概览
            </span>
            <time
              className="dashboard-date"
              dateTime={now.toISOString()}
              title={`平台时区：${timeZone}`}
            >
              {dashboardDateLabel(now, timeZone)}
            </time>
          </div>
          <h1>
            <span>{greeting(now, timeZone)}，</span>
            <strong>{identity.user.displayName}</strong>
          </h1>
          <p>从质量结果到执行容量，把今天最重要的自动化测试状态集中在一个工作台。</p>
          <nav aria-label="工作台快捷入口" className="dashboard-quick-links">
            {canReadRuns ? (
              <Link href="/execution-records">
                <Activity aria-hidden="true" size={14} /> 执行记录
              </Link>
            ) : null}
            {canReadCases ? (
              <Link href="/cases">
                <BookOpenText aria-hidden="true" size={14} /> 用例管理
              </Link>
            ) : null}
            {canReadSuites ? (
              <Link href="/case-suites">
                <Layers3 aria-hidden="true" size={14} /> 用例任务
              </Link>
            ) : null}
            {canReadRuns ? (
              <Link href="/case-analysis">
                <SearchCheck aria-hidden="true" size={14} /> 用例分析
              </Link>
            ) : null}
          </nav>
        </div>
        <Link className={`dashboard-focus dashboard-focus-${focus.tone}`} href={focus.href}>
          <span>
            今日工作焦点 <ArrowUpRight aria-hidden="true" size={15} />
          </span>
          <strong>{focus.title}</strong>
          <small>{focus.detail}</small>
        </Link>
      </header>

      <section aria-label="关键状态" className="dashboard-pulse-grid">
        {canReadRuns ? (
          <DashboardPulse
            detail={`${activeRunSummary.runningRuns} 运行中 · ${activeRunSummary.pendingRuns} 待运行`}
            href="/execution-records"
            icon={Activity}
            label="活动批次"
            tone="info"
            value={activeRunSummary.batchCount}
          />
        ) : null}
        {canReadRuns ? (
          <DashboardPulse
            detail={`通过 ${currentAnalytics?.passed ?? 0} · 失败 ${currentAnalytics?.failed ?? 0}`}
            href="/insights"
            icon={BarChart3}
            label="本周方法结果"
            tone={currentAnalytics?.failed ? "danger" : "success"}
            value={methodResultCount.toLocaleString("zh-CN")}
          />
        ) : null}
        {canReadRunners ? (
          <DashboardPulse
            detail={`${runnerCapacity.busySlots} 占用 · ${runnerCapacity.onlineRunnerCount} 台在线`}
            href="/runners"
            icon={Gauge}
            label="可用执行槽位"
            tone={runnerCapacity.availableSlots > 0 ? "success" : "warning"}
            value={runnerCapacity.availableSlots}
          />
        ) : null}
        {canReadCases ? (
          <DashboardPulse
            detail={`${catalogSummary.enabledMethodCount.toLocaleString("zh-CN")} / ${catalogSummary.methodCount.toLocaleString("zh-CN")} 个方法已启用`}
            href="/cases"
            icon={Boxes}
            label="可执行覆盖"
            tone="violet"
            value={`${enabledMethodPercent}%`}
          />
        ) : null}
      </section>

      <section className="design-dashboard-grid" aria-label="工作台概览">
        <article className="card design-quality-card">
          <DashboardCardHeading
            action={
              <span className="dashboard-period-block">
                <span className="dashboard-period">最近 7 天</span>
                {currentAnalytics ? (
                  <time
                    dateTime={currentAnalytics.generatedAt}
                    title={`UTC：${currentAnalytics.generatedAt}`}
                  >
                    数据截至 {formatDate(currentAnalytics.generatedAt, timeZone)}
                  </time>
                ) : (
                  <small>等待统计数据</small>
                )}
              </span>
            }
            caption="已确认 TestNG 方法结果"
            icon={BarChart3}
            title="本周质量"
            tone="blue"
          />
          <div className="quality-score-row">
            <strong>
              {qualityScore === null || currentAnalytics?.sampleCount === 0
                ? "—"
                : qualityScore.toFixed(1)}
            </strong>
            <span>/ 100</span>
            {qualityDelta !== null && currentAnalytics && currentAnalytics.sampleCount > 0 ? (
              <b className={deltaToneClass(qualityDelta)}>{deltaLabel(qualityDelta)}</b>
            ) : null}
            <em className={`quality-grade quality-grade-${qualityAssessment.tone}`}>
              {qualityAssessment.label}
            </em>
          </div>
          <p className="quality-caption">
            {currentAnalytics?.sampleCount
              ? currentAnalytics.sampling
                ? `基于最近 ${currentAnalytics.sampleCount.toLocaleString("zh-CN")} 次已确认执行样本（首页最多读取 ${currentAnalytics.sampling.limit.toLocaleString("zh-CN")} 条）`
                : `基于 ${currentAnalytics.sampleCount.toLocaleString("zh-CN")} 次已确认执行样本`
              : "完成首轮执行后生成质量趋势"}
          </p>
          <QualityTrend analytics={currentAnalytics} />
          <QualityOutcomeDistribution analytics={currentAnalytics} />
          <div className="quality-metric-strip">
            <DashboardMetric
              label="执行样本"
              value={currentAnalytics?.sampleCount ?? 0}
              detail={`${methodResultCount.toLocaleString("zh-CN")} 个方法结果`}
              tone="info"
            />
            <DashboardMetric
              label="通过率"
              value={percent(currentAnalytics?.successRate ?? 0)}
              detail={qualityDelta === null ? "暂无上周基线" : `${deltaLabel(qualityDelta)}%`}
              tone="success"
            />
            <DashboardMetric
              label="P95 耗时"
              value={formatMetricDuration(currentAnalytics?.durationP95Ms)}
              detail={`P50 ${formatMetricDuration(currentAnalytics?.durationP50Ms)}`}
              tone="warning"
            />
            <DashboardMetric
              label="失败方法"
              value={currentAnalytics?.failed ?? 0}
              detail={`失败率 ${percent(currentAnalytics?.failureRate ?? 0)}`}
              tone="danger"
            />
          </div>
        </article>

        {canReadRuns ? (
          <article className="card design-active-card">
            <DashboardCardHeading
              action={<DashboardCardLink href="/execution-records" label="查看全部" />}
              caption="实时进度与资源等待"
              icon={Activity}
              title="活动执行"
              tone="violet"
            />
            {activeBatches.length > 0 ? (
              <>
                <div className="active-run-overview">
                  <div
                    aria-label={`${activeRunSummary.batchCount} 个活动批次共 ${activeRunSummary.totalRuns} 个用例：运行中 ${activeRunSummary.runningRuns}，通过 ${activeRunSummary.succeededRuns}，失败 ${activeRunSummary.failedRuns}，待运行 ${activeRunSummary.pendingRuns}`}
                    className="active-run-donut"
                    role="img"
                    style={activeRunDonutStyle(activeRunSummary)}
                  >
                    <span>
                      <strong>{activeRunSummary.totalRuns}</strong>
                      <small>{activeRunSummary.batchCount} 个批次</small>
                    </span>
                  </div>
                  <dl>
                    <ActiveCount color="blue" label="运行中" value={activeRunSummary.runningRuns} />
                    <ActiveCount
                      color="green"
                      label="通过"
                      value={activeRunSummary.succeededRuns}
                    />
                    <ActiveCount color="orange" label="失败" value={activeRunSummary.failedRuns} />
                    <ActiveCount
                      color="violet"
                      label="待运行"
                      value={activeRunSummary.pendingRuns}
                    />
                  </dl>
                </div>
                <div className="active-batch-list">
                  {activeBatches.slice(0, 3).map((batch) => (
                    <ActiveBatchSummary batch={batch} key={batch.id} />
                  ))}
                </div>
              </>
            ) : (
              <IdleExecutionState latestBatch={recentBatches[0]} />
            )}
          </article>
        ) : null}

        <article className="card design-library-card">
          <DashboardCardHeading
            action={<DashboardCardLink href="/cases" label="查看全部" />}
            caption="当前项目版本的资产"
            icon={BookOpenText}
            title="用例库"
            tone="blue"
          />
          <div className="dashboard-library-overview">
            <span>
              <strong>{catalogSummary.caseCount.toLocaleString("zh-CN")}</strong>
              <small>用例类</small>
            </span>
            <div>
              <small>方法可执行率</small>
              <strong>{enabledMethodPercent}%</strong>
              <em aria-hidden="true">
                <i style={{ width: `${enabledMethodPercent}%` }} />
              </em>
              <p>
                {catalogSummary.enabledMethodCount.toLocaleString("zh-CN")} 个启用，
                {Math.max(
                  0,
                  catalogSummary.methodCount - catalogSummary.enabledMethodCount,
                ).toLocaleString("zh-CN")}{" "}
                个停用
              </p>
            </div>
          </div>
          <dl className="design-stat-list">
            <LibraryCount
              icon={CheckCircle2}
              label="启用方法"
              value={catalogSummary.enabledMethodCount}
            />
            <LibraryCount icon={Activity} label="测试方法" value={catalogSummary.methodCount} />
            <LibraryCount icon={FileArchive} label="JAR 来源" value={catalogSummary.sourceCount} />
          </dl>
          <div className="dashboard-library-actions">
            <Link
              className="design-library-action"
              href={canManageSources ? "/cases/import" : "/cases"}
            >
              {canManageSources ? "+ 导入新用例" : "打开用例库"}
            </Link>
            {canReadSuites ? <Link href="/case-suites">管理任务</Link> : null}
          </div>
        </article>

        {canReadRunners ? (
          <article className="card design-runner-groups-card">
            <DashboardCardHeading
              action={<DashboardCardLink href="/runners?section=groups" label="查看全部" />}
              caption={`执行机在线 ${runnerCapacity.onlineRunnerCount}/${runnerCapacity.runnerCount}`}
              icon={ServerCog}
              title="执行机组"
              tone="green"
            />
            <div className="runner-capacity-overview">
              <div>
                <span>
                  <small>在线槽位</small>
                  <strong>
                    {runnerCapacity.availableSlots}
                    <em> / {runnerCapacity.onlineSlots} 可用</em>
                  </strong>
                </span>
                <b>{runnerCapacity.utilizationPercent}% 已占用</b>
              </div>
              <span aria-label={`执行槽位占用 ${runnerCapacity.utilizationPercent}%`}>
                <i style={{ width: `${runnerCapacity.utilizationPercent}%` }} />
              </span>
              <div className="runner-resource-pills">
                <span>
                  CPU 平均 <strong>{optionalPercent(runnerCapacity.averageCpuPercent)}</strong>
                </span>
                <span>
                  内存平均 <strong>{optionalPercent(runnerCapacity.averageMemoryPercent)}</strong>
                </span>
                <span>
                  忙碌槽位 <strong>{runnerCapacity.busySlots}</strong>
                </span>
              </div>
            </div>
            {runnerGroups.length === 0 && runners.length === 0 ? (
              <div className="design-empty-state compact">
                <ServerCog aria-hidden="true" size={25} />
                <strong>尚未注册执行机</strong>
                <p>安装 Runner Agent 后，容量和资源状态会显示在这里。</p>
                <Link href="/runners">安装执行机</Link>
              </div>
            ) : runnerGroups.length === 0 ? (
              <RunnerSnapshotList runners={runners} timeZone={timeZone} />
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
                <strong>{runnerCapacity.runnerCount}</strong>
              </span>
              <span>
                <small>在线</small>
                <strong>{runnerCapacity.onlineRunnerCount}</strong>
              </span>
              <span>
                <small>不可用</small>
                <strong>{runnerCapacity.unavailableRunnerCount}</strong>
              </span>
              <span>
                <small>可用槽位</small>
                <strong>{runnerCapacity.availableSlots}</strong>
              </span>
            </div>
          </article>
        ) : null}

        {canReadRuns ? (
          <article className="card design-failure-card">
            <DashboardCardHeading
              action={<DashboardCardLink href="/insights" label="查看全部" />}
              caption="最近七天的失败聚类"
              icon={AlertTriangle}
              title="失败洞察"
              tone="red"
            />
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
                {(currentAnalytics?.failures ?? []).slice(0, 4).map((failure, index) => (
                  <div className="failure-reason-row" key={failure.signature}>
                    <span>
                      <i data-index={index} />
                      <span title={failure.description}>{failure.description}</span>
                      <strong>{failure.count}</strong>
                    </span>
                    <em aria-hidden="true">
                      <i
                        style={{
                          width: `${failureReasonPercent(failure.count, currentAnalytics?.failures ?? [])}%`,
                        }}
                      />
                    </em>
                  </div>
                ))}
                {(currentAnalytics?.failures.length ?? 0) === 0 ? (
                  <p className="muted">本周暂无可聚类失败。</p>
                ) : null}
              </div>
            </div>
            <FailureScopeMetrics analytics={currentAnalytics} />
            <FailureTriageInsight failures={currentAnalytics?.failures ?? []} />
            <div className="failure-action-strip">
              <span>
                <small>首要失败占比</small>
                <strong>
                  {failureReasonPercent(
                    currentAnalytics?.failures[0]?.count ?? 0,
                    currentAnalytics?.failures ?? [],
                  )}
                  %
                </strong>
              </span>
              <span>
                <small>最近出现</small>
                <strong>
                  {currentAnalytics?.failures[0]
                    ? formatDate(currentAnalytics.failures[0].lastSeenAt, timeZone)
                    : "—"}
                </strong>
              </span>
              <Link href="/case-analysis">
                进入用例分析 <ArrowUpRight aria-hidden="true" size={14} />
              </Link>
            </div>
          </article>
        ) : null}

        <article className="card design-recent-card">
          <DashboardCardHeading
            action={
              <DashboardCardLink
                href={canReadRuns ? "/execution-records" : canReadSources ? "/objects" : "/cases"}
                label="查看全部"
              />
            }
            caption="执行、导入与平台变化"
            icon={Clock3}
            title="最近动态"
            tone="amber"
          />
          <div className="activity-summary-strip">
            <span>
              <Activity aria-hidden="true" size={13} /> 执行 {recentBatches.length}
            </span>
            <span>
              <FileArchive aria-hidden="true" size={13} /> 导入 {recentSources.length}
            </span>
            <span>
              {recentActivity.length > 0
                ? `更新于 ${formatDate(recentActivity[0]!.at, timeZone)}`
                : "等待第一条动态"}
            </span>
          </div>
          {recentActivity.length === 0 ? (
            <div className="design-empty-state compact">
              <Clock3 size={25} />
              <strong>暂无最近动态</strong>
              <p>批次执行与用例导入会显示在这里。</p>
            </div>
          ) : (
            <div className="design-activity-list">
              {recentActivity.slice(0, 6).map((item) => (
                <Link href={item.href} key={`${item.kind}:${item.id}`}>
                  <span className={`design-activity-icon ${item.tone}`}>
                    {item.tone === "success" ? (
                      <CheckCircle2 aria-hidden="true" size={16} />
                    ) : item.tone === "danger" ? (
                      <XCircle aria-hidden="true" size={16} />
                    ) : item.tone === "warning" ? (
                      <AlertTriangle aria-hidden="true" size={16} />
                    ) : item.kind === "source" ? (
                      <FileArchive aria-hidden="true" size={16} />
                    ) : (
                      <Activity aria-hidden="true" size={16} />
                    )}
                  </span>
                  <span>
                    <strong title={item.title}>{item.title}</strong>
                    <small title={item.detail}>{item.detail}</small>
                  </span>
                  <time dateTime={item.at}>{formatDate(item.at, timeZone)}</time>
                </Link>
              ))}
            </div>
          )}
        </article>
      </section>
    </div>
  );
}

function DashboardPulse({
  detail,
  href,
  icon: Icon,
  label,
  tone,
  value,
}: {
  detail: string;
  href: string;
  icon: typeof Activity;
  label: string;
  tone: "info" | "success" | "warning" | "danger" | "violet";
  value: string | number;
}) {
  return (
    <Link className={`dashboard-pulse dashboard-pulse-${tone}`} href={href}>
      <span className="dashboard-pulse-icon">
        <Icon aria-hidden="true" size={18} />
      </span>
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{detail}</em>
      </span>
      <ArrowUpRight aria-hidden="true" size={15} />
    </Link>
  );
}

function DashboardCardHeading({
  action,
  caption,
  icon: Icon,
  title,
  tone,
}: {
  action: ReactNode;
  caption: string;
  icon: typeof Activity;
  title: string;
  tone: "blue" | "green" | "violet" | "red" | "amber";
}) {
  return (
    <header className="design-card-heading">
      <div>
        <span className={`dashboard-card-icon dashboard-card-icon-${tone}`}>
          <Icon aria-hidden="true" size={17} />
        </span>
        <span>
          <h2>{title}</h2>
          <small>{caption}</small>
        </span>
      </div>
      {action}
    </header>
  );
}

function DashboardCardLink({ href, label }: { href: string; label: string }) {
  return (
    <Link className="dashboard-card-link" href={href}>
      {label} <ArrowUpRight aria-hidden="true" size={13} />
    </Link>
  );
}

function QualityOutcomeDistribution({ analytics }: { analytics: AnalyticsSummary | null }) {
  const methodCount = analytics ? analytics.passed + analytics.failed + analytics.skipped : 0;
  const outcomes = [
    {
      key: "passed",
      label: "通过",
      value: analytics?.passed ?? 0,
      percent: percentageOf(analytics?.passed ?? 0, methodCount),
    },
    {
      key: "failed",
      label: "失败",
      value: analytics?.failed ?? 0,
      percent: percentageOf(analytics?.failed ?? 0, methodCount),
    },
    {
      key: "skipped",
      label: "跳过",
      value: analytics?.skipped ?? 0,
      percent: percentageOf(analytics?.skipped ?? 0, methodCount),
    },
  ] as const;
  return (
    <div className="quality-outcome-distribution">
      <div
        aria-label={`方法结果共 ${methodCount} 个：通过 ${outcomes[0].value}，失败 ${outcomes[1].value}，跳过 ${outcomes[2].value}`}
        className="quality-outcome-bar"
        role="img"
      >
        {outcomes.map((outcome) => (
          <i
            className={`quality-outcome-${outcome.key}`}
            key={outcome.key}
            style={{ width: `${outcome.percent}%` }}
          />
        ))}
      </div>
      <div>
        {outcomes.map((outcome) => (
          <span key={outcome.key}>
            <i className={`quality-outcome-${outcome.key}`} />
            {outcome.label} <strong>{outcome.value.toLocaleString("zh-CN")}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

function ActiveBatchSummary({ batch }: { batch: RunBatch }) {
  const completionPercent = runBatchCompletionPercent(batch);
  return (
    <Link className="active-batch-summary" href={`/run-batches/${batch.id}`}>
      <span className="active-batch-icon">
        <Activity aria-hidden="true" size={17} />
      </span>
      <span>
        <strong title={batch.suiteName}>{batch.suiteName}</strong>
        <small>
          #{batch.sequenceNumber} · {dashboardRunStatusLabel(batch.status)} · 当前第{" "}
          {batch.currentRound}轮
        </small>
      </span>
      <span className="active-batch-progress">
        <b>{completionPercent}%</b>
        <i>
          <em style={{ width: `${completionPercent}%` }} />
        </i>
      </span>
    </Link>
  );
}

function IdleExecutionState({ latestBatch }: { latestBatch: RunBatch | undefined }) {
  const latestBatchTone = batchTone(latestBatch?.status);
  return (
    <div className="idle-execution-state">
      <div className="design-empty-state compact">
        <CircleDashed aria-hidden="true" size={28} />
        <strong>当前没有活动执行</strong>
        <p>点击顶栏“开始执行”，选择任务或单个用例。</p>
      </div>
      {latestBatch ? (
        <Link className="latest-batch-summary" href={`/run-batches/${latestBatch.id}`}>
          <span className={latestBatchTone}>
            {latestBatch.status === "succeeded" ? (
              <CheckCircle2 aria-hidden="true" size={16} />
            ) : latestBatch.status === "failed" ? (
              <XCircle aria-hidden="true" size={16} />
            ) : (
              <TimerReset aria-hidden="true" size={16} />
            )}
          </span>
          <span>
            <small>
              最近批次 · {runBatchStatusLabel(latestBatch.status)} · #{latestBatch.sequenceNumber}
            </small>
            <strong title={latestBatch.suiteName}>{latestBatch.suiteName}</strong>
          </span>
          <b className={latestBatchTone}>通过率 {runBatchPassRate(latestBatch)}%</b>
        </Link>
      ) : null}
    </div>
  );
}

function QualityTrend({ analytics }: { analytics: AnalyticsSummary | null }) {
  const trend = analytics?.trend ?? [];
  if (trend.length === 0) return <div className="quality-chart-empty">暂无趋势数据</div>;
  const chartStartX = 52;
  const chartEndX = 580;
  const chartBaselineY = 155;
  const points = trend.map((bucket, index) => {
    const samples = bucket.passed + bucket.failed + bucket.skipped;
    const rate = samples === 0 ? 0 : (bucket.passed / samples) * 100;
    const x =
      trend.length === 1
        ? (chartStartX + chartEndX) / 2
        : chartStartX + (index / (trend.length - 1)) * (chartEndX - chartStartX);
    const y = chartBaselineY - rate * 1.15;
    return { x, y, label: bucket.bucket.slice(5, 10), rate };
  });
  const plotPoints =
    points.length === 1
      ? [{ ...points[0]!, x: chartStartX }, points[0]!, { ...points[0]!, x: chartEndX }]
      : points;
  const polyline = plotPoints.map(({ x, y }) => `${x},${y}`).join(" ");
  const area = `${chartStartX},${chartBaselineY} ${polyline} ${chartEndX},${chartBaselineY}`;
  const latestPoint = points.at(-1)!;
  const latestLabelX = Math.min(chartEndX - 20, Math.max(chartStartX + 20, latestPoint.x));
  const scale = [
    { label: "100%", y: 40 },
    { label: "50%", y: 97.5 },
    { label: "0%", y: chartBaselineY },
  ] as const;
  const trendDescription = points
    .map((point) => `${point.label} 通过率 ${point.rate.toFixed(1)}%`)
    .join("，");
  return (
    <div
      className="quality-trend-chart"
      role="img"
      aria-label={`最近七天通过率趋势：${trendDescription}`}
    >
      <svg aria-hidden="true" viewBox="0 0 600 175">
        {scale.map(({ label, y }) => (
          <g key={label}>
            <text className="quality-trend-scale" x="4" y={y + 4}>
              {label}
            </text>
            <line x1={chartStartX} x2={chartEndX} y1={y} y2={y} />
          </g>
        ))}
        <polygon points={area} />
        <polyline points={polyline} />
        {points.map((point) => (
          <circle cx={point.x} cy={point.y} key={point.label} r="4" />
        ))}
        <g className="quality-trend-value">
          <rect height="22" rx="7" width="52" x={latestLabelX - 26} y={latestPoint.y - 30} />
          <text textAnchor="middle" x={latestLabelX} y={latestPoint.y - 15}>
            {latestPoint.rate.toFixed(1)}%
          </text>
        </g>
      </svg>
      <div className={points.length === 1 ? "single" : undefined}>
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

function RunnerSnapshotList({
  runners,
  timeZone,
}: {
  runners: readonly Runner[];
  timeZone: string;
}) {
  const visibleRunners = [...runners]
    .sort(
      (left, right) =>
        runnerStateOrder(left.state) - runnerStateOrder(right.state) ||
        left.name.localeCompare(right.name, "zh-CN"),
    )
    .slice(0, 4);
  return (
    <section className="dashboard-runner-snapshots" aria-label="未分组执行机">
      <header>
        <span>
          <UsersRound aria-hidden="true" size={14} /> 未分组执行机
        </span>
        <Link href="/runners?section=groups">配置分组</Link>
      </header>
      <div>
        {visibleRunners.map((runner) => {
          const availableSlots =
            runner.state === "online" ? Math.max(0, runner.maxConcurrency - runner.busySlots) : 0;
          return (
            <Link href="/runners" key={runner.id}>
              <span className={`runner-snapshot-state runner-snapshot-state-${runner.state}`}>
                <ServerCog aria-hidden="true" size={15} />
              </span>
              <span>
                <strong title={runner.name}>{runner.name}</strong>
                <small>
                  {runnerStateLabel(runner.state)} · {runner.os} · {runner.architecture} · Agent{" "}
                  {runner.agentVersion}
                </small>
              </span>
              <span>
                <strong>
                  {availableSlots}/{runner.maxConcurrency}
                </strong>
                <small>可用槽位</small>
              </span>
              <span>
                <strong>{optionalPercent(runner.resourceSnapshot?.cpuUtilizationPercent)}</strong>
                <small>CPU</small>
              </span>
              <time dateTime={runner.lastSeenAt} title={`UTC：${runner.lastSeenAt}`}>
                <strong>{formatDate(runner.lastSeenAt, timeZone)}</strong>
                <small>最近心跳</small>
              </time>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function FailureScopeMetrics({ analytics }: { analytics: AnalyticsSummary | null }) {
  const failures = analytics?.failures ?? [];
  const failureOccurrences = failures.reduce((total, failure) => total + failure.count, 0);
  return (
    <div className="failure-scope-metrics">
      <span>
        <small>失败类型</small>
        <strong>{failures.length}</strong>
      </span>
      <span>
        <small>失败记录</small>
        <strong>{failureOccurrences}</strong>
      </span>
      <span>
        <small>不稳定用例</small>
        <strong>{analytics?.flakyCases.length ?? 0}</strong>
      </span>
    </div>
  );
}

function FailureTriageInsight({ failures }: { failures: AnalyticsSummary["failures"] }) {
  const primaryFailure = failures[0];
  if (!primaryFailure) return null;
  const concentration = failureReasonPercent(primaryFailure.count, failures);
  return (
    <div className="failure-triage-insight">
      <span>
        <SearchCheck aria-hidden="true" size={17} />
      </span>
      <div>
        <small>失败集中度</small>
        <strong>{failureConcentrationLabel(concentration)}</strong>
        <p>
          首要原因覆盖 {concentration}% 的失败记录，共出现 {primaryFailure.count} 次。
        </p>
      </div>
    </div>
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
            : `执行${dashboardRunStatusLabel(batch.status)} · ${batch.suiteName}`,
      detail: `批次 #${batch.sequenceNumber} · 通过 ${batch.succeededRuns} / ${batch.totalRuns} · 失败 ${batch.failedRuns + batch.timedOutRuns}`,
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

function deltaLabel(value: number): string {
  if (Math.abs(value) < 0.05) return "— 0.0";
  return `${value > 0 ? "↑" : "↓"} ${Math.abs(value).toFixed(1)}`;
}

function deltaToneClass(value: number): string {
  if (Math.abs(value) < 0.05) return "trend-neutral";
  return value > 0 ? "trend-positive" : "trend-negative";
}

function dashboardRunStatusLabel(status: RunBatch["status"]): string {
  if (status === "dispatching" || status === "scheduled") return "准备执行";
  return runBatchStatusLabel(status);
}

function activeRunDonutStyle(summary: ActiveRunSummary): CSSProperties {
  return {
    background: conicGradient(
      [
        { count: summary.runningRuns, color: "var(--color-info)" },
        { count: summary.succeededRuns, color: "var(--color-success)" },
        { count: summary.failedRuns, color: "var(--color-danger)" },
        { count: summary.pendingRuns, color: "var(--color-violet)" },
      ],
      summary.totalRuns,
      "var(--color-border)",
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
      "var(--color-border)",
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

function greeting(now: Date, timeZone: string): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now),
  );
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function dashboardDateLabel(now: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    month: "long",
    day: "numeric",
  }).format(now);
  const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone, weekday: "long" }).format(now);
  return `${date} · ${weekday}`;
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function percentageOf(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((value / total) * 100));
}

function optionalPercent(value: number | undefined): string {
  return value === undefined ? "—" : `${value}%`;
}

function qualityGrade(score: number | null): {
  label: string;
  tone: "success" | "warning" | "danger" | "neutral";
} {
  if (score === null) return { label: "等待数据", tone: "neutral" };
  if (score >= 95) return { label: "质量稳定", tone: "success" };
  if (score >= 80) return { label: "持续观察", tone: "warning" };
  return { label: "需要关注", tone: "danger" };
}

function formatMetricDuration(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value < 1_000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

function failureReasonPercent(count: number, failures: AnalyticsSummary["failures"]): number {
  return percentageOf(
    count,
    failures.reduce((sum, failure) => sum + failure.count, 0),
  );
}

function failureConcentrationLabel(percentValue: number): string {
  if (percentValue >= 70) return "高度集中";
  if (percentValue >= 40) return "中度集中";
  return "原因较分散";
}

function runnerStateOrder(state: Runner["state"]): number {
  const order: Record<Runner["state"], number> = {
    online: 0,
    draining: 1,
    offline: 2,
    disabled: 3,
  };
  return order[state];
}

function runnerStateLabel(state: Runner["state"]): string {
  const labels: Record<Runner["state"], string> = {
    online: "在线",
    draining: "排空中",
    offline: "离线",
    disabled: "已禁用",
  };
  return labels[state];
}

function batchTone(status: RunBatch["status"] | undefined): "success" | "warning" | "danger" {
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  return "warning";
}

function formatDate(value: string, timeZone: string): string {
  return formatPlatformDateTime(value, timeZone, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
