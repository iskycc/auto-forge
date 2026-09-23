import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { dashboardSnapshotSchema, type AnalyticsSummary } from "@autoforge/contracts";
import { ReadModelStatusBar } from "@/components/read-model-status";
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
  const now = services.clock.now();

  const [dashboardProjection, runners, runnerGroups, recentBatchPage, recentSources] =
    await Promise.all([
      activeProjectId && hierarchy.projectVersionId && (canReadCases || canReadRuns)
        ? services.readModels
            .read({
              kind: "dashboard",
              projectId: activeProjectId,
              projectVersionId: hierarchy.projectVersionId,
              timeZone,
            })
            .catch(() => null)
        : Promise.resolve(null),
      canReadRunners ? services.runnerControl.list(500) : Promise.resolve([]),
      canReadRunners
        ? services.runnerGroups.list(DASHBOARD_RUNNER_GROUP_LIMIT)
        : Promise.resolve([]),
      canReadRuns && hierarchy.projectVersionId
        ? services.executionBatchPage({
            limit: DASHBOARD_RUN_BATCH_LIMIT,
            ...(runProjectIds ? { projectIds: runProjectIds } : {}),
            projectVersionId: hierarchy.projectVersionId,
          })
        : Promise.resolve({ items: [], statistics: undefined }),
      canReadSources && activeProjectId
        ? services.catalog.listRecentSources(5, [activeProjectId])
        : Promise.resolve([]),
    ]);

  const recentBatches = recentBatchPage.items;
  const dashboardSnapshot = dashboardProjection?.generation
    ? dashboardSnapshotSchema.parse(dashboardProjection.payload)
    : null;
  const emptyCatalogSummary = {
    sourceCount: 0,
    caseCount: 0,
    methodCount: 0,
    enabledMethodCount: 0,
  };
  const catalogSummary = canReadCases
    ? (dashboardSnapshot?.catalog ?? emptyCatalogSummary)
    : emptyCatalogSummary;
  const currentAnalytics = canReadRuns ? (dashboardSnapshot?.currentAnalytics ?? null) : null;
  const previousAnalytics = canReadRuns ? (dashboardSnapshot?.previousAnalytics ?? null) : null;

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
    <div className={cn("dashboard-page", pageStyles["dashboard-page"])}>
      {dashboardProjection ? (
        <ReadModelStatusBar
          snapshots={[
            dashboardProjection.status,
            ...(recentBatchPage.statistics ? [recentBatchPage.statistics] : []),
          ]}
        />
      ) : null}
      <header className={cn("dashboard-welcome", pageStyles["dashboard-welcome"])}>
        <div className={cn("dashboard-welcome-copy", pageStyles["dashboard-welcome-copy"])}>
          <div className={cn("dashboard-welcome-meta", pageStyles["dashboard-welcome-meta"])}>
            <span className={cn("dashboard-eyebrow", pageStyles["dashboard-eyebrow"])}>
              <Sparkles aria-hidden="true" size={14} /> 工作概览
            </span>
            <time
              className={cn("dashboard-date", pageStyles["dashboard-date"])}
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
          <nav
            aria-label="工作台快捷入口"
            className={cn("dashboard-quick-links", pageStyles["dashboard-quick-links"])}
          >
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
        <Link
          className={cn(
            pageStyles["dashboard-focus"],
            `dashboard-focus dashboard-focus dashboard-focus-${focus.tone}`,
          )}
          href={focus.href}
        >
          <span>
            今日工作焦点 <ArrowUpRight aria-hidden="true" size={15} />
          </span>
          <strong>{focus.title}</strong>
          <small>{focus.detail}</small>
        </Link>
      </header>

      <section
        aria-label="关键状态"
        className={cn("dashboard-pulse-grid", pageStyles["dashboard-pulse-grid"])}
      >
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

      <section
        className={cn("design-dashboard-grid", pageStyles["design-dashboard-grid"])}
        aria-label="工作台概览"
      >
        <Card
          as="article"
          className={cn(
            "card design-quality-card",
            uiPatterns["card"],
            pageStyles["design-quality-card"],
          )}
        >
          <DashboardCardHeading
            action={
              <span className={cn("dashboard-period-block", pageStyles["dashboard-period-block"])}>
                <span className={cn("dashboard-period", pageStyles["dashboard-period"])}>
                  最近 7 天
                </span>
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
          <div className={cn("quality-score-row", pageStyles["quality-score-row"])}>
            <strong>
              {qualityScore === null || currentAnalytics?.sampleCount === 0
                ? "—"
                : qualityScore.toFixed(1)}
            </strong>
            <span>/ 100</span>
            {qualityDelta !== null && currentAnalytics && currentAnalytics.sampleCount > 0 ? (
              <b className={deltaToneClass(qualityDelta)}>{deltaLabel(qualityDelta)}</b>
            ) : null}
            <em
              className={cn(
                pageStyles["quality-grade"],
                `quality-grade quality-grade quality-grade-${qualityAssessment.tone}`,
              )}
            >
              {qualityAssessment.label}
            </em>
          </div>
          <p className={cn("quality-caption", pageStyles["quality-caption"])}>
            {currentAnalytics?.sampleCount
              ? currentAnalytics.sampling
                ? `基于最近 ${currentAnalytics.sampleCount.toLocaleString("zh-CN")} 次已确认执行样本（首页最多读取 ${currentAnalytics.sampling.limit.toLocaleString("zh-CN")} 条）`
                : `基于 ${currentAnalytics.sampleCount.toLocaleString("zh-CN")} 次已确认执行样本`
              : "完成首轮执行后生成质量趋势"}
          </p>
          <QualityTrend analytics={currentAnalytics} />
          <QualityOutcomeDistribution analytics={currentAnalytics} />
          <div className={cn("quality-metric-strip", pageStyles["quality-metric-strip"])}>
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
        </Card>

        {canReadRuns ? (
          <Card
            as="article"
            className={cn(
              "card design-active-card",
              uiPatterns["card"],
              pageStyles["design-active-card"],
            )}
          >
            <DashboardCardHeading
              action={<DashboardCardLink href="/execution-records" label="查看全部" />}
              caption="实时进度与资源等待"
              icon={Activity}
              title="活动执行"
              tone="violet"
            />
            {activeBatches.length > 0 ? (
              <>
                <div className={cn("active-run-overview", pageStyles["active-run-overview"])}>
                  <div
                    aria-label={`${activeRunSummary.batchCount} 个活动批次共 ${activeRunSummary.totalRuns} 个用例：运行中 ${activeRunSummary.runningRuns}，通过 ${activeRunSummary.succeededRuns}，失败 ${activeRunSummary.failedRuns}，待运行 ${activeRunSummary.pendingRuns}`}
                    className={cn("active-run-donut", pageStyles["active-run-donut"])}
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
                <div className={cn("active-batch-list", pageStyles["active-batch-list"])}>
                  {activeBatches.slice(0, 3).map((batch) => (
                    <ActiveBatchSummary batch={batch} key={batch.id} />
                  ))}
                </div>
              </>
            ) : (
              <IdleExecutionState latestBatch={recentBatches[0]} />
            )}
          </Card>
        ) : null}

        <Card
          as="article"
          className={cn(
            "card design-library-card",
            uiPatterns["card"],
            pageStyles["design-library-card"],
          )}
        >
          <DashboardCardHeading
            action={<DashboardCardLink href="/cases" label="查看全部" />}
            caption="当前项目版本的资产"
            icon={BookOpenText}
            title="用例库"
            tone="blue"
          />
          <div
            className={cn("dashboard-library-overview", pageStyles["dashboard-library-overview"])}
          >
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
          <dl className={cn("design-stat-list", pageStyles["design-stat-list"])}>
            <LibraryCount
              icon={CheckCircle2}
              label="启用方法"
              value={catalogSummary.enabledMethodCount}
            />
            <LibraryCount icon={Activity} label="测试方法" value={catalogSummary.methodCount} />
            <LibraryCount icon={FileArchive} label="JAR 来源" value={catalogSummary.sourceCount} />
          </dl>
          <div className={cn("dashboard-library-actions", pageStyles["dashboard-library-actions"])}>
            <Link
              className={cn("design-library-action", pageStyles["design-library-action"])}
              href={canManageSources ? "/cases/import" : "/cases"}
            >
              {canManageSources ? "+ 导入新用例" : "打开用例库"}
            </Link>
            {canReadSuites ? <Link href="/case-suites">管理任务</Link> : null}
          </div>
        </Card>

        {canReadRunners ? (
          <Card
            as="article"
            className={cn(
              "card design-runner-groups-card",
              uiPatterns["card"],
              pageStyles["design-runner-groups-card"],
            )}
          >
            <DashboardCardHeading
              action={<DashboardCardLink href="/runners?section=groups" label="查看全部" />}
              caption={`执行机在线 ${runnerCapacity.onlineRunnerCount}/${runnerCapacity.runnerCount}`}
              icon={ServerCog}
              title="执行机组"
              tone="green"
            />
            <div className={cn("runner-capacity-overview", pageStyles["runner-capacity-overview"])}>
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
              <div className={cn("runner-resource-pills", pageStyles["runner-resource-pills"])}>
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
              <div className={cn("design-empty-state compact", pageStyles["design-empty-state"])}>
                <ServerCog aria-hidden="true" size={25} />
                <strong>尚未注册执行机</strong>
                <p>安装 Runner Agent 后，容量和资源状态会显示在这里。</p>
                <Link href="/runners">安装执行机</Link>
              </div>
            ) : runnerGroups.length === 0 ? (
              <RunnerSnapshotList runners={runners} timeZone={timeZone} />
            ) : (
              <div
                className={cn(
                  "dashboard-runner-group-grid",
                  pageStyles["dashboard-runner-group-grid"],
                )}
              >
                {runnerGroups.slice(0, 6).map((group) => (
                  <RunnerGroupCard group={group} key={group.id} runners={runners} />
                ))}
              </div>
            )}
            <div className={cn("runner-total-strip", pageStyles["runner-total-strip"])}>
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
          </Card>
        ) : null}

        {canReadRuns ? (
          <Card
            as="article"
            className={cn(
              "card design-failure-card",
              uiPatterns["card"],
              pageStyles["design-failure-card"],
            )}
          >
            <DashboardCardHeading
              action={<DashboardCardLink href="/insights" label="查看全部" />}
              caption="最近七天的失败聚类"
              icon={AlertTriangle}
              title="失败洞察"
              tone="red"
            />
            <div className={cn("failure-overview", pageStyles["failure-overview"])}>
              <div
                aria-label={`本周失败率 ${percent(currentAnalytics?.failureRate ?? 0)}`}
                className={cn("failure-donut", pageStyles["failure-donut"])}
                role="img"
                style={failureDonutStyle(currentAnalytics?.failures ?? [])}
              >
                <span>
                  <strong>{currentAnalytics?.failed ?? 0}</strong>
                  <small>失败方法</small>
                </span>
              </div>
              <div className={cn("failure-reason-list", pageStyles["failure-reason-list"])}>
                {(currentAnalytics?.failures ?? []).slice(0, 4).map((failure, index) => (
                  <div
                    className={cn("failure-reason-row", pageStyles["failure-reason-row"])}
                    key={failure.signature}
                  >
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
                  <p className={cn("muted", uiPatterns["muted"])}>本周暂无可聚类失败。</p>
                ) : null}
              </div>
            </div>
            <FailureScopeMetrics analytics={currentAnalytics} />
            <FailureTriageInsight failures={currentAnalytics?.failures ?? []} />
            <div className={cn("failure-action-strip", pageStyles["failure-action-strip"])}>
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
          </Card>
        ) : null}

        <Card
          as="article"
          className={cn(
            "card design-recent-card",
            uiPatterns["card"],
            pageStyles["design-recent-card"],
          )}
        >
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
          <div className={cn("activity-summary-strip", pageStyles["activity-summary-strip"])}>
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
            <div className={cn("design-empty-state compact", pageStyles["design-empty-state"])}>
              <Clock3 size={25} />
              <strong>暂无最近动态</strong>
              <p>批次执行与用例导入会显示在这里。</p>
            </div>
          ) : (
            <div className={cn("design-activity-list", pageStyles["design-activity-list"])}>
              {recentActivity.slice(0, 6).map((item) => (
                <Link href={item.href} key={`${item.kind}:${item.id}`}>
                  <span
                    className={cn(
                      pageStyles["design-activity-icon"],
                      `design-activity-icon ${item.tone}`,
                    )}
                  >
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
        </Card>
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
    <Link
      className={cn(
        pageStyles["dashboard-pulse"],
        `dashboard-pulse dashboard-pulse dashboard-pulse-${tone}`,
      )}
      href={href}
    >
      <span className={cn("dashboard-pulse-icon", pageStyles["dashboard-pulse-icon"])}>
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
    <header className={cn("design-card-heading", pageStyles["design-card-heading"])}>
      <div>
        <span
          className={cn(
            pageStyles["dashboard-card-icon"],
            `dashboard-card-icon dashboard-card-icon dashboard-card-icon-${tone}`,
          )}
        >
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
    <Link className={cn("dashboard-card-link", pageStyles["dashboard-card-link"])} href={href}>
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
    <div className={cn("quality-outcome-distribution", pageStyles["quality-outcome-distribution"])}>
      <div
        aria-label={`方法结果共 ${methodCount} 个：通过 ${outcomes[0].value}，失败 ${outcomes[1].value}，跳过 ${outcomes[2].value}`}
        className={cn("quality-outcome-bar", pageStyles["quality-outcome-bar"])}
        role="img"
      >
        {outcomes.map((outcome) => (
          <i
            className={cn(
              pageStyles["quality-outcome"],
              `quality-outcome quality-outcome-${outcome.key}`,
            )}
            key={outcome.key}
            style={{ width: `${outcome.percent}%` }}
          />
        ))}
      </div>
      <div>
        {outcomes.map((outcome) => (
          <span key={outcome.key}>
            <i
              className={cn(
                pageStyles["quality-outcome"],
                `quality-outcome quality-outcome-${outcome.key}`,
              )}
            />
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
    <Link
      className={cn("active-batch-summary", pageStyles["active-batch-summary"])}
      href={`/run-batches/${batch.id}`}
    >
      <span className={cn("active-batch-icon", pageStyles["active-batch-icon"])}>
        <Activity aria-hidden="true" size={17} />
      </span>
      <span>
        <strong title={batch.suiteName}>{batch.suiteName}</strong>
        <small>
          #{batch.sequenceNumber} · {dashboardRunStatusLabel(batch.status)} · 当前第{" "}
          {batch.currentRound}轮
        </small>
      </span>
      <span className={cn("active-batch-progress", pageStyles["active-batch-progress"])}>
        <b>{completionPercent}%</b>
        <i>
          <em style={{ width: `${completionPercent}%` }} />
        </i>
      </span>
    </Link>
  );
}

function IdleExecutionState({
  latestBatch,
}: {
  latestBatch: (RunBatch & { statisticsPending?: boolean }) | undefined;
}) {
  const latestBatchTone = batchTone(latestBatch?.status);
  return (
    <div className={cn("idle-execution-state", pageStyles["idle-execution-state"])}>
      <div className={cn("design-empty-state compact", pageStyles["design-empty-state"])}>
        <CircleDashed aria-hidden="true" size={28} />
        <strong>当前没有活动执行</strong>
        <p>点击顶栏“开始执行”，选择任务或单个用例。</p>
      </div>
      {latestBatch ? (
        <Link
          className={cn("latest-batch-summary", pageStyles["latest-batch-summary"])}
          href={`/run-batches/${latestBatch.id}`}
        >
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
          <b className={latestBatchTone}>
            {latestBatch.statisticsPending
              ? "统计准备中"
              : `通过率 ${runBatchPassRate(latestBatch)}%`}
          </b>
        </Link>
      ) : null}
    </div>
  );
}

function QualityTrend({ analytics }: { analytics: AnalyticsSummary | null }) {
  const trend = analytics?.trend ?? [];
  if (trend.length === 0)
    return (
      <div className={cn("quality-chart-empty", pageStyles["quality-chart-empty"])}>
        暂无趋势数据
      </div>
    );
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
      className={cn("quality-trend-chart", pageStyles["quality-trend-chart"])}
      role="img"
      aria-label={`最近七天通过率趋势：${trendDescription}`}
    >
      <svg aria-hidden="true" viewBox="0 0 600 175">
        {scale.map(({ label, y }) => (
          <g key={label}>
            <text className={"quality-trend-scale"} x="4" y={y + 4}>
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
        <g className={"quality-trend-value"}>
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
      <em className={cn(pageStyles["metric-tone"], `metric-tone metric-tone-${tone}`)}>{detail}</em>
    </span>
  );
}

function ActiveCount({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div>
      <dt>
        <i className={cn(pageStyles["active-color"], `active-color active-color-${color}`)} />{" "}
        {label}
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
    <section
      className={cn("dashboard-runner-snapshots", pageStyles["dashboard-runner-snapshots"])}
      aria-label="未分组执行机"
    >
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
              <span
                className={cn(
                  pageStyles["runner-snapshot-state"],
                  `runner-snapshot-state runner-snapshot-state runner-snapshot-state-${runner.state}`,
                )}
              >
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
    <div className={cn("failure-scope-metrics", pageStyles["failure-scope-metrics"])}>
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
    <div className={cn("failure-triage-insight", pageStyles["failure-triage-insight"])}>
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
        { count: summary.runningRuns, color: "var(--info)" },
        { count: summary.succeededRuns, color: "var(--success)" },
        { count: summary.failedRuns, color: "var(--destructive)" },
        { count: summary.pendingRuns, color: "var(--info)" },
      ],
      summary.totalRuns,
      "var(--border)",
    ),
  };
}

function failureDonutStyle(failures: AnalyticsSummary["failures"]): CSSProperties {
  const palette = [
    "var(--destructive)",
    "var(--warning)",
    "var(--success)",
    "var(--info)",
    "var(--muted-foreground)",
  ];
  const segments = failures.slice(0, palette.length).map((failure, index) => ({
    count: failure.count,
    color: palette[index]!,
  }));
  return {
    background: conicGradient(
      segments,
      segments.reduce((total, segment) => total + segment.count, 0),
      "var(--border)",
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

const pageStyles = {
  "active-batch-icon": "inline-grid place-items-center rounded-lg w-8 h-8 bg-info/10 text-info",
  "active-batch-list": "grid gap-2",
  "active-batch-progress":
    "flex flex-col gap-1 items-end [&_b]:text-info [&_b]:text-xs [&_i]:block [&_i]:w-14 [&_i]:h-1 [&_i]:overflow-hidden [&_i]:rounded-full [&_i]:bg-border [&_em]:block [&_em]:h-full [&_em]:rounded-xl [&_em]:bg-info",
  "active-batch-summary":
    "grid grid-cols-[auto_minmax(0,_1fr)_auto] items-center gap-2.5 border border-solid border-border rounded-lg p-2.5 bg-muted transition-colors duration-150 motion-reduce:transition-none [&:hover]:[border-color:color-mix(in_srgb,_var(--info)_26%,_var(--border))] [&:hover]:[background:color-mix(in_srgb,_var(--info)_4%,_var(--card))] [&_>_span:nth-child(2)]:flex [&_>_span:nth-child(2)]:min-w-0 [&_>_span:nth-child(2)]:flex-col [&_>_span:nth-child(2)]:gap-[3px] [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_strong]:text-xs [&_small]:overflow-hidden [&_small]:text-ellipsis [&_small]:whitespace-nowrap [&_small]:text-muted-foreground [&_small]:text-xs",
  "active-color":
    "[&.active-color-blue]:bg-info [&.active-color-green]:bg-success [&.active-color-orange]:bg-destructive [&.active-color-violet]:bg-info",
  "active-run-donut":
    'relative grid rounded-full place-items-center w-[108px] h-[108px] bg-border [&::after]:absolute [&::after]:rounded-xl [&::after]:bg-card [&::after]:[content:""] [&::after]:[inset:9px] [&_>_span]:z-1 [&_>_span]:flex [&_>_span]:flex-col [&_>_span]:items-center [&_strong]:text-2xl [&_strong]:tracking-normal [&_small]:text-muted-foreground [&_small]:text-xs max-[1051px]:w-[98px] max-[1051px]:h-[98px]',
  "active-run-overview":
    "grid grid-cols-[112px_minmax(0,_1fr)] gap-[17px] items-center [margin:22px_0_17px] [&_dl]:grid [&_dl]:gap-[9px] [&_dl]:m-0 [&_dl_>_div]:flex [&_dl_>_div]:items-center [&_dl_>_div]:justify-between [&_dt]:flex [&_dt]:items-center [&_dt]:gap-[7px] [&_dt]:text-muted-foreground [&_dt]:text-xs [&_dt_i]:inline-block [&_dt_i]:w-[7px] [&_dt_i]:h-[7px] [&_dt_i]:rounded-full [&_dd]:m-0 [&_dd]:text-xs [&_dd]:font-semibold max-[1051px]:grid-cols-[100px_minmax(0,_1fr)] max-[1051px]:gap-3",
  "activity-summary-strip":
    "flex flex-wrap items-center gap-[7px] [margin:17px_0_2px] [&_>_span]:inline-flex [&_>_span]:items-center [&_>_span]:gap-1 [&_>_span]:rounded-full [&_>_span]:py-[5px] [&_>_span]:px-2 [&_>_span]:bg-muted [&_>_span]:text-muted-foreground [&_>_span]:text-xs [&_>_span:last-child]:ml-auto [&_>_span:last-child]:bg-transparent [&_>_span:last-child]:text-muted-foreground",
  "dashboard-card-icon":
    "inline-grid w-9 h-9 [flex:0_0_36px] place-items-center rounded-lg [&.dashboard-card-icon-blue]:bg-info/10 [&.dashboard-card-icon-blue]:text-info [&.dashboard-card-icon-green]:bg-success/10 [&.dashboard-card-icon-green]:text-success [&.dashboard-card-icon-violet]:[background:color-mix(in_srgb,_var(--info)_10%,_var(--card))] [&.dashboard-card-icon-violet]:text-info [&.dashboard-card-icon-red]:bg-destructive/10 [&.dashboard-card-icon-red]:text-destructive [&.dashboard-card-icon-amber]:bg-warning/10 [&.dashboard-card-icon-amber]:text-warning",
  "dashboard-card-link":
    "text-info text-xs font-semibold inline-flex [flex:0_0_auto] items-center gap-1",
  "dashboard-date": "border-l border-solid border-border pl-[9px] text-muted-foreground text-xs",
  "dashboard-eyebrow": "inline-flex items-center gap-1.5 text-info text-xs font-semibold",
  "dashboard-focus":
    "relative z-1 flex w-[min(360px,_36%)] min-w-[280px] flex-col gap-[5px] border border-solid border-border rounded-lg py-[15px] px-4 [background:color-mix(in_srgb,_var(--dashboard-focus-color)_7%,_var(--card))] text-foreground transition-colors duration-150 motion-reduce:transition-none [&:hover]:[border-color:color-mix(in_srgb,_var(--dashboard-focus-color)_38%,_var(--border))] [&:hover]:shadow-xs [&_>_span]:flex [&_>_span]:items-center [&_>_span]:justify-between [&_>_span]:[color:var(--dashboard-focus-color)] [&_>_span]:text-xs [&_>_span]:font-semibold [&_strong]:overflow-hidden [&_strong]:text-sm [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_small]:text-muted-foreground [&_small]:text-xs [&_small]:leading-[1.5] max-[1181px]:w-auto max-[1181px]:min-w-0 [&.dashboard-focus-info]:[--dashboard-focus-color:var(--info)] [&.dashboard-focus-success]:[--dashboard-focus-color:var(--success)] [&.dashboard-focus-warning]:[--dashboard-focus-color:var(--warning)] [&.dashboard-focus-danger]:[--dashboard-focus-color:var(--destructive)]",
  "dashboard-library-actions":
    "grid grid-cols-[minmax(0,_1fr)_auto] gap-[9px] items-center [&_>_a:last-child:not(:first-child)]:border [&_>_a:last-child:not(:first-child)]:border-solid [&_>_a:last-child:not(:first-child)]:border-border [&_>_a:last-child:not(:first-child)]:rounded-lg [&_>_a:last-child:not(:first-child)]:py-2 [&_>_a:last-child:not(:first-child)]:px-[11px] [&_>_a:last-child:not(:first-child)]:text-muted-foreground [&_>_a:last-child:not(:first-child)]:text-xs [&_>_a:last-child:not(:first-child)]:font-semibold",
  "dashboard-library-overview":
    "grid grid-cols-[84px_minmax(0,_1fr)] gap-3.5 items-center mt-4.5 border border-solid border-border rounded-lg p-[13px] [background:color-mix(in_srgb,_var(--info)_4%,_var(--card))] [&_>_span]:grid [&_>_span]:min-h-18 [&_>_span]:[place-content:center] [&_>_span]:rounded-lg [&_>_span]:bg-info/10 [&_>_span]:text-info [&_>_span]:text-center [&_>_span_strong]:text-2xl [&_>_span_strong]:tracking-normal [&_small]:text-muted-foreground [&_small]:text-xs [&_p]:text-muted-foreground [&_p]:text-xs [&_p]:col-span-full [&_p]:m-0 [&_>_div]:grid [&_>_div]:grid-cols-[minmax(0,_1fr)_auto] [&_>_div]:gap-[5px_8px] [&_>_div]:items-baseline [&_>_div_>_strong]:text-info [&_>_div_>_strong]:text-lg [&_>_div_>_em]:block [&_>_div_>_em]:h-[5px] [&_>_div_>_em]:overflow-hidden [&_>_div_>_em]:col-span-full [&_>_div_>_em]:rounded-full [&_>_div_>_em]:bg-border [&_>_div_>_em_i]:block [&_>_div_>_em_i]:h-full [&_>_div_>_em_i]:rounded-xl [&_>_div_>_em_i]:bg-info",
  "dashboard-page":
    "grid w-[min(100%,_clamp(1760px,_calc(100vw_-_300px),_3200px))] my-0 mx-auto gap-4",
  "dashboard-period":
    "rounded-full py-[5px] px-[9px] bg-muted text-muted-foreground text-xs font-semibold",
  "dashboard-period-block":
    "grid justify-items-end gap-1 [&_time]:text-muted-foreground [&_time]:text-xs [&_time]:font-medium [&_time]:whitespace-nowrap [&_>_small]:text-muted-foreground [&_>_small]:text-xs [&_>_small]:font-medium [&_>_small]:whitespace-nowrap",
  "dashboard-pulse":
    "[--dashboard-pulse-color:var(--info)] grid min-w-0 min-h-21.5 grid-cols-[auto_minmax(0,_1fr)_auto] items-center gap-[11px] border border-solid border-border rounded-lg py-[13px] px-3.5 bg-card shadow-xs text-foreground transition-colors duration-150 motion-reduce:transition-none [&:hover]:[border-color:color-mix(in_srgb,_var(--dashboard-pulse-color)_32%,_var(--border))] [&:hover]:shadow-xs [&_>_span:nth-child(2)]:grid [&_>_span:nth-child(2)]:min-w-0 [&_>_span:nth-child(2)]:grid-cols-[minmax(0,_1fr)_auto] [&_>_span:nth-child(2)]:gap-[1px_8px] [&_>_span:nth-child(2)]:items-baseline [&_small]:overflow-hidden [&_small]:text-muted-foreground [&_small]:text-xs [&_small]:[font-style:normal] [&_small]:text-ellipsis [&_small]:whitespace-nowrap [&_em]:overflow-hidden [&_em]:text-muted-foreground [&_em]:text-xs [&_em]:[font-style:normal] [&_em]:text-ellipsis [&_em]:whitespace-nowrap [&_strong]:[grid-row:span_2] [&_strong]:text-2xl [&_strong]:tabular-nums [&_strong]:tracking-normal [&_>_svg]:self-start [&_>_svg]:text-muted-foreground max-[1051px]:grid-cols-[auto_minmax(0,_1fr)] max-[1051px]:[&_>_svg]:hidden [&.dashboard-pulse-grid]:grid [&.dashboard-pulse-grid]:grid-cols-4 [&.dashboard-pulse-grid]:gap-3 [&.dashboard-pulse-grid]:max-[1181px]:grid-cols-2 [&.dashboard-pulse-success]:[--dashboard-pulse-color:var(--success)] [&.dashboard-pulse-warning]:[--dashboard-pulse-color:var(--warning)] [&.dashboard-pulse-danger]:[--dashboard-pulse-color:var(--destructive)] [&.dashboard-pulse-violet]:[--dashboard-pulse-color:var(--info)] [&.dashboard-pulse-icon]:inline-grid [&.dashboard-pulse-icon]:w-9.5 [&.dashboard-pulse-icon]:h-9.5 [&.dashboard-pulse-icon]:place-items-center [&.dashboard-pulse-icon]:rounded-lg [&.dashboard-pulse-icon]:[background:color-mix(in_srgb,_var(--dashboard-pulse-color)_10%,_var(--card))] [&.dashboard-pulse-icon]:[color:var(--dashboard-pulse-color)]",
  "dashboard-pulse-grid": "grid grid-cols-4 gap-3 max-[1181px]:grid-cols-2",
  "dashboard-pulse-icon":
    "inline-grid w-9.5 h-9.5 place-items-center rounded-lg [background:color-mix(in_srgb,_var(--dashboard-pulse-color)_10%,_var(--card))] [color:var(--dashboard-pulse-color)]",
  "dashboard-quick-links":
    "flex flex-wrap gap-[7px] mt-3.5 [&_a]:inline-flex [&_a]:min-h-8 [&_a]:items-center [&_a]:gap-1.5 [&_a]:border [&_a]:border-solid [&_a]:border-border [&_a]:rounded-full [&_a]:py-0 [&_a]:px-2.5 [&_a]:[background:color-mix(in_srgb,_var(--card)_84%,_transparent)] [&_a]:text-muted-foreground [&_a]:text-xs [&_a]:font-semibold [&_a]:transition-colors [&_a]:duration-150 [&_a]:motion-reduce:transition-none [&_a:hover]:[border-color:color-mix(in_srgb,_var(--info)_34%,_var(--border))] [&_a:hover]:text-info",
  "dashboard-runner-group-grid":
    "[&_>_a_>_span:first-child_i]:inline-block [&_>_a_>_span:first-child_i]:w-[7px] [&_>_a_>_span:first-child_i]:h-[7px] [&_>_a_>_span:first-child_i]:rounded-full [&_>_a_>_span:first-child_i]:ml-auto [&_>_a_>_em]:block [&_>_a_>_em]:w-full [&_>_a_>_em]:h-1 [&_>_a_>_em]:overflow-hidden [&_>_a_>_em]:rounded-full [&_>_a_>_em]:bg-border [&_>_a_>_em_i]:block [&_>_a_>_em_i]:h-full [&_>_a_>_em_i]:rounded-xl [&_>_a_>_em_i]:bg-info [&_.online]:bg-success [&_.offline]:bg-muted-foreground grid grid-cols-3 gap-2.5 my-4 mx-0 [&_>_a]:flex [&_>_a]:min-w-0 [&_>_a]:flex-col [&_>_a]:gap-2 [&_>_a]:border [&_>_a]:border-solid [&_>_a]:border-border [&_>_a]:rounded-lg [&_>_a]:p-[11px] [&_>_a]:bg-muted [&_>_a]:transition-colors [&_>_a]:duration-150 [&_>_a]:motion-reduce:transition-none [&_>_a:hover]:border-info/10 [&_>_a_>_span]:flex [&_>_a_>_span]:min-w-0 [&_>_a_>_span]:items-center [&_>_a_>_span]:justify-between [&_>_a_>_span]:gap-1.5 [&_>_a_>_span]:text-muted-foreground [&_>_a_>_span]:text-xs [&_>_a_>_span:first-child]:justify-start [&_strong]:text-foreground [&_strong]:text-xs [&_strong]:[overflow-wrap:anywhere] [&_strong]:whitespace-normal [&_b]:text-info max-[1440px]:grid-cols-2",
  "dashboard-runner-snapshots":
    "grid gap-[9px] my-3.5 mx-0 [&_>_header]:flex [&_>_header]:items-center [&_>_header]:justify-between [&_>_header]:gap-3 [&_>_header_>_span]:inline-flex [&_>_header_>_span]:items-center [&_>_header_>_span]:gap-[5px] [&_>_header_>_span]:text-xs [&_>_header_>_span]:font-semibold [&_>_header_>_span]:text-muted-foreground [&_>_header_>_a]:inline-flex [&_>_header_>_a]:items-center [&_>_header_>_a]:gap-[5px] [&_>_header_>_a]:text-xs [&_>_header_>_a]:font-semibold [&_>_header_>_a]:text-info [&_>_div]:grid [&_>_div]:grid-cols-[repeat(auto-fit,_minmax(280px,_1fr))] [&_>_div]:gap-2 [&_>_div_>_a]:grid [&_>_div_>_a]:min-w-0 [&_>_div_>_a]:grid-cols-[auto_minmax(0,_1fr)_auto_auto_auto] [&_>_div_>_a]:items-center [&_>_div_>_a]:gap-[9px] [&_>_div_>_a]:border [&_>_div_>_a]:border-solid [&_>_div_>_a]:border-border [&_>_div_>_a]:rounded-lg [&_>_div_>_a]:py-[9px] [&_>_div_>_a]:px-2.5 [&_>_div_>_a]:bg-muted [&_>_div_>_a]:text-foreground [&_>_div_>_a]:transition-colors [&_>_div_>_a]:duration-150 [&_>_div_>_a]:motion-reduce:transition-none [&_>_div_>_a:hover]:[border-color:color-mix(in_srgb,_var(--success)_30%,_var(--border))] [&_>_div_>_a:hover]:[background:color-mix(in_srgb,_var(--success)_4%,_var(--card))] [&_>_div_>_a_>_span:not(.runner-snapshot-state)]:grid [&_>_div_>_a_>_span:not(.runner-snapshot-state)]:min-w-0 [&_>_div_>_a_>_span:not(.runner-snapshot-state)]:gap-0.5 [&_>_div_>_a_>_span:nth-child(n_+_3)]:text-right [&_>_div_>_a_>_time]:text-right [&_>_div_>_a_>_time]:grid [&_>_div_>_a_>_time]:gap-0.5 [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_strong]:text-xs [&_small]:overflow-hidden [&_small]:text-ellipsis [&_small]:whitespace-nowrap [&_small]:text-muted-foreground [&_small]:text-xs",
  "dashboard-welcome":
    'relative flex min-w-0 overflow-hidden items-center justify-between gap-6 border border-solid border-border rounded-xl py-4 px-5 bg-card shadow-xs min-h-0 [&::after]:absolute [&::after]:top-[-58px] [&::after]:right-[22%] [&::after]:w-[150px] [&::after]:h-[150px] [&::after]:border [&::after]:border-solid [&::after]:border-transparent [&::after]:rounded-full [&::after]:[content:""] [&::after]:pointer-events-none [&_h1]:flex [&_h1]:items-baseline [&_h1]:gap-0 [&_h1]:m-0 [&_h1]:text-2xl [&_h1]:font-normal [&_h1]:tracking-tight [&_strong]:font-semibold [&_p]:max-w-[660px] [&_p]:[margin:6px_0_0] [&_p]:text-muted-foreground [&_p]:text-sm [&_p]:leading-[1.6] max-[1181px]:items-stretch max-[1181px]:flex-col max-[1051px]:py-[19px] max-[1051px]:px-5',
  "dashboard-welcome-copy": "relative z-1 min-w-0",
  "dashboard-welcome-meta": "flex items-center gap-[9px] mb-[7px]",
  "design-active-card": "[--dashboard-card-accent:var(--info)]",
  "design-activity-icon":
    "inline-grid place-items-center rounded-lg w-7 h-7 bg-info/10 text-info [&.success]:bg-success/10 [&.success]:text-success [&.danger]:bg-destructive/10 [&.danger]:text-destructive [&.warning]:bg-warning/10 [&.warning]:text-warning",
  "design-activity-list":
    "[&_a_>_span:nth-child(2)]:flex [&_a_>_span:nth-child(2)]:min-w-0 [&_a_>_span:nth-child(2)]:flex-col [&_a_>_span:nth-child(2)]:gap-[3px] grid mt-3 [&_>_a]:grid [&_>_a]:grid-cols-[auto_minmax(0,_1fr)_auto] [&_>_a]:items-center [&_>_a]:gap-[9px] [&_>_a]:min-h-[49px] [&_>_a]:border-b [&_>_a]:border-solid [&_>_a]:border-border [&_>_a]:rounded-md [&_>_a]:py-0 [&_>_a]:px-1.5 [&_>_a]:transition-colors [&_>_a]:duration-150 [&_>_a]:motion-reduce:transition-none [&_>_a:hover]:bg-muted [&_strong]:[overflow-wrap:anywhere] [&_strong]:whitespace-normal [&_strong]:text-xs [&_small]:[overflow-wrap:anywhere] [&_small]:whitespace-normal [&_small]:text-muted-foreground [&_small]:text-xs [&_time]:text-muted-foreground [&_time]:text-xs [&_time]:whitespace-nowrap",
  "design-card-heading":
    "flex items-center min-h-7 justify-between gap-3 [&_>_div]:flex [&_>_div]:items-center [&_>_div]:min-w-0 [&_>_div]:gap-2.5 [&_>_div_>_span:last-child]:grid [&_>_div_>_span:last-child]:min-w-0 [&_>_div_>_span:last-child]:gap-px [&_h2]:m-0 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:tracking-tight [&_small]:overflow-hidden [&_small]:text-muted-foreground [&_small]:text-xs [&_small]:text-ellipsis [&_small]:whitespace-nowrap [&_>_a]:text-info [&_>_a]:text-xs [&_>_a]:font-semibold",
  "design-dashboard-grid":
    'grid grid-cols-4 gap-4 items-stretch [&_>_.card]:[--dashboard-card-accent:var(--info)] [&_>_.card]:relative [&_>_.card]:min-w-0 [&_>_.card]:min-h-[330px] [&_>_.card]:overflow-hidden [&_>_.card]:p-5.5 [&_>_.card]:bg-card [&_>_.card]:transition-colors [&_>_.card]:duration-150 [&_>_.card]:motion-reduce:transition-none [&_>_.card::before]:absolute [&_>_.card::before]:top-0 [&_>_.card::before]:right-6 [&_>_.card::before]:left-6 [&_>_.card::before]:h-0.5 [&_>_.card::before]:rounded-none [&_>_.card::before]:bg-card [&_>_.card::before]:[content:""] [&_>_.card::before]:opacity-42 [&_>_.card:hover]:[border-color:color-mix(in_srgb,_var(--dashboard-card-accent)_20%,_var(--border))] [&_>_.card:hover]:shadow-xs max-[1440px]:grid-cols-3 max-[1181px]:grid-cols-2',
  "design-empty-state":
    "[&_a]:text-info [&_a]:text-xs [&_a]:font-semibold flex min-h-[180px] flex-col items-center justify-center gap-[7px] text-muted-foreground text-center [&.compact]:min-h-[132px] [&_strong]:text-muted-foreground [&_strong]:text-xs [&_p]:max-w-[300px] [&_p]:m-0 [&_p]:text-xs [&_p]:leading-[1.5]",
  "design-failure-card":
    "[--dashboard-card-accent:var(--destructive)] flex flex-col max-[1181px]:[grid-column:span_2]",
  "design-library-action":
    "text-info text-xs font-semibold block rounded-lg p-[9px] bg-info/10 text-center",
  "design-library-card": "[--dashboard-card-accent:var(--info)]",
  "design-quality-card":
    "[--dashboard-card-accent:var(--info)] [grid-column:span_2] max-[1440px]:[grid-column:span_2] max-[1181px]:[grid-column:span_2]",
  "design-recent-card":
    "[--dashboard-card-accent:var(--warning)] flex flex-col [&_.ui-card-content_>_.design-empty-state]:flex-1 max-[1440px]:[grid-column:span_2] max-[1181px]:[grid-column:span_2]",
  "design-runner-groups-card":
    "[--dashboard-card-accent:var(--success)] flex flex-col [grid-column:span_2] max-[1440px]:[grid-column:span_2] max-[1181px]:[grid-column:span_2]",
  "design-stat-list":
    "[&_dt_>_span]:inline-grid [&_dt_>_span]:place-items-center [&_dt_>_span]:rounded-lg [&_dt_>_span]:w-6.5 [&_dt_>_span]:h-6.5 [&_dt_>_span]:bg-info/10 [&_dt_>_span]:text-info grid gap-[3px] [margin:17px_0_14px] [&_>_div]:flex [&_>_div]:items-center [&_>_div]:justify-between [&_>_div]:min-h-9 [&_>_div]:border-b [&_>_div]:border-solid [&_>_div]:border-border [&_dt]:flex [&_dt]:items-center [&_dt]:gap-2 [&_dt]:text-muted-foreground [&_dt]:text-xs [&_dd]:m-0 [&_dd]:text-base [&_dd]:font-semibold",
  "failure-action-strip":
    "grid grid-cols-[repeat(2,_minmax(0,_1fr))_auto] items-stretch [margin:auto_-22px_-22px] border-t border-solid border-border [&_>_span]:grid [&_>_span]:gap-[3px] [&_>_span]:py-[13px] [&_>_span]:px-[15px] [&_>_span_+_span]:border-l [&_>_span_+_span]:border-solid [&_>_span_+_span]:border-border [&_small]:text-muted-foreground [&_small]:text-xs [&_strong]:overflow-hidden [&_strong]:text-sm [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_>_a]:inline-flex [&_>_a]:items-center [&_>_a]:gap-1 [&_>_a]:border-l [&_>_a]:border-solid [&_>_a]:border-border [&_>_a]:py-[13px] [&_>_a]:px-[15px] [&_>_a]:text-destructive [&_>_a]:text-xs [&_>_a]:font-semibold max-[1051px]:grid-cols-2 max-[1051px]:[&_>_a]:col-span-full max-[1051px]:[&_>_a]:justify-center max-[1051px]:[&_>_a]:border-t max-[1051px]:[&_>_a]:border-solid max-[1051px]:[&_>_a]:border-border max-[1051px]:[&_>_a]:border-l-0",
  "failure-donut":
    'relative grid rounded-full place-items-center w-20.5 h-20.5 bg-border [&::after]:absolute [&::after]:rounded-xl [&::after]:bg-card [&::after]:[content:""] [&::after]:[inset:8px] [&_>_span]:z-1 [&_>_span]:flex [&_>_span]:flex-col [&_>_span]:items-center [&_strong]:text-2xl [&_strong]:tracking-normal [&_small]:text-muted-foreground [&_small]:text-xs',
  "failure-overview": "grid grid-cols-[82px_minmax(0,_1fr)] gap-3.5 items-center my-4.5 mx-0",
  "failure-reason-list":
    '[&_i]:inline-block [&_i]:w-[7px] [&_i]:h-[7px] [&_i]:rounded-full grid gap-2 [&_>_div]:flex [&_>_div]:min-w-0 [&_>_div]:items-center [&_>_div]:gap-[7px] [&_>_.failure-reason-row]:grid [&_>_.failure-reason-row]:gap-[5px] [&_i[data-index="0"]]:bg-destructive [&_i[data-index="1"]]:bg-destructive/10 [&_i[data-index="2"]]:bg-warning/10 [&_i[data-index="3"]]:bg-info [&_i[data-index="4"]]:bg-muted-foreground [&_span]:min-w-0 [&_span]:flex-1 [&_span]:overflow-hidden [&_span]:text-xs [&_span]:text-ellipsis [&_span]:whitespace-nowrap [&_strong]:text-xs',
  "failure-reason-row":
    "[&_>_span]:flex [&_>_span]:min-w-0 [&_>_span]:items-center [&_>_span]:gap-[7px] [&_>_em]:block [&_>_em]:h-[3px] [&_>_em]:overflow-hidden [&_>_em]:rounded-full [&_>_em]:bg-border [&_>_em_>_i]:block [&_>_em_>_i]:h-full [&_>_em_>_i]:rounded-xl [&_>_em_>_i]:[background:color-mix(in_srgb,_var(--destructive)_72%,_var(--warning))]",
  "failure-scope-metrics":
    "grid grid-cols-3 mb-2.5 border border-solid border-border rounded-lg bg-muted [&_>_span]:grid [&_>_span]:gap-[3px] [&_>_span]:py-[9px] [&_>_span]:px-2.5 [&_>_span_+_span]:border-l [&_>_span_+_span]:border-solid [&_>_span_+_span]:border-border [&_small]:overflow-hidden [&_small]:text-muted-foreground [&_small]:text-xs [&_small]:text-ellipsis [&_small]:whitespace-nowrap [&_strong]:text-sm",
  "failure-triage-insight":
    "grid grid-cols-[auto_minmax(0,_1fr)] items-center gap-2.5 border border-solid border-border rounded-lg py-2.5 px-[11px] [background:color-mix(in_srgb,_var(--destructive)_4%,_var(--card))] [&_>_span]:inline-grid [&_>_span]:w-[33px] [&_>_span]:h-[33px] [&_>_span]:place-items-center [&_>_span]:rounded-lg [&_>_span]:bg-destructive/10 [&_>_span]:text-destructive [&_>_div]:grid [&_>_div]:min-w-0 [&_>_div]:grid-cols-[minmax(0,_1fr)_auto] [&_>_div]:gap-[2px_7px] [&_>_div]:items-baseline [&_small]:text-muted-foreground [&_small]:text-xs [&_p]:text-muted-foreground [&_p]:text-xs [&_p]:overflow-hidden [&_p]:col-span-full [&_p]:m-0 [&_p]:text-ellipsis [&_p]:whitespace-nowrap [&_strong]:text-destructive [&_strong]:text-xs",
  "idle-execution-state": "flex min-h-[266px] flex-col [&_.design-empty-state]:flex-1",
  "latest-batch-summary":
    "grid grid-cols-[auto_minmax(0,_1fr)_auto] items-center gap-[9px] border border-solid border-border rounded-lg p-2.5 bg-muted text-foreground [&_>_span:first-child]:inline-grid [&_>_span:first-child]:w-7.5 [&_>_span:first-child]:h-7.5 [&_>_span:first-child]:place-items-center [&_>_span:first-child]:rounded-lg [&_>_span:first-child.success]:bg-success/10 [&_>_span:first-child.success]:text-success [&_>_span:first-child.warning]:bg-warning/10 [&_>_span:first-child.warning]:text-warning [&_>_span:first-child.danger]:bg-destructive/10 [&_>_span:first-child.danger]:text-destructive [&_>_span:nth-child(2)]:grid [&_>_span:nth-child(2)]:min-w-0 [&_>_span:nth-child(2)]:gap-0.5 [&_small]:text-muted-foreground [&_small]:text-xs [&_strong]:text-xs [&_strong]:[overflow-wrap:anywhere] [&_strong]:whitespace-normal [&_b]:text-xs [&_b]:whitespace-nowrap [&_b.success]:text-success [&_b.warning]:text-warning [&_b.danger]:text-destructive",
  "metric-tone":
    "[&.metric-tone-success]:text-success [&.metric-tone-danger]:text-destructive [&.metric-tone-info]:text-info [&.metric-tone-warning]:text-warning",
  "quality-caption": "[margin:6px_0_0] text-muted-foreground text-xs",
  "quality-chart-empty":
    "h-[140px] mt-1 grid place-items-center border-b border-dashed border-border text-muted-foreground text-xs",
  "quality-grade":
    "ml-auto border border-solid border-border rounded-full py-1 px-2 [background:color-mix(in_srgb,_var(--quality-grade-color)_8%,_var(--card))] [color:var(--quality-grade-color)] text-xs [font-style:normal] font-semibold [&.quality-grade-success]:[--quality-grade-color:var(--success)] [&.quality-grade-warning]:[--quality-grade-color:var(--warning)] [&.quality-grade-danger]:[--quality-grade-color:var(--destructive)] [&.quality-grade-neutral]:[--quality-grade-color:var(--muted-foreground)]",
  "quality-metric-strip":
    "grid border-t border-solid border-border grid-cols-4 [margin:6px_-22px_-22px] [&_>_span]:flex [&_>_span]:min-w-0 [&_>_span]:flex-col [&_>_span]:gap-[3px] [&_>_span]:py-[13px] [&_>_span]:px-4 [&_>_span_+_span]:border-l [&_>_span_+_span]:border-solid [&_>_span_+_span]:border-border [&_small]:text-muted-foreground [&_small]:text-xs [&_strong]:text-lg [&_strong]:font-semibold [&_em]:overflow-hidden [&_em]:text-xs [&_em]:[font-style:normal] [&_em]:text-ellipsis [&_em]:whitespace-nowrap",
  "quality-outcome":
    "[&.quality-outcome-distribution]:grid [&.quality-outcome-distribution]:gap-2 [&.quality-outcome-distribution]:[margin:3px_0_10px] [&.quality-outcome-distribution]:[&_>_div:last-child]:flex [&.quality-outcome-distribution]:[&_>_div:last-child]:flex-wrap [&.quality-outcome-distribution]:[&_>_div:last-child]:gap-[8px_16px] [&.quality-outcome-distribution]:[&_>_div:last-child_>_span]:inline-flex [&.quality-outcome-distribution]:[&_>_div:last-child_>_span]:items-center [&.quality-outcome-distribution]:[&_>_div:last-child_>_span]:gap-[5px] [&.quality-outcome-distribution]:[&_>_div:last-child_>_span]:text-muted-foreground [&.quality-outcome-distribution]:[&_>_div:last-child_>_span]:text-xs [&.quality-outcome-distribution]:[&_>_div:last-child_i]:w-[7px] [&.quality-outcome-distribution]:[&_>_div:last-child_i]:h-[7px] [&.quality-outcome-distribution]:[&_>_div:last-child_i]:rounded-full [&.quality-outcome-distribution]:[&_strong]:text-foreground [&.quality-outcome-bar]:flex [&.quality-outcome-bar]:w-full [&.quality-outcome-bar]:h-[7px] [&.quality-outcome-bar]:overflow-hidden [&.quality-outcome-bar]:rounded-full [&.quality-outcome-bar]:bg-muted [&.quality-outcome-bar]:[&_>_i]:block [&.quality-outcome-bar]:[&_>_i]:min-w-0 [&.quality-outcome-bar]:[&_>_i]:h-full [&.quality-outcome-passed]:bg-success [&.quality-outcome-failed]:bg-destructive [&.quality-outcome-skipped]:bg-warning",
  "quality-outcome-bar":
    "flex w-full h-[7px] overflow-hidden rounded-full bg-muted [&_>_i]:block [&_>_i]:min-w-0 [&_>_i]:h-full",
  "quality-outcome-distribution":
    "grid gap-2 [margin:3px_0_10px] [&_>_div:last-child]:flex [&_>_div:last-child]:flex-wrap [&_>_div:last-child]:gap-[8px_16px] [&_>_div:last-child_>_span]:inline-flex [&_>_div:last-child_>_span]:items-center [&_>_div:last-child_>_span]:gap-[5px] [&_>_div:last-child_>_span]:text-muted-foreground [&_>_div:last-child_>_span]:text-xs [&_>_div:last-child_i]:w-[7px] [&_>_div:last-child_i]:h-[7px] [&_>_div:last-child_i]:rounded-full [&_strong]:text-foreground",
  "quality-score-row":
    "flex items-baseline gap-[5px] mt-[15px] [&_>_strong]:text-4xl [&_>_strong]:font-semibold [&_>_strong]:tracking-normal [&_>_strong]:leading-[1] [&_>_span]:text-muted-foreground [&_>_span]:text-sm [&_>_b]:ml-[7px] [&_>_b]:text-xs",
  "quality-trend-chart":
    "h-[140px] mt-1 [&_svg]:block [&_svg]:w-full [&_svg]:h-[122px] [&_svg]:overflow-visible [&_line]:stroke-foreground [&_line]:[stroke-width:1] [&_.quality-trend-scale]:fill-muted-foreground [&_.quality-trend-scale]:text-xs [&_polygon]:fill-info [&_polyline]:[fill:none] [&_polyline]:stroke-info [&_polyline]:[stroke-linecap:round] [&_polyline]:[stroke-linejoin:round] [&_polyline]:[stroke-width:2.5] [&_circle]:fill-card [&_circle]:stroke-info [&_circle]:[stroke-width:2.5] [&_.quality-trend-value_rect]:fill-card [&_.quality-trend-value_rect]:[stroke:color-mix(in_srgb,_var(--info)_24%,_var(--border))] [&_.quality-trend-value_text]:fill-info [&_.quality-trend-value_text]:text-xs [&_.quality-trend-value_text]:font-semibold [&_>_div]:flex [&_>_div]:justify-between [&_>_div]:py-0 [&_>_div]:px-[2.5%] [&_>_div]:text-muted-foreground [&_>_div]:text-xs [&_>_div.single]:justify-center",
  "runner-capacity-overview":
    "grid gap-[9px] mt-4.5 border border-solid border-border rounded-lg py-[13px] px-3.5 [background:color-mix(in_srgb,_var(--success)_4%,_var(--card))] [&_>_div:first-child]:flex [&_>_div:first-child]:items-end [&_>_div:first-child]:justify-between [&_>_div:first-child]:gap-3 [&_>_div:first-child_>_span]:grid [&_>_div:first-child_>_span]:gap-[3px] [&_small]:text-muted-foreground [&_small]:text-xs [&_>_div:first-child_strong]:text-2xl [&_>_div:first-child_strong]:tracking-normal [&_>_div:first-child_em]:text-muted-foreground [&_>_div:first-child_em]:text-xs [&_>_div:first-child_em]:[font-style:normal] [&_>_div:first-child_em]:font-medium [&_>_div:first-child_em]:tracking-normal [&_>_div:first-child_b]:text-success [&_>_div:first-child_b]:text-xs [&_>_span]:block [&_>_span]:h-1.5 [&_>_span]:overflow-hidden [&_>_span]:rounded-full [&_>_span]:bg-border [&_>_span_i]:block [&_>_span_i]:h-full [&_>_span_i]:rounded-xl [&_>_span_i]:bg-success",
  "runner-resource-pills":
    "flex flex-wrap gap-1.5 [&_>_span]:rounded-full [&_>_span]:py-1 [&_>_span]:px-2 [&_>_span]:bg-muted [&_>_span]:text-muted-foreground [&_>_span]:text-xs [&_strong]:text-muted-foreground",
  "runner-snapshot-state":
    "inline-grid w-7.5 h-7.5 place-items-center rounded-lg [&.runner-snapshot-state-online]:bg-success/10 [&.runner-snapshot-state-online]:text-success [&.runner-snapshot-state-draining]:bg-warning/10 [&.runner-snapshot-state-draining]:text-warning [&.runner-snapshot-state-offline]:bg-card [&.runner-snapshot-state-offline]:text-muted-foreground [&.runner-snapshot-state-disabled]:bg-card [&.runner-snapshot-state-disabled]:text-muted-foreground",
  "runner-total-strip":
    "grid border-t border-solid border-border grid-cols-4 [margin:auto_-22px_-22px] [&_>_span]:flex [&_>_span]:min-w-0 [&_>_span]:flex-col [&_>_span]:gap-[3px] [&_>_span]:py-[13px] [&_>_span]:px-4 [&_>_span]:items-center [&_>_span_+_span]:border-l [&_>_span_+_span]:border-solid [&_>_span_+_span]:border-border [&_small]:text-muted-foreground [&_small]:text-xs [&_strong]:text-base",
} as const;
