import { DatetimeInput, Input, Select } from "@/components/ui";

import type {
  AnalyticsBatchComparison,
  AnalyticsFilter,
  AnalyticsSummary,
} from "@autoforge/contracts";
import type { CaseDefinitionWithMethods } from "@autoforge/domain";
import { BarChart3, FlaskConical, SlidersHorizontal, TrendingUp } from "lucide-react";
import Link from "next/link";
import type { CSSProperties } from "react";

import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { formatRate, type CaseLatestRun } from "@/lib/case-selection-stats";
import { classifyAttemptResult } from "@autoforge/domain";
import { AnalyticsExportControl } from "@/components/analytics-export-control";
import { BatchComparisonDetails } from "@/components/batch-comparison-details";
import { InsightDetailDialog } from "@/components/insight-detail-dialog";
import { NavigationSubmitButton } from "@/components/navigation-submit-button";
import { presentAnalyticsFailure } from "@/lib/analytics-failure-presentation";
import {
  selectableProjectIds,
  selectedProjectHierarchy,
  selectedProjectId,
} from "@/lib/selected-project";
import { formatLocalDateTime, runBatchStatusLabel } from "@/lib/run-batch-presentation";
import {
  platformDateTimeInputValue,
  platformDateTimeParameterToIso,
} from "@/lib/platform-date-time";

const CASE_OUTCOME_PAGE_SIZE = 25;

type CaseOutcomeReport = {
  projectId: string;
  versionId: string;
  versionName: string;
  stageId: string;
  stageName: string;
  cases: CaseDefinitionWithMethods[];
  outcomes: Map<string, CaseLatestRun>;
  executedAt: Map<string, string>;
  nextCursor?: string;
};

export const dynamic = "force-dynamic";

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { identity, projectIds } = await requirePageProjectScope("run.read");
  const services = await getPlatformServices();
  const timeZone = services.configurationStore.read().web.timeZone;
  const parameters = await searchParams;
  const projects = await services.identities
    .listProjects(selectableProjectIds(identity))
    .catch(() => []);
  const caseProjectId = await selectedProjectId(identity, projects, "run.read");
  requireAuthorizedPageProjectScope(identity, "run.read", caseProjectId);
  const projectStructure = caseProjectId
    ? await services.projectStructures.list(caseProjectId).catch(() => undefined)
    : undefined;
  const hierarchy = await selectedProjectHierarchy(projectStructure);
  const filter = {
    ...analyticsFilter(
      {
        ...parameters,
        projectId: undefined,
        projectVersionId: undefined,
        testStageId: undefined,
      },
      timeZone,
    ),
    timeZone,
    ...(caseProjectId ? { projectId: caseProjectId } : {}),
    ...(hierarchy.projectVersionId ? { projectVersionId: hierarchy.projectVersionId } : {}),
    ...(hierarchy.testStageId ? { testStageId: hierarchy.testStageId } : {}),
  };
  const flakyFilter: AnalyticsFilter = {
    timeZone,
    ...(caseProjectId ? { projectId: caseProjectId } : {}),
    ...(hierarchy.projectVersionId ? { projectVersionId: hierarchy.projectVersionId } : {}),
    ...(hierarchy.testStageId ? { testStageId: hierarchy.testStageId } : {}),
    ...(stringParameter(parameters.flakySuiteId)
      ? { suiteId: stringParameter(parameters.flakySuiteId) }
      : {}),
    ...(dateTimeParameter(parameters.flakyCompletedAfter, timeZone)
      ? { completedAfter: dateTimeParameter(parameters.flakyCompletedAfter, timeZone) }
      : {}),
    ...(dateTimeParameter(parameters.flakyCompletedBefore, timeZone)
      ? { completedBefore: dateTimeParameter(parameters.flakyCompletedBefore, timeZone) }
      : {}),
  };
  const [summary, suites, runners, recentBatches] = await Promise.all([
    services.platformOperations.analytics(identity, filter),
    hierarchy.projectVersionId
      ? services.caseSuites.list(
          500,
          caseProjectId ? [caseProjectId] : [],
          hierarchy.projectVersionId,
        )
      : Promise.resolve([]),
    services.runnerControl.list(500),
    hierarchy.projectVersionId
      ? services.runBatches.list(
          100,
          caseProjectId ? [caseProjectId] : [],
          hierarchy.projectVersionId,
        )
      : Promise.resolve([]),
  ]);
  // 默认不稳定用例范围与主筛选一致时复用同一份数据库聚合，避免洞察首屏把
  // 大事实表完整统计两遍；用户单独调整范围后才执行第二次查询。
  const flakySummary = analyticsFiltersEqual(filter, flakyFilter)
    ? summary
    : await services.platformOperations.analytics(identity, flakyFilter);
  const comparison =
    typeof parameters.leftBatchId === "string" && typeof parameters.rightBatchId === "string"
      ? await services.platformOperations.compareBatches(
          identity,
          parameters.leftBatchId,
          parameters.rightBatchId,
        )
      : undefined;
  const caseOutcomeReport = await loadCaseOutcomeReport({
    services,
    ...(caseProjectId ? { caseProjectId } : {}),
    ...(hierarchy.projectVersionId ? { caseProjectVersionId: hierarchy.projectVersionId } : {}),
    ...(hierarchy.testStageId ? { caseTestStageId: hierarchy.testStageId } : {}),
    ...(projectIds ? { allowedProjectIds: projectIds } : {}),
    ...(stringParameter(parameters.caseCursor)
      ? { cursor: stringParameter(parameters.caseCursor) }
      : {}),
  });
  const caseCursorTrail = cursorTrail(parameters.caseTrail);
  const methodSampleCount = summary.passed + summary.failed + summary.skipped;
  return (
    <div className="page-stack insights-page">
      <section className="page-hero">
        <div>
          <span className="eyebrow">Offline Analytics</span>
          <h1>质量洞察</h1>
          <p>从已确认的执行结果重建统计事实，按项目、任务、Runner、环境和时间查看趋势。</p>
        </div>
        <AnalyticsExportControl filter={filter} />
      </section>

      <form className="content-card insight-filter" method="get">
        <div className="insight-primary-filters">
          <label>
            用例任务
            <Select defaultValue={filter.suiteId ?? ""} name="suiteId">
              <option value="">全部任务</option>
              {suites.map((suite) => (
                <option key={suite.id} value={suite.id}>
                  {suite.name}
                </option>
              ))}
            </Select>
          </label>
          <label>
            Runner
            <Select defaultValue={filter.runnerId ?? ""} name="runnerId">
              <option value="">全部 Runner</option>
              {runners.map((runner) => (
                <option key={runner.id} value={runner.id}>
                  {runner.name}
                </option>
              ))}
            </Select>
          </label>
          <label>
            结果
            <Select defaultValue={filter.outcome ?? ""} name="outcome">
              <option value="">全部结果</option>
              <option value="succeeded">成功</option>
              <option value="failed">失败</option>
              <option value="timed_out">超时</option>
              <option value="cancelled">取消</option>
            </Select>
          </label>
          <NavigationSubmitButton
            className="button button-primary"
            key={`primary-${JSON.stringify(filter)}`}
            pendingLabel="正在筛选质量数据…"
            type="submit"
          >
            应用筛选
          </NavigationSubmitButton>
        </div>
        <details className="insight-advanced-filters">
          <summary>
            <SlidersHorizontal aria-hidden="true" size={15} /> 更多筛选条件
          </summary>
          <div>
            <label>
              用例 ID
              <Input defaultValue={filter.caseDefinitionId ?? ""} name="caseDefinitionId" />
            </label>
            <label>
              标签
              <Input defaultValue={filter.tag ?? ""} name="tag" />
            </label>
            <label>
              失败特征
              <Input defaultValue={filter.failureSignature ?? ""} name="failureSignature" />
            </label>
            <label>
              开始时间（平台时区）
              <DatetimeInput
                defaultValue={dateTimeLocal(filter.completedAfter, timeZone)}
                name="completedAfter"
              />
            </label>
            <label>
              结束时间（平台时区）
              <DatetimeInput
                defaultValue={dateTimeLocal(filter.completedBefore, timeZone)}
                name="completedBefore"
              />
            </label>
          </div>
        </details>
      </form>

      <section className="insight-metrics" aria-label="质量指标">
        <Metric icon={FlaskConical} label="执行样本" value={String(summary.sampleCount)} />
        <Metric
          icon={TrendingUp}
          label="方法通过率"
          tone="success"
          value={percent(summary.successRate)}
        />
        <Metric
          icon={BarChart3}
          label="方法失败率"
          tone="danger"
          value={percent(summary.failureRate)}
        />
        <Metric icon={BarChart3} label="P95 耗时" value={duration(summary.durationP95Ms)} />
      </section>

      <section className="insight-grid">
        <article className="content-card insight-chart-card insight-trend-card">
          <div className="section-heading">
            <div>
              <span className="eyebrow">TREND</span>
              <h2>每日趋势</h2>
            </div>
            <div className="insight-heading-actions">
              <span className="muted">
                已确认方法结果 {methodSampleCount} 个 · 执行样本 {summary.sampleCount} 次
              </span>
              <InsightDetailDialog
                description="逐日查看通过、失败与跳过的方法数量。表头固定，数据区域可独立滚动。"
                title="每日趋势明细"
              >
                <div className="insight-detail-table-scroll">
                  <table className="data-table insight-data-table">
                    <thead>
                      <tr>
                        <th>日期（{timeZone}）</th>
                        <th>方法总数</th>
                        <th>通过方法</th>
                        <th>失败方法</th>
                        <th>跳过方法</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.trend.map((bucket) => (
                        <tr key={bucket.bucket}>
                          <td>{bucket.bucket.slice(0, 10)}</td>
                          <td>{bucket.total}</td>
                          <td>{bucket.passed}</td>
                          <td>{bucket.failed}</td>
                          <td>{bucket.skipped}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {summary.trend.length === 0 ? (
                    <div className="inline-empty">当前筛选范围还没有已确认执行结果。</div>
                  ) : null}
                </div>
              </InsightDetailDialog>
            </div>
          </div>
          {summary.trend.length === 0 ? (
            <div className="inline-empty">当前筛选范围还没有已确认执行结果。</div>
          ) : (
            <TrendLineChart trend={summary.trend} />
          )}
        </article>

        <article className="content-card insight-chart-card insight-failure-card">
          <div className="section-heading">
            <div>
              <span className="eyebrow">FAILURES</span>
              <h2>失败原因</h2>
            </div>
            <InsightDetailDialog
              description="正常 TestNG 失败展示错误堆栈；调度、Runner 等异常执行同时展示错误码与错误信息。"
              title="失败原因明细"
            >
              <div className="insight-detail-table-scroll">
                <table className="data-table insight-detail-wide-table">
                  <thead>
                    <tr>
                      <th>错误堆栈 / 错误信息</th>
                      <th>异常错误码</th>
                      <th>次数</th>
                      <th>最近出现时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.failures.map((failure) => {
                      const presentation = presentAnalyticsFailure(failure);
                      return (
                        <tr key={failure.signature}>
                          <td className="insight-detail-long-text" title={presentation.detail}>
                            {presentation.detail}
                          </td>
                          <td title={presentation.errorCode ?? "正常 TestNG 失败，无需错误码"}>
                            {presentation.errorCode ?? "—"}
                          </td>
                          <td>{failure.count}</td>
                          <td>
                            <time
                              dateTime={failure.lastSeenAt}
                              title={`UTC：${failure.lastSeenAt}`}
                            >
                              {formatLocalDateTime(failure.lastSeenAt, timeZone)}
                            </time>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {summary.failures.length === 0 ? (
                  <div className="inline-empty">暂无可聚类的失败。</div>
                ) : null}
              </div>
            </InsightDetailDialog>
          </div>
          {summary.failures.length === 0 ? (
            <div className="inline-empty">暂无可聚类的失败。</div>
          ) : (
            <FailureReasonChart failures={summary.failures} />
          )}
        </article>

        <article className="content-card insight-chart-card insight-flaky-card">
          <div className="section-heading">
            <div>
              <span className="eyebrow">FLAKY</span>
              <h2>不稳定用例</h2>
            </div>
            <InsightDetailDialog
              description="查看当前分析返回的不稳定用例，以及用于判断的成功、失败样本和置信度。"
              title="不稳定用例明细"
            >
              <div className="insight-detail-table-scroll">
                <table className="data-table insight-detail-wide-table">
                  <thead>
                    <tr>
                      <th>用例</th>
                      <th>样本</th>
                      <th>成功</th>
                      <th>失败</th>
                      <th>置信度</th>
                    </tr>
                  </thead>
                  <tbody>
                    {flakySummary.flakyCases.map((item) => (
                      <tr key={item.caseDefinitionId}>
                        <td title={item.displayName}>
                          <Link href={`/cases/${encodeURIComponent(item.caseDefinitionId)}`}>
                            {item.displayName}
                          </Link>
                        </td>
                        <td>{item.samples}</td>
                        <td>{item.passed}</td>
                        <td>{item.failed}</td>
                        <td>{percent(item.confidence)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {flakySummary.flakyCases.length === 0 ? (
                  <div className="inline-empty">至少需要 5 个成功与失败混合样本。</div>
                ) : null}
              </div>
            </InsightDetailDialog>
          </div>
          <form className="insight-flaky-filter" method="get">
            <label>
              指定任务
              <Select defaultValue={stringParameter(parameters.flakySuiteId)} name="flakySuiteId">
                <option value="">全部任务</option>
                {suites.map((suite) => (
                  <option key={suite.id} value={suite.id}>
                    {suite.name}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              开始时间（平台时区）
              <DatetimeInput
                defaultValue={dateTimeLocal(flakyFilter.completedAfter, timeZone)}
                name="flakyCompletedAfter"
              />
            </label>
            <label>
              结束时间（平台时区）
              <DatetimeInput
                defaultValue={dateTimeLocal(flakyFilter.completedBefore, timeZone)}
                name="flakyCompletedBefore"
              />
            </label>
            <NavigationSubmitButton
              key={`flaky-${JSON.stringify(flakyFilter)}`}
              pendingLabel="正在分析不稳定用例…"
              type="submit"
              variant="secondary"
            >
              筛选不稳定用例
            </NavigationSubmitButton>
          </form>
          <p className="muted insight-flaky-scope">
            当前范围：
            {stringParameter(parameters.flakySuiteId)
              ? (suites.find((suite) => suite.id === stringParameter(parameters.flakySuiteId))
                  ?.name ?? "指定任务")
              : "全部任务"}
            {flakyFilter.completedAfter || flakyFilter.completedBefore
              ? ` · ${flakyFilter.completedAfter ? formatLocalDateTime(flakyFilter.completedAfter, timeZone) : "最早记录"} 至 ${flakyFilter.completedBefore ? formatLocalDateTime(flakyFilter.completedBefore, timeZone) : "现在"}`
              : " · 全部时间"}
          </p>
          {flakySummary.flakyCases.length === 0 ? (
            <div className="inline-empty">至少需要 5 个成功与失败混合样本。</div>
          ) : (
            <FlakyCaseChart cases={flakySummary.flakyCases} />
          )}
        </article>

        <article
          aria-label="当前层级用例执行情况"
          className="content-card insight-chart-card insight-case-outcome-card"
        >
          <div className="section-heading">
            <div>
              <span className="eyebrow">CASE OUTCOMES</span>
              <h2>当前层级用例执行情况</h2>
            </div>
            {caseOutcomeReport ? (
              <div className="insight-heading-actions">
                <span className="muted">
                  {caseOutcomeReport.versionName} / {caseOutcomeReport.stageName} · 本页{" "}
                  {caseOutcomeReport.cases.length} 个用例
                </span>
                <InsightDetailDialog
                  description="失败与阻塞用例优先排列；表格按当前项目层级有界分页。"
                  title="当前层级用例执行明细"
                >
                  <CaseOutcomeDetails
                    parameters={parameters}
                    report={caseOutcomeReport}
                    trail={caseCursorTrail}
                    timeZone={timeZone}
                  />
                </InsightDetailDialog>
              </div>
            ) : null}
          </div>
          {caseOutcomeReport ? (
            <CaseOutcomeChart report={caseOutcomeReport} />
          ) : (
            <div className="inline-empty">请在顶栏选择项目，并确认该项目已配置可用版本。</div>
          )}
        </article>

        <article className="content-card insight-chart-card insight-comparison-card">
          <div className="section-heading">
            <div>
              <span className="eyebrow">COMPARE</span>
              <h2>批次对比</h2>
            </div>
            {comparison ? (
              <InsightDetailDialog
                description="逐用例核对版本、结果与耗时变化。列宽随视口压缩，数据区域只进行纵向滚动。"
                title="批次对比明细"
              >
                <BatchComparisonDetails cases={comparison.cases} />
              </InsightDetailDialog>
            ) : null}
          </div>
          <form className="batch-comparison-form" method="get">
            <Select
              defaultValue={stringParameter(parameters.leftBatchId)}
              name="leftBatchId"
              required
            >
              <option value="">选择基准批次</option>
              {recentBatches.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  #{batch.sequenceNumber} · {batch.suiteName} · {runBatchStatusLabel(batch.status)}
                </option>
              ))}
            </Select>
            <Select
              defaultValue={stringParameter(parameters.rightBatchId)}
              name="rightBatchId"
              required
            >
              <option value="">选择对比批次</option>
              {recentBatches.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  #{batch.sequenceNumber} · {batch.suiteName} · {runBatchStatusLabel(batch.status)}
                </option>
              ))}
            </Select>
            <NavigationSubmitButton
              className="button button-secondary"
              key={`comparison-${stringParameter(parameters.leftBatchId)}-${stringParameter(parameters.rightBatchId)}`}
              pendingLabel="正在生成批次对比…"
              type="submit"
            >
              开始对比
            </NavigationSubmitButton>
          </form>
          <p className="muted">可选择当前项目最近 100 个批次；更早记录请先在执行记录中定位。</p>
          {comparison ? (
            <BatchComparisonChart comparison={comparison} />
          ) : (
            <div className="inline-empty">
              选择两个可访问批次，按相同用例范围比较版本、环境、Runner、结果和耗时。
            </div>
          )}
        </article>
      </section>
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  tone = "neutral",
}: {
  icon: typeof BarChart3;
  label: string;
  value: string;
  tone?: "neutral" | "success" | "danger";
}) {
  return (
    <article className={`card insight-metric insight-metric-${tone}`}>
      <span className="insight-metric-icon">
        <Icon size={18} />
      </span>
      <span className="insight-metric-label">{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

const INSIGHT_CHART_ITEM_LIMIT = 6;
const FAILURE_CHART_COLORS = [
  "var(--color-danger)",
  "var(--color-chart-coral)",
  "var(--color-warning)",
  "var(--color-violet)",
  "var(--color-info)",
] as const;

function TrendLineChart({ trend }: { trend: AnalyticsSummary["trend"] }) {
  const width = 600;
  const height = 210;
  const horizontalInset = 12;
  const verticalInset = 14;
  const chartHeight = height - verticalInset * 2;
  const chartWidth = width - horizontalInset * 2;
  const maximum = Math.max(1, ...trend.map((bucket) => bucket.total));
  const x = (index: number) =>
    trend.length === 1 ? width / 2 : horizontalInset + (index / (trend.length - 1)) * chartWidth;
  const y = (value: number) => verticalInset + chartHeight * (1 - value / maximum);
  const points = (value: (bucket: AnalyticsSummary["trend"][number]) => number) => {
    if (trend.length === 1) {
      const singleValueY = y(value(trend[0]!)).toFixed(2);
      return `${horizontalInset},${singleValueY} ${width - horizontalInset},${singleValueY}`;
    }
    return trend
      .map((bucket, index) => `${x(index).toFixed(2)},${y(value(bucket)).toFixed(2)}`)
      .join(" ");
  };
  const totalPoints = points((bucket) => bucket.total);
  const lastBucket = trend.at(-1)!;
  const markerStep = Math.max(1, Math.ceil(trend.length / 18));
  return (
    <div className="insight-line-chart">
      <div className="insight-line-summary" aria-hidden="true">
        <span>
          <i className="trend-passed" />
          通过 <b>{lastBucket.passed}</b>
        </span>
        <span>
          <i className="trend-failed" />
          失败 <b>{lastBucket.failed}</b>
        </span>
        <span>
          <i className="trend-skipped" />
          跳过 <b>{lastBucket.skipped}</b>
        </span>
        <small>最新一天</small>
      </div>
      <svg
        aria-label={`从 ${trend[0]!.bucket.slice(0, 10)} 到 ${lastBucket.bucket.slice(0, 10)} 的方法执行折线趋势`}
        className="insight-line-plot"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        <defs>
          <linearGradient id="insight-trend-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--color-info)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--color-info)" stopOpacity="0.01" />
          </linearGradient>
          <filter id="insight-line-shadow" x="-10%" y="-10%" width="120%" height="120%">
            <feDropShadow dx="0" dy="2" floodOpacity="0.14" stdDeviation="2" />
          </filter>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
          <line
            className="insight-line-grid"
            key={ratio}
            x1={horizontalInset}
            x2={width - horizontalInset}
            y1={verticalInset + chartHeight * ratio}
            y2={verticalInset + chartHeight * ratio}
          />
        ))}
        <polygon
          className="insight-line-area"
          points={`${horizontalInset},${height - verticalInset} ${totalPoints} ${width - horizontalInset},${height - verticalInset}`}
        />
        <polyline className="insight-line-total" points={totalPoints} />
        <polyline
          className="insight-line-passed"
          filter="url(#insight-line-shadow)"
          points={points((bucket) => bucket.passed)}
        />
        <polyline className="insight-line-failed" points={points((bucket) => bucket.failed)} />
        <polyline className="insight-line-skipped" points={points((bucket) => bucket.skipped)} />
        {trend.map((bucket, index) =>
          index % markerStep === 0 || index === trend.length - 1 ? (
            <circle
              className="insight-line-marker"
              cx={x(index)}
              cy={y(bucket.total)}
              key={bucket.bucket}
              r="3.5"
            >
              <title>
                {bucket.bucket.slice(0, 10)}：通过 {bucket.passed}，失败 {bucket.failed}，跳过{" "}
                {bucket.skipped}
              </title>
            </circle>
          ) : null,
        )}
      </svg>
      <div
        className={`insight-line-axis${trend.length === 1 ? " insight-line-axis-single" : ""}`}
        aria-hidden="true"
      >
        <span>{trend[0]!.bucket.slice(5, 10)}</span>
        {trend.length > 1 ? <span>{lastBucket.bucket.slice(5, 10)}</span> : null}
      </div>
    </div>
  );
}

function FailureReasonChart({ failures }: { failures: AnalyticsSummary["failures"] }) {
  const visibleFailures = failures.slice(0, FAILURE_CHART_COLORS.length);
  const visibleCount = visibleFailures.reduce((total, failure) => total + failure.count, 0);
  const totalCount = failures.reduce((total, failure) => total + failure.count, 0);
  const otherCount = Math.max(0, totalCount - visibleCount);
  return (
    <div className="insight-failure-pie-chart">
      <div
        aria-label={`失败原因饼图，共 ${failures.length} 类、${totalCount} 次失败`}
        className="insight-pie"
        role="img"
        style={pieStyle(
          [
            ...visibleFailures.map((failure, index) => ({
              count: failure.count,
              color: FAILURE_CHART_COLORS[index]!,
            })),
            { count: otherCount, color: "var(--color-text-tertiary)" },
          ],
          totalCount,
        )}
      >
        <span>
          <strong>{totalCount}</strong>
          <small>失败次数</small>
        </span>
      </div>
      <div className="insight-pie-legend">
        {visibleFailures.map((failure, index) => (
          <span key={failure.signature} title={failure.description}>
            <i style={{ background: FAILURE_CHART_COLORS[index] }} />
            <b>{failure.description}</b>
            <em>{failure.count}</em>
          </span>
        ))}
        {otherCount > 0 ? (
          <span>
            <i className="insight-chart-neutral" />
            <b>其他原因</b>
            <em>{otherCount}</em>
          </span>
        ) : null}
        <p className="insight-chart-caption">
          展示出现次数最高的 {visibleFailures.length} 类，共 {failures.length} 类
        </p>
      </div>
    </div>
  );
}

function FlakyCaseChart({ cases }: { cases: AnalyticsSummary["flakyCases"] }) {
  const visibleCases = cases.slice(0, INSIGHT_CHART_ITEM_LIMIT);
  const maximum = Math.max(1, ...visibleCases.map((item) => item.samples));
  return (
    <div className="insight-flaky-column-chart" role="img" aria-label="不稳定用例样本柱状图">
      <div className="insight-chart-legend" aria-hidden="true">
        <span>
          <i className="insight-chart-success" />
          成功
        </span>
        <span>
          <i className="insight-chart-danger" />
          失败
        </span>
      </div>
      <div className="insight-flaky-columns">
        {visibleCases.map((item) => {
          const samples = Math.max(1, item.passed + item.failed);
          return (
            <div className="insight-flaky-column" key={item.caseDefinitionId}>
              <b>{item.samples}</b>
              <span className="insight-column-track">
                <span
                  aria-label={`${item.displayName}：成功 ${item.passed}，失败 ${item.failed}`}
                  className="insight-column-stack"
                  style={{ height: `${Math.max(8, (item.samples / maximum) * 100)}%` }}
                  title={`${item.displayName}：${item.samples} 个样本，置信度 ${percent(item.confidence)}`}
                >
                  <i
                    className="insight-chart-danger"
                    style={{ height: `${(item.failed / samples) * 100}%` }}
                  />
                  <i
                    className="insight-chart-success"
                    style={{ height: `${(item.passed / samples) * 100}%` }}
                  />
                </span>
              </span>
              <small title={item.displayName}>{item.displayName}</small>
              <em>{percent(item.confidence)}</em>
            </div>
          );
        })}
      </div>
      <p className="insight-chart-caption">
        展示置信度最高的 {visibleCases.length} 个用例，共 {cases.length} 个
      </p>
    </div>
  );
}

function BatchComparisonChart({ comparison }: { comparison: AnalyticsBatchComparison }) {
  const comparableCases = comparison.cases.filter(
    (item) => item.leftVersion !== undefined && item.rightVersion !== undefined,
  );
  const changes = [
    {
      label: "结果变化",
      count: comparableCases.filter((item) => item.leftOutcome !== item.rightOutcome).length,
      tone: "danger",
    },
    {
      label: "版本变化",
      count: comparableCases.filter((item) => item.leftVersion !== item.rightVersion).length,
      tone: "violet",
    },
    {
      label: "耗时上升",
      count: comparableCases.filter((item) => (item.durationDeltaMs ?? 0) > 0).length,
      tone: "warning",
    },
    {
      label: "耗时下降",
      count: comparableCases.filter((item) => (item.durationDeltaMs ?? 0) < 0).length,
      tone: "success",
    },
  ] as const;
  const comparisonMaximum = Math.max(1, ...changes.map((item) => item.count));
  const scopeTotal =
    comparison.commonCaseCount + comparison.onlyLeftCaseCount + comparison.onlyRightCaseCount;
  return (
    <div className="insight-comparison-overview">
      <div className="insight-donut-group">
        <div
          aria-label={`共同用例 ${comparison.commonCaseCount}，仅基准 ${comparison.onlyLeftCaseCount}，仅对比 ${comparison.onlyRightCaseCount}`}
          className="insight-donut"
          role="img"
          style={donutStyle(
            [
              { count: comparison.commonCaseCount, color: "var(--color-info)" },
              { count: comparison.onlyLeftCaseCount, color: "var(--color-warning)" },
              { count: comparison.onlyRightCaseCount, color: "var(--color-violet)" },
            ],
            scopeTotal,
          )}
        >
          <span>
            <strong>{scopeTotal}</strong>
            <small>范围用例</small>
          </span>
        </div>
        <div className="insight-donut-legend">
          <span>
            <i className="insight-chart-info" />
            共同 {comparison.commonCaseCount}
          </span>
          <span>
            <i className="insight-chart-warning" />
            仅基准 {comparison.onlyLeftCaseCount}
          </span>
          <span>
            <i className="insight-chart-violet" />
            仅对比 {comparison.onlyRightCaseCount}
          </span>
        </div>
      </div>
      <div className="insight-change-column-chart" aria-label="共同用例变化柱状图">
        <div className="insight-change-columns">
          {changes.map((item) => (
            <div className="insight-change-column" key={item.label}>
              <b>{item.count}</b>
              <span>
                <i
                  className={`insight-chart-${item.tone}`}
                  style={{
                    height: `${Math.max(item.count > 0 ? 6 : 0, (item.count / comparisonMaximum) * 100)}%`,
                  }}
                />
              </span>
              <small>{item.label}</small>
            </div>
          ))}
        </div>
        <p className={comparison.comparableScope ? "status-success" : "status-warning"}>
          {comparison.comparableScope
            ? "样本范围一致，可直接比较。"
            : "样本范围不同，不直接比较总体百分比。"}
        </p>
      </div>
    </div>
  );
}

function pieStyle(
  segments: ReadonlyArray<{ count: number; color: string }>,
  total: number,
): CSSProperties {
  return segmentedCircleStyle(segments, total);
}

function analyticsFilter(
  parameters: Record<string, string | string[] | undefined>,
  timeZone: string,
): AnalyticsFilter {
  const value = (key: string) =>
    typeof parameters[key] === "string" && parameters[key]
      ? (parameters[key] as string)
      : undefined;
  const iso = (key: string) => {
    const raw = value(key);
    if (!raw) return undefined;
    return platformDateTimeParameterToIso(raw, timeZone);
  };
  const outcome = value("outcome");
  return {
    ...(value("projectId") ? { projectId: value("projectId") } : {}),
    ...(value("projectVersionId") ? { projectVersionId: value("projectVersionId") } : {}),
    ...(value("testStageId") ? { testStageId: value("testStageId") } : {}),
    ...(value("suiteId") ? { suiteId: value("suiteId") } : {}),
    ...(value("runnerId") ? { runnerId: value("runnerId") } : {}),
    ...(value("caseDefinitionId") ? { caseDefinitionId: value("caseDefinitionId") } : {}),
    ...(value("failureSignature") ? { failureSignature: value("failureSignature") } : {}),
    ...(value("tag") ? { tag: value("tag") } : {}),
    ...(outcome && ["succeeded", "failed", "cancelled", "timed_out"].includes(outcome)
      ? { outcome: outcome as AnalyticsFilter["outcome"] }
      : {}),
    ...(iso("completedAfter") ? { completedAfter: iso("completedAfter") } : {}),
    ...(iso("completedBefore") ? { completedBefore: iso("completedBefore") } : {}),
  };
}

function stringParameter(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function analyticsFiltersEqual(left: AnalyticsFilter, right: AnalyticsFilter): boolean {
  const entries = (filter: AnalyticsFilter) =>
    Object.entries(filter).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return JSON.stringify(entries(left)) === JSON.stringify(entries(right));
}

function dateTimeParameter(
  value: string | string[] | undefined,
  timeZone: string,
): string | undefined {
  const raw = stringParameter(value);
  return raw ? platformDateTimeParameterToIso(raw, timeZone) : undefined;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
function duration(value?: number): string {
  return value === undefined
    ? "—"
    : value < 1_000
      ? `${value} ms`
      : `${(value / 1_000).toFixed(2)} s`;
}
function dateTimeLocal(value: string | undefined, timeZone: string): string {
  return platformDateTimeInputValue(value, timeZone);
}

type CaseOutcomeCounts = {
  total: number;
  succeeded: number;
  failed: number;
  blocked: number;
  neverRun: number;
};

function caseOutcomeCounts(report: CaseOutcomeReport): CaseOutcomeCounts {
  const total = report.cases.length;
  let succeeded = 0;
  let failed = 0;
  let blocked = 0;
  for (const item of report.cases) {
    const run = report.outcomes.get(item.id);
    if (!run) continue;
    switch (classifyAttemptResult(run)) {
      case "succeeded":
        succeeded += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "blocked":
        blocked += 1;
        break;
    }
  }
  return { total, succeeded, failed, blocked, neverRun: total - succeeded - failed - blocked };
}

function CaseOutcomeChart({ report }: { report: CaseOutcomeReport }) {
  const counts = caseOutcomeCounts(report);
  if (counts.total === 0) return <div className="inline-empty">该项目版本还没有用例。</div>;
  return (
    <div className="insight-case-outcome-chart">
      <div
        aria-label={`成功 ${counts.succeeded}，失败 ${counts.failed}，阻塞 ${counts.blocked}，未执行 ${counts.neverRun}`}
        className="insight-donut insight-case-outcome-donut"
        role="img"
        style={donutStyle(
          [
            { count: counts.succeeded, color: "var(--color-success)" },
            { count: counts.failed, color: "var(--color-danger)" },
            { count: counts.blocked, color: "var(--color-warning)" },
            { count: counts.neverRun, color: "var(--color-text-tertiary)" },
          ],
          counts.total,
        )}
      >
        <span>
          <strong>{counts.total}</strong>
          <small>本页用例</small>
        </span>
      </div>
      <div className="insight-outcome-legend">
        <span>
          <i className="insight-chart-success" />
          <small>成功</small>
          <strong>{counts.succeeded}</strong>
          <em>{formatRate(counts.succeeded, counts.total)}</em>
        </span>
        <span>
          <i className="insight-chart-danger" />
          <small>失败</small>
          <strong>{counts.failed}</strong>
          <em>{formatRate(counts.failed, counts.total)}</em>
        </span>
        <span>
          <i className="insight-chart-warning" />
          <small>阻塞</small>
          <strong>{counts.blocked}</strong>
          <em>{formatRate(counts.blocked, counts.total)}</em>
        </span>
        <span>
          <i className="insight-chart-neutral" />
          <small>未执行</small>
          <strong>{counts.neverRun}</strong>
          <em>{formatRate(counts.neverRun, counts.total)}</em>
        </span>
      </div>
    </div>
  );
}

function CaseOutcomeDetails({
  report,
  parameters,
  trail,
  timeZone,
}: {
  report: CaseOutcomeReport;
  parameters: Record<string, string | string[] | undefined>;
  trail: readonly string[];
  timeZone: string;
}) {
  const counts = caseOutcomeCounts(report);
  // 失败与阻塞优先展示：把尚未稳定的用例排在表格前面。
  const rows = [...report.cases].sort(
    (left, right) =>
      outcomeRank(report.outcomes.get(left.id)).localeCompare(
        outcomeRank(report.outcomes.get(right.id)),
      ) || left.displayName.localeCompare(right.displayName),
  );
  return (
    <div className="insight-detail-content">
      <div className="case-outcome-summary" role="status">
        <span>
          本页 <strong>{counts.total}</strong> 个用例
        </span>
        <span className="batch-status batch-status-succeeded">
          成功 {counts.succeeded}（{formatRate(counts.succeeded, counts.total)}）
        </span>
        <span className="batch-status batch-status-failed">
          失败 {counts.failed}（{formatRate(counts.failed, counts.total)}）
        </span>
        <span className="batch-status batch-status-blocked">
          阻塞 {counts.blocked}（{formatRate(counts.blocked, counts.total)}）
        </span>
        <span className="batch-status batch-status-neutral">
          未执行 {counts.neverRun}（{formatRate(counts.neverRun, counts.total)}）
        </span>
      </div>
      {counts.total === 0 ? (
        <div className="inline-empty">该项目版本还没有用例。</div>
      ) : (
        <div className="insight-detail-table-scroll">
          <table className="data-table insight-detail-wide-table">
            <thead>
              <tr>
                <th>用例</th>
                <th>类名</th>
                <th>最近结果</th>
                <th>最近执行时间</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => {
                const outcome = report.outcomes.get(item.id);
                return (
                  <tr key={item.id}>
                    <td title={item.displayName}>
                      <Link href={`/cases/${encodeURIComponent(item.id)}`}>{item.displayName}</Link>
                    </td>
                    <td title={item.className}>
                      <code>{item.className}</code>
                    </td>
                    <td>
                      <span className={`batch-status ${outcomeBadgeClass(outcome)}`}>
                        {outcomeLabel(outcome)}
                      </span>
                    </td>
                    <td>
                      {report.executedAt.has(item.id) ? (
                        <time
                          dateTime={report.executedAt.get(item.id)}
                          title={`UTC：${report.executedAt.get(item.id)}`}
                        >
                          {formatLocalDateTime(report.executedAt.get(item.id)!, timeZone)}
                        </time>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {trail.length > 0 || report.nextCursor ? (
        <nav aria-label="用例执行情况分页" className="pagination">
          {trail.length > 0 ? (
            <Link href={`/insights?${casePreviousParameters(parameters, trail)}`}>上一页</Link>
          ) : (
            <span />
          )}
          {report.nextCursor ? (
            <Link href={`/insights?${caseNextParameters(parameters, report.nextCursor, trail)}`}>
              下一页
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

function donutStyle(
  segments: ReadonlyArray<{ count: number; color: string }>,
  total: number,
): CSSProperties {
  return segmentedCircleStyle(segments, total);
}

function segmentedCircleStyle(
  segments: ReadonlyArray<{ count: number; color: string }>,
  total: number,
): CSSProperties {
  if (total <= 0) return { background: "var(--color-surface-muted)" };
  let cursor = 0;
  const stops = segments.flatMap((segment) => {
    if (segment.count <= 0) return [];
    const start = cursor;
    cursor = Math.min(360, cursor + (segment.count / total) * 360);
    return `${segment.color} ${start.toFixed(2)}deg ${cursor.toFixed(2)}deg`;
  });
  if (cursor < 360) {
    stops.push(`var(--color-surface-muted) ${cursor.toFixed(2)}deg 360deg`);
  }
  return { background: `conic-gradient(${stops.join(", ")})` };
}

function outcomeRank(run: CaseLatestRun | undefined): string {
  if (!run) return "4";
  switch (classifyAttemptResult(run)) {
    case "failed":
      return "0";
    case "blocked":
      return "1";
    case "succeeded":
      return "3";
  }
}

function outcomeLabel(run: CaseLatestRun | undefined): string {
  if (!run) return "未执行";
  switch (classifyAttemptResult(run)) {
    case "succeeded":
      return "成功";
    case "failed":
      return "失败";
    case "blocked":
      return "阻塞";
  }
}

function outcomeBadgeClass(run: CaseLatestRun | undefined): string {
  if (!run) return "batch-status-neutral";
  switch (classifyAttemptResult(run)) {
    case "succeeded":
      return "batch-status-succeeded";
    case "failed":
      return "batch-status-failed";
    case "blocked":
      return "batch-status-blocked";
  }
}

async function loadCaseOutcomeReport(input: {
  services: Awaited<ReturnType<typeof getPlatformServices>>;
  caseProjectId?: string;
  caseProjectVersionId?: string;
  caseTestStageId?: string;
  allowedProjectIds?: string[];
  cursor?: string;
}): Promise<CaseOutcomeReport | undefined> {
  const {
    services,
    caseProjectId,
    caseProjectVersionId,
    caseTestStageId,
    allowedProjectIds,
    cursor,
  } = input;
  if (!caseProjectId) return undefined;
  if (allowedProjectIds && !allowedProjectIds.includes(caseProjectId)) return undefined;
  const structure = await services.projectStructures.list(caseProjectId).catch(() => undefined);
  if (!structure) return undefined;
  const version =
    structure.versions.find(
      (candidate) => candidate.id === caseProjectVersionId && candidate.status === "active",
    ) ?? structure.versions.find((candidate) => candidate.status === "active");
  if (!version) return undefined;
  const stage =
    version.stages.find(
      (candidate) => candidate.id === caseTestStageId && candidate.status === "active",
    ) ?? version.stages.find((candidate) => candidate.status === "active");
  if (!stage) return undefined;
  const casePage = await services.catalog.listCases({
    projectIds: [caseProjectId],
    projectVersionId: version.id,
    testStageId: stage.id,
    scopedOnly: true,
    limit: CASE_OUTCOME_PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
  });
  const cases = casePage.items;
  const latestRuns =
    cases.length > 0
      ? await services.caseDefinitions.latestRunOutcomes(
          cases.map((item) => item.id),
          [caseProjectId],
        )
      : [];
  const outcomes = new Map<string, CaseLatestRun>();
  const executedAt = new Map<string, string>();
  for (const entry of latestRuns) {
    outcomes.set(entry.caseDefinitionId, {
      outcome: entry.outcome,
      ...(entry.resultCode ? { resultCode: entry.resultCode } : {}),
    });
    executedAt.set(entry.caseDefinitionId, entry.executedAt);
  }
  return {
    projectId: caseProjectId,
    versionId: version.id,
    versionName: version.name,
    stageId: stage.id,
    stageName: stage.name,
    cases,
    outcomes,
    executedAt,
    ...(casePage.nextCursor ? { nextCursor: casePage.nextCursor } : {}),
  };
}

function cursorTrail(value: string | string[] | undefined): string[] {
  const raw = stringParameter(value);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed
          .filter((item): item is string => typeof item === "string" && item.length <= 512)
          .slice(-20)
      : [];
  } catch {
    return [];
  }
}

function casePageParameters(
  parameters: Record<string, string | string[] | undefined>,
): URLSearchParams {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) {
    if (key === "caseCursor" || key === "caseTrail" || Array.isArray(value) || !value) continue;
    next.set(key, value);
  }
  return next;
}

function caseNextParameters(
  parameters: Record<string, string | string[] | undefined>,
  cursor: string,
  trail: readonly string[],
): URLSearchParams {
  const next = casePageParameters(parameters);
  next.set("caseCursor", cursor);
  next.set("caseTrail", JSON.stringify([...trail, stringParameter(parameters.caseCursor)]));
  return next;
}

function casePreviousParameters(
  parameters: Record<string, string | string[] | undefined>,
  trail: readonly string[],
): URLSearchParams {
  const next = casePageParameters(parameters);
  const previousCursor = trail.at(-1);
  if (previousCursor) next.set("caseCursor", previousCursor);
  const remaining = trail.slice(0, -1);
  if (remaining.length > 0) next.set("caseTrail", JSON.stringify(remaining));
  return next;
}
