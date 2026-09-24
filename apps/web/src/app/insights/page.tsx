import { Badge } from "@/components/ui/badge";
import { Disclosure } from "@/components/ui/disclosure";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import {
  batchComparisonManifestSchema,
  type BatchComparisonManifest,
  analyticsSummarySchema,
} from "@autoforge/contracts";
import { ReadModelStatusBar, ReadModelPendingPage } from "@/components/read-model-status";
import { DatetimeInput, Input, Select } from "@/components/ui";

import type { AnalyticsFilter, AnalyticsSummary } from "@autoforge/contracts";
import type { CaseDefinitionWithMethods } from "@autoforge/domain";
import { BarChart3, FlaskConical, SlidersHorizontal, Timer, TrendingUp } from "lucide-react";
import Link from "next/link";
import type { CSSProperties } from "react";

import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { formatRate, type CaseLatestRun } from "@/lib/case-selection-stats";
import { classifyAttemptResult } from "@autoforge/domain";
import { ExpandableText } from "@/components/expandable-text";
import { AnalyticsExportControl } from "@/components/analytics-export-control";
import { BatchComparisonForm } from "@/components/batch-comparison-form";
import { CachedBatchComparison } from "@/components/cached-batch-comparison";
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
  if (!caseProjectId || !hierarchy.projectVersionId)
    return (
      <section className={cn("page-hero", uiPatterns["page-hero"])}>
        <div>
          <h1>质量洞察</h1>
          <p>请选择项目版本后查看统计。</p>
        </div>
      </section>
    );
  const projection = await services.readModels.read({
    kind: "analytics",
    projectId: caseProjectId,
    projectVersionId: hierarchy.projectVersionId,
    filter,
  });
  const flakyProjection = analyticsFiltersEqual(filter, flakyFilter)
    ? projection
    : await services.readModels.read({
        kind: "analytics",
        projectId: caseProjectId,
        projectVersionId: hierarchy.projectVersionId,
        filter: flakyFilter,
      });
  const projections =
    projection.id === flakyProjection.id ? [projection] : [projection, flakyProjection];
  if (projections.some((entry) => !entry.generation))
    return (
      <ReadModelPendingPage title="质量洞察" snapshots={projections.map((entry) => entry.status)} />
    );
  const summary = analyticsSummarySchema.parse(projection.payload);
  const [suites, runners, recentBatches] = await Promise.all([
    hierarchy.projectVersionId
      ? services.caseSuites.list(
          500,
          caseProjectId ? [caseProjectId] : [],
          hierarchy.projectVersionId,
        )
      : Promise.resolve([]),
    services.runnerControl.list(500),
    hierarchy.projectVersionId
      ? services.runBatches
          .listMetadataPage({
            limit: 100,
            projectIds: caseProjectId ? [caseProjectId] : [],
            projectVersionId: hierarchy.projectVersionId,
          })
          .then((page) => page.items)
      : Promise.resolve([]),
  ]);
  // 相同筛选复用同一份后台快照。
  const flakySummary = analyticsSummarySchema.parse(flakyProjection.payload);
  const comparisonProjection =
    typeof parameters.leftBatchId === "string" && typeof parameters.rightBatchId === "string"
      ? await services.readModels.read({
          kind: "batch_comparison",
          snapshotVersion: 2,
          projectId: caseProjectId,
          projectVersionId: hierarchy.projectVersionId,
          leftBatchId: parameters.leftBatchId,
          rightBatchId: parameters.rightBatchId,
        })
      : undefined;
  const comparison = comparisonProjection?.generation
    ? batchComparisonManifestSchema.parse(comparisonProjection.payload)
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
    <div
      className={cn(
        "page-stack insights-page",
        uiPatterns["page-stack"],
        pageStyles["insights-page"],
      )}
    >
      <section className={cn("page-hero", uiPatterns["page-hero"])}>
        <div>
          <span className={cn("eyebrow", uiPatterns["eyebrow"])}>Offline Analytics</span>
          <h1>质量洞察</h1>
          <p>从已确认的执行结果重建统计事实，按项目、任务、执行节点和时间查看趋势。</p>
        </div>
        <AnalyticsExportControl filter={filter} />
      </section>

      <Card className="insight-filter-card flex flex-col gap-3 p-4 xl:p-5">
        <form className={cn("insight-filter", pageStyles["insight-filter"])} method="get">
          <div className={cn("insight-primary-filters", pageStyles["insight-primary-filters"])}>
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
              执行节点
              <Select defaultValue={filter.runnerId ?? ""} name="runnerId">
                <option value="">全部执行节点</option>
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
              className={cn(
                "button button-primary",
                uiPatterns["button"],
                uiPatterns["button-primary"],
              )}
              key={`primary-${JSON.stringify(filter)}`}
              pendingLabel="正在筛选质量数据…"
              type="submit"
            >
              应用筛选
            </NavigationSubmitButton>
          </div>
          <Disclosure
            density="compact"
            header={
              <>
                <SlidersHorizontal aria-hidden="true" size={15} /> 更多筛选条件
              </>
            }
            className={cn("insight-advanced-filters", pageStyles["insight-advanced-filters"])}
          >
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
          </Disclosure>
        </form>
        <div className="border-t border-border pt-3 [&_.read-model-status]:mb-0 [&_.read-model-status]:text-xs">
          <ReadModelStatusBar snapshots={projections.map((entry) => entry.status)} />
        </div>
      </Card>

      <section
        className={cn("insight-metrics", pageStyles["insight-metrics"])}
        aria-label="质量指标"
      >
        <Metric
          icon={FlaskConical}
          label="执行样本"
          value={String(summary.sampleCount)}
          description="已确认的执行结果"
        />
        <Metric
          icon={TrendingUp}
          label="方法通过率"
          tone="success"
          value={percent(summary.successRate)}
          description={`通过 ${summary.passed} / 总计 ${methodSampleCount} 方法`}
        />
        <Metric
          icon={BarChart3}
          label="方法失败率"
          tone="danger"
          value={percent(summary.failureRate)}
          description={`失败 ${summary.failed} · 跳过 ${summary.skipped} 方法`}
        />
        <Metric
          icon={Timer}
          label="P95 耗时"
          value={duration(summary.durationP95Ms)}
          description="95% 的样本耗时不超过此值"
        />
      </section>

      <section className={cn("insight-grid", pageStyles["insight-grid"])}>
        <Card
          as="article"
          className={cn(
            "content-card insight-chart-card insight-trend-card",
            uiPatterns["content-card"],
            pageStyles["insight-chart-card"],
            pageStyles["insight-trend-card"],
          )}
        >
          <div className={cn("section-heading", uiPatterns["section-heading"])}>
            <div>
              <span className={cn("eyebrow", uiPatterns["eyebrow"])}>TREND</span>
              <h2>每日趋势</h2>
              <p className="insight-chart-description">
                已确认方法结果 {methodSampleCount} 个 · 执行样本 {summary.sampleCount} 次
              </p>
            </div>
            <div className={cn("insight-heading-actions", pageStyles["insight-heading-actions"])}>
              <InsightDetailDialog
                description="逐日查看通过、失败与跳过的方法数量。表头固定，数据区域可独立滚动。"
                title="每日趋势明细"
              >
                <div
                  className={cn(
                    "insight-detail-table-scroll",
                    pageStyles["insight-detail-table-scroll"],
                  )}
                >
                  <Table
                    className={cn(
                      "data-table insight-data-table",
                      uiPatterns["data-table"],
                      pageStyles["insight-data-table"],
                    )}
                  >
                    <TableHeader>
                      <TableRow>
                        <TableHead>日期（{timeZone}）</TableHead>
                        <TableHead>方法总数</TableHead>
                        <TableHead>通过方法</TableHead>
                        <TableHead>失败方法</TableHead>
                        <TableHead>跳过方法</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {summary.trend.map((bucket) => (
                        <TableRow key={bucket.bucket}>
                          <TableCell>{bucket.bucket.slice(0, 10)}</TableCell>
                          <TableCell>{bucket.total}</TableCell>
                          <TableCell>{bucket.passed}</TableCell>
                          <TableCell>{bucket.failed}</TableCell>
                          <TableCell>{bucket.skipped}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {summary.trend.length === 0 ? (
                    <div className={cn("inline-empty", uiPatterns["inline-empty"])}>
                      当前筛选范围还没有已确认执行结果。
                    </div>
                  ) : null}
                </div>
              </InsightDetailDialog>
            </div>
          </div>
          {summary.trend.length === 0 ? (
            <div className={cn("inline-empty", uiPatterns["inline-empty"])}>
              当前筛选范围还没有已确认执行结果。
            </div>
          ) : (
            <TrendLineChart trend={summary.trend} />
          )}
        </Card>

        <Card
          as="article"
          className={cn(
            "content-card insight-chart-card insight-failure-card",
            uiPatterns["content-card"],
            pageStyles["insight-chart-card"],
          )}
        >
          <div className={cn("section-heading", uiPatterns["section-heading"])}>
            <div>
              <span className={cn("eyebrow", uiPatterns["eyebrow"])}>FAILURES</span>
              <h2>失败原因</h2>
              <p className="insight-chart-description">按出现次数聚合 · 完整错误见明细</p>
            </div>
            <InsightDetailDialog
              description="正常 TestNG 失败展示错误堆栈；调度、执行节点等异常执行同时展示错误码与错误信息。"
              title="失败原因明细"
            >
              <div
                className={cn(
                  "insight-detail-table-scroll",
                  pageStyles["insight-detail-table-scroll"],
                )}
              >
                <Table
                  className={cn(
                    "data-table insight-detail-wide-table insight-failure-details-table",
                    uiPatterns["data-table"],
                    pageStyles["insight-detail-wide-table"],
                    "[&_th:first-child]:w-[52%] [&_th:nth-child(2)]:w-[16%] [&_th:nth-child(3)]:w-[8%] [&_th:last-child]:w-[24%]",
                  )}
                >
                  <TableHeader>
                    <TableRow>
                      <TableHead>错误堆栈 / 错误信息</TableHead>
                      <TableHead>异常错误码</TableHead>
                      <TableHead>次数</TableHead>
                      <TableHead>最近出现时间</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.failures.map((failure) => {
                      const presentation = presentAnalyticsFailure(failure);
                      return (
                        <TableRow key={failure.signature}>
                          <TableCell
                            className={cn(
                              "insight-detail-long-text",
                              pageStyles["insight-detail-long-text"],
                            )}
                            title={presentation.detail}
                          >
                            <div className="min-w-0 whitespace-normal">
                              <ExpandableText text={presentation.detail} label="失败原因" />
                            </div>
                          </TableCell>
                          <TableCell
                            title={presentation.errorCode ?? "正常 TestNG 失败，无需错误码"}
                          >
                            {presentation.errorCode ?? "—"}
                          </TableCell>
                          <TableCell>{failure.count}</TableCell>
                          <TableCell>
                            <time
                              dateTime={failure.lastSeenAt}
                              title={`UTC：${failure.lastSeenAt}`}
                            >
                              {formatLocalDateTime(failure.lastSeenAt, timeZone)}
                            </time>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                {summary.failures.length === 0 ? (
                  <div className={cn("inline-empty", uiPatterns["inline-empty"])}>
                    暂无可聚类的失败。
                  </div>
                ) : null}
              </div>
            </InsightDetailDialog>
          </div>
          {summary.failures.length === 0 ? (
            <div className={cn("inline-empty", uiPatterns["inline-empty"])}>暂无可聚类的失败。</div>
          ) : (
            <FailureReasonChart failures={summary.failures} />
          )}
        </Card>

        <Card
          as="article"
          className={cn(
            "content-card insight-chart-card insight-flaky-card",
            uiPatterns["content-card"],
            pageStyles["insight-chart-card"],
            pageStyles["insight-flaky-card"],
          )}
        >
          <div className={cn("section-heading", uiPatterns["section-heading"])}>
            <div>
              <span className={cn("eyebrow", uiPatterns["eyebrow"])}>FLAKY</span>
              <h2>不稳定用例</h2>
              <p className="insight-chart-description">成功与失败交替出现的执行样本</p>
            </div>
            <InsightDetailDialog
              description="查看当前分析返回的不稳定用例，以及用于判断的成功、失败样本和置信度。"
              title="不稳定用例明细"
            >
              <div
                className={cn(
                  "insight-detail-table-scroll",
                  pageStyles["insight-detail-table-scroll"],
                )}
              >
                <Table
                  className={cn(
                    "data-table insight-detail-wide-table",
                    uiPatterns["data-table"],
                    pageStyles["insight-detail-wide-table"],
                  )}
                >
                  <TableHeader>
                    <TableRow>
                      <TableHead>用例</TableHead>
                      <TableHead>样本</TableHead>
                      <TableHead>成功</TableHead>
                      <TableHead>失败</TableHead>
                      <TableHead>置信度</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {flakySummary.flakyCases.map((item) => (
                      <TableRow key={item.caseDefinitionId}>
                        <TableCell title={item.displayName}>
                          <Link href={`/cases/${encodeURIComponent(item.caseDefinitionId)}`}>
                            {item.displayName}
                          </Link>
                        </TableCell>
                        <TableCell>{item.samples}</TableCell>
                        <TableCell>{item.passed}</TableCell>
                        <TableCell>{item.failed}</TableCell>
                        <TableCell>{percent(item.confidence)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {flakySummary.flakyCases.length === 0 ? (
                  <div className={cn("inline-empty", uiPatterns["inline-empty"])}>
                    至少需要 5 个成功与失败混合样本。
                  </div>
                ) : null}
              </div>
            </InsightDetailDialog>
          </div>
          <form
            className={cn("insight-flaky-filter", pageStyles["insight-flaky-filter"])}
            method="get"
          >
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
          <p
            className={cn(
              "muted insight-flaky-scope",
              uiPatterns["muted"],
              pageStyles["insight-flaky-scope"],
            )}
          >
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
            <div className={cn("inline-empty", uiPatterns["inline-empty"])}>
              至少需要 5 个成功与失败混合样本。
            </div>
          ) : (
            <FlakyCaseChart cases={flakySummary.flakyCases} />
          )}
        </Card>

        <Card
          as="article"
          aria-label="当前层级用例执行情况"
          className={cn(
            "content-card insight-chart-card insight-case-outcome-card",
            uiPatterns["content-card"],
            pageStyles["insight-chart-card"],
          )}
        >
          <div className={cn("section-heading", uiPatterns["section-heading"])}>
            <div>
              <span className={cn("eyebrow", uiPatterns["eyebrow"])}>CASE OUTCOMES</span>
              <h2>当前层级用例执行情况</h2>
              {caseOutcomeReport ? (
                <p
                  className="insight-chart-description"
                  title={`${caseOutcomeReport.versionName} / ${caseOutcomeReport.stageName}`}
                >
                  {caseOutcomeReport.versionName} / {caseOutcomeReport.stageName} · 本页{" "}
                  {caseOutcomeReport.cases.length} 个用例
                </p>
              ) : null}
            </div>
            {caseOutcomeReport ? (
              <div className={cn("insight-heading-actions", pageStyles["insight-heading-actions"])}>
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
            <div className={cn("inline-empty", uiPatterns["inline-empty"])}>
              请在顶栏选择项目，并确认该项目已配置可用版本。
            </div>
          )}
        </Card>

        <Card
          as="article"
          className={cn(
            "content-card insight-chart-card insight-comparison-card",
            uiPatterns["content-card"],
            pageStyles["insight-chart-card"],
            pageStyles["insight-comparison-card"],
          )}
        >
          <div className={cn("section-heading", uiPatterns["section-heading"])}>
            <div>
              <span className={cn("eyebrow", uiPatterns["eyebrow"])}>COMPARE</span>
              <h2>批次对比</h2>
            </div>
            {comparison && comparisonProjection ? (
              <InsightDetailDialog
                description="逐用例核对版本、结果与耗时变化。列宽随视口压缩，数据区域只进行纵向滚动。"
                title="批次对比明细"
              >
                <CachedBatchComparison
                  left={comparison.left}
                  right={comparison.right}
                  snapshot={comparisonProjection.status}
                  partCount={comparison.partCount}
                />
              </InsightDetailDialog>
            ) : null}
          </div>
          <BatchComparisonForm
            initialLeftBatchId={stringParameter(parameters.leftBatchId)}
            initialRightBatchId={stringParameter(parameters.rightBatchId)}
            key={`${caseProjectId}-${hierarchy.projectVersionId}-${stringParameter(parameters.leftBatchId)}-${stringParameter(parameters.rightBatchId)}`}
            options={recentBatches.map((batch) => ({
              id: batch.id,
              label: `#${batch.sequenceNumber} · ${batch.suiteName} · ${runBatchStatusLabel(batch.status)}`,
            }))}
          />
          <p className={cn("muted", uiPatterns["muted"])}>
            可选择当前项目最近 100 个批次；更早记录请先在执行记录中定位。
          </p>
          {comparisonProjection ? (
            <ReadModelStatusBar snapshots={[comparisonProjection.status]} />
          ) : null}
          {comparison ? (
            <BatchComparisonChart comparison={comparison} />
          ) : (
            <div className={cn("inline-empty", uiPatterns["inline-empty"])}>
              选择两个可访问批次，按相同用例范围比较版本、执行节点、结果和耗时。
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  description,
  tone = "neutral",
}: {
  icon: typeof BarChart3;
  label: string;
  value: string;
  description: string;
  tone?: "neutral" | "success" | "danger";
}) {
  return (
    <Card
      as="article"
      className={cn(
        uiPatterns["card"],
        pageStyles["insight-metric"],
        `card insight-metric insight-metric-${tone}`,
      )}
    >
      <span className={cn("insight-metric-icon", pageStyles["insight-metric-icon"])}>
        <Icon size={18} />
      </span>
      <span className={"insight-metric-label"}>{label}</span>
      <strong>{value}</strong>
      <small className="insight-metric-description">{description}</small>
    </Card>
  );
}

const INSIGHT_CHART_ITEM_LIMIT = 6;
const FAILURE_CHART_COLORS = ["var(--destructive)", "var(--warning)", "var(--info)"] as const;

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
    <div className={cn("insight-line-chart", pageStyles["insight-line-chart"])}>
      <div
        className={cn("insight-line-summary", pageStyles["insight-line-summary"])}
        aria-hidden="true"
      >
        <span>
          <i className={cn("trend-passed", pageStyles["trend-passed"])} />
          通过 <b>{lastBucket.passed}</b>
        </span>
        <span>
          <i className={cn("trend-failed", pageStyles["trend-failed"])} />
          失败 <b>{lastBucket.failed}</b>
        </span>
        <span>
          <i className={cn("trend-skipped", pageStyles["trend-skipped"])} />
          跳过 <b>{lastBucket.skipped}</b>
        </span>
        <small>最新一天</small>
      </div>
      <svg
        aria-label={`从 ${trend[0]!.bucket.slice(0, 10)} 到 ${lastBucket.bucket.slice(0, 10)} 的方法执行折线趋势`}
        className={cn("insight-line-plot", pageStyles["insight-line-plot"])}
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        <defs>
          <linearGradient id="insight-trend-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--info)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--info)" stopOpacity="0.01" />
          </linearGradient>
          <filter id="insight-line-shadow" x="-10%" y="-10%" width="120%" height="120%">
            <feDropShadow dx="0" dy="2" floodOpacity="0.14" stdDeviation="2" />
          </filter>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
          <line
            className={cn("insight-line-grid", pageStyles["insight-line-grid"])}
            key={ratio}
            x1={horizontalInset}
            x2={width - horizontalInset}
            y1={verticalInset + chartHeight * ratio}
            y2={verticalInset + chartHeight * ratio}
          />
        ))}
        <polygon
          className={cn("insight-line-area", pageStyles["insight-line-area"])}
          points={`${horizontalInset},${height - verticalInset} ${totalPoints} ${width - horizontalInset},${height - verticalInset}`}
        />
        <polyline
          className={cn("insight-line-total", pageStyles["insight-line-total"])}
          points={totalPoints}
        />
        <polyline
          className={cn("insight-line-passed", pageStyles["insight-line-passed"])}
          filter="url(#insight-line-shadow)"
          points={points((bucket) => bucket.passed)}
        />
        <polyline
          className={cn("insight-line-failed", pageStyles["insight-line-failed"])}
          points={points((bucket) => bucket.failed)}
        />
        <polyline
          className={cn("insight-line-skipped", pageStyles["insight-line-skipped"])}
          points={points((bucket) => bucket.skipped)}
        />
        {trend.map((bucket, index) =>
          index % markerStep === 0 || index === trend.length - 1 ? (
            <circle
              className={cn("insight-line-marker", pageStyles["insight-line-marker"])}
              cx={x(index)}
              cy={y(bucket.total)}
              key={bucket.bucket}
              r="3.5"
            >
              <title>{`${bucket.bucket.slice(0, 10)}：通过 ${bucket.passed}，失败 ${bucket.failed}，跳过 ${bucket.skipped}`}</title>
            </circle>
          ) : null,
        )}
      </svg>
      <div
        className={cn(
          pageStyles["insight-line-axis"],
          "insight-line-axis",
          trend.length === 1 &&
            cn("insight-line-axis-single", pageStyles["insight-line-axis-single"]),
        )}
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
    <div className={cn("insight-failure-pie-chart", pageStyles["insight-failure-pie-chart"])}>
      <div
        aria-label={`失败原因饼图，共 ${failures.length} 类、${totalCount} 次失败`}
        className={cn("insight-pie", pageStyles["insight-pie"])}
        role="img"
        style={pieStyle(
          [
            ...visibleFailures.map((failure, index) => ({
              count: failure.count,
              color: FAILURE_CHART_COLORS[index]!,
            })),
            { count: otherCount, color: "var(--muted-foreground)" },
          ],
          totalCount,
        )}
      >
        <span>
          <strong>{totalCount}</strong>
          <small>失败次数</small>
        </span>
      </div>
      <div className={cn("insight-pie-legend", pageStyles["insight-pie-legend"])}>
        {visibleFailures.map((failure, index) => (
          <span key={failure.signature} title={failure.description}>
            <i style={{ background: FAILURE_CHART_COLORS[index] }} />
            <span className="line-clamp-2 min-w-0 leading-5 [overflow-wrap:anywhere]">
              {failure.description}
            </span>
            <em>{failure.count}</em>
          </span>
        ))}
        {otherCount > 0 ? (
          <span>
            <i className={cn("insight-chart-neutral", pageStyles["insight-chart-neutral"])} />
            <b>其他原因</b>
            <em>{otherCount}</em>
          </span>
        ) : null}
        <p className={cn("insight-chart-caption", pageStyles["insight-chart-caption"])}>
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
    <div
      className={cn("insight-flaky-column-chart", pageStyles["insight-flaky-column-chart"])}
      role="img"
      aria-label="不稳定用例样本柱状图"
    >
      <div
        className={cn("insight-chart-legend", pageStyles["insight-chart-legend"])}
        aria-hidden="true"
      >
        <span>
          <i className={cn("insight-chart-success", pageStyles["insight-chart-success"])} />
          成功
        </span>
        <span>
          <i className={cn("insight-chart-danger", pageStyles["insight-chart-danger"])} />
          失败
        </span>
      </div>
      <div className={cn("insight-flaky-columns", pageStyles["insight-flaky-columns"])}>
        {visibleCases.map((item) => {
          const samples = Math.max(1, item.passed + item.failed);
          return (
            <div
              className={cn("insight-flaky-column", pageStyles["insight-flaky-column"])}
              key={item.caseDefinitionId}
            >
              <b>{item.samples}</b>
              <span className={cn("insight-column-track", pageStyles["insight-column-track"])}>
                <span
                  aria-label={`${item.displayName}：成功 ${item.passed}，失败 ${item.failed}`}
                  className={cn("insight-column-stack", pageStyles["insight-column-stack"])}
                  style={{ height: `${Math.max(8, (item.samples / maximum) * 100)}%` }}
                  title={`${item.displayName}：${item.samples} 个样本，置信度 ${percent(item.confidence)}`}
                >
                  <i
                    className={cn("insight-chart-danger", pageStyles["insight-chart-danger"])}
                    style={{ height: `${(item.failed / samples) * 100}%` }}
                  />
                  <i
                    className={cn("insight-chart-success", pageStyles["insight-chart-success"])}
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
      <p className={cn("insight-chart-caption", pageStyles["insight-chart-caption"])}>
        展示置信度最高的 {visibleCases.length} 个用例，共 {cases.length} 个
      </p>
    </div>
  );
}

function BatchComparisonChart({ comparison }: { comparison: BatchComparisonManifest }) {
  const changes = [
    { label: "结果变化", count: comparison.changes.outcome, tone: "danger" },
    { label: "版本变化", count: comparison.changes.version, tone: "violet" },
    { label: "耗时上升", count: comparison.changes.slower, tone: "warning" },
    { label: "耗时下降", count: comparison.changes.faster, tone: "success" },
  ] as const;
  const comparisonMaximum = Math.max(1, ...changes.map((item) => item.count));
  const scopeTotal =
    comparison.commonCaseCount + comparison.onlyLeftCaseCount + comparison.onlyRightCaseCount;
  return (
    <div className={cn("insight-comparison-overview", pageStyles["insight-comparison-overview"])}>
      <div className={cn("insight-donut-group", pageStyles["insight-donut-group"])}>
        <div
          aria-label={`共同用例 ${comparison.commonCaseCount}，仅基准 ${comparison.onlyLeftCaseCount}，仅对比 ${comparison.onlyRightCaseCount}`}
          className={cn("insight-donut", pageStyles["insight-donut"])}
          role="img"
          style={donutStyle(
            [
              { count: comparison.commonCaseCount, color: "var(--info)" },
              { count: comparison.onlyLeftCaseCount, color: "var(--warning)" },
              { count: comparison.onlyRightCaseCount, color: "var(--info)" },
            ],
            scopeTotal,
          )}
        >
          <span>
            <strong>{scopeTotal}</strong>
            <small>范围用例</small>
          </span>
        </div>
        <div className={cn("insight-donut-legend", pageStyles["insight-donut-legend"])}>
          <span>
            <i className={cn("insight-chart-info", pageStyles["insight-chart-info"])} />
            共同 {comparison.commonCaseCount}
          </span>
          <span>
            <i className={cn("insight-chart-warning", pageStyles["insight-chart-warning"])} />
            仅基准 {comparison.onlyLeftCaseCount}
          </span>
          <span>
            <i className={cn("insight-chart-violet", pageStyles["insight-chart-violet"])} />
            仅对比 {comparison.onlyRightCaseCount}
          </span>
        </div>
      </div>
      <div
        className={cn("insight-change-column-chart", pageStyles["insight-change-column-chart"])}
        aria-label="共同用例变化柱状图"
      >
        <div className={cn("insight-change-columns", pageStyles["insight-change-columns"])}>
          {changes.map((item) => (
            <div
              className={cn("insight-change-column", pageStyles["insight-change-column"])}
              key={item.label}
            >
              <b>{item.count}</b>
              <span>
                <i
                  className={cn(
                    pageStyles["insight-chart"],
                    `insight-chart insight-chart-${item.tone}`,
                  )}
                  style={{
                    height: `${Math.max(item.count > 0 ? 6 : 0, (item.count / comparisonMaximum) * 100)}%`,
                  }}
                />
              </span>
              <small>{item.label}</small>
            </div>
          ))}
        </div>
        <p
          className={
            comparison.comparableScope
              ? "status-success"
              : cn("status-warning", pageStyles["status-warning"])
          }
        >
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
  if (counts.total === 0)
    return (
      <div className={cn("inline-empty", uiPatterns["inline-empty"])}>该项目版本还没有用例。</div>
    );
  return (
    <div className={cn("insight-case-outcome-chart", pageStyles["insight-case-outcome-chart"])}>
      <div
        aria-label={`成功 ${counts.succeeded}，失败 ${counts.failed}，阻塞 ${counts.blocked}，未执行 ${counts.neverRun}`}
        className={cn("insight-donut insight-case-outcome-donut", pageStyles["insight-donut"])}
        role="img"
        style={donutStyle(
          [
            { count: counts.succeeded, color: "var(--success)" },
            { count: counts.failed, color: "var(--destructive)" },
            { count: counts.blocked, color: "var(--warning)" },
            { count: counts.neverRun, color: "var(--muted-foreground)" },
          ],
          counts.total,
        )}
      >
        <span>
          <strong>{counts.total}</strong>
          <small>本页用例</small>
        </span>
      </div>
      <div className={cn("insight-outcome-legend", pageStyles["insight-outcome-legend"])}>
        <span>
          <i className={cn("insight-chart-success", pageStyles["insight-chart-success"])} />
          <small>成功</small>
          <strong>{counts.succeeded}</strong>
          <em>{formatRate(counts.succeeded, counts.total)}</em>
        </span>
        <span>
          <i className={cn("insight-chart-danger", pageStyles["insight-chart-danger"])} />
          <small>失败</small>
          <strong>{counts.failed}</strong>
          <em>{formatRate(counts.failed, counts.total)}</em>
        </span>
        <span>
          <i className={cn("insight-chart-warning", pageStyles["insight-chart-warning"])} />
          <small>阻塞</small>
          <strong>{counts.blocked}</strong>
          <em>{formatRate(counts.blocked, counts.total)}</em>
        </span>
        <span>
          <i className={cn("insight-chart-neutral", pageStyles["insight-chart-neutral"])} />
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
    <div className={cn("insight-detail-content", pageStyles["insight-detail-content"])}>
      <div className={cn("case-outcome-summary", pageStyles["case-outcome-summary"])} role="status">
        <span>
          本页 <strong>{counts.total}</strong> 个用例
        </span>
        <Badge
          className={cn(
            "batch-status batch-status-succeeded",
            pageStyles["batch-status"],
            pageStyles["batch-status-succeeded"],
          )}
        >
          成功 {counts.succeeded}（{formatRate(counts.succeeded, counts.total)}）
        </Badge>
        <Badge
          className={cn(
            "batch-status batch-status-failed",
            pageStyles["batch-status"],
            pageStyles["batch-status-failed"],
          )}
        >
          失败 {counts.failed}（{formatRate(counts.failed, counts.total)}）
        </Badge>
        <Badge
          className={cn(
            "batch-status batch-status-blocked",
            pageStyles["batch-status"],
            pageStyles["batch-status-blocked"],
          )}
        >
          阻塞 {counts.blocked}（{formatRate(counts.blocked, counts.total)}）
        </Badge>
        <Badge
          className={cn(
            "batch-status batch-status-neutral",
            pageStyles["batch-status"],
            pageStyles["batch-status-neutral"],
          )}
        >
          未执行 {counts.neverRun}（{formatRate(counts.neverRun, counts.total)}）
        </Badge>
      </div>
      {counts.total === 0 ? (
        <div className={cn("inline-empty", uiPatterns["inline-empty"])}>该项目版本还没有用例。</div>
      ) : (
        <div
          className={cn("insight-detail-table-scroll", pageStyles["insight-detail-table-scroll"])}
        >
          <Table
            className={cn(
              "data-table insight-detail-wide-table",
              uiPatterns["data-table"],
              pageStyles["insight-detail-wide-table"],
            )}
          >
            <TableHeader>
              <TableRow>
                <TableHead>用例</TableHead>
                <TableHead>类名</TableHead>
                <TableHead>最近结果</TableHead>
                <TableHead>最近执行时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((item) => {
                const outcome = report.outcomes.get(item.id);
                return (
                  <TableRow key={item.id}>
                    <TableCell title={item.displayName}>
                      <Link href={`/cases/${encodeURIComponent(item.id)}`}>{item.displayName}</Link>
                    </TableCell>
                    <TableCell title={item.className}>
                      <code>{item.className}</code>
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={cn(
                          pageStyles["batch-status"],
                          `batch-status ${outcomeBadgeClass(outcome)}`,
                        )}
                      >
                        {outcomeLabel(outcome)}
                      </Badge>
                    </TableCell>
                    <TableCell>
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
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {trail.length > 0 || report.nextCursor ? (
        <nav aria-label="用例执行情况分页" className={cn("pagination", pageStyles["pagination"])}>
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
  if (total <= 0) return { background: "var(--muted)" };
  let cursor = 0;
  const stops = segments.flatMap((segment) => {
    if (segment.count <= 0) return [];
    const start = cursor;
    cursor = Math.min(360, cursor + (segment.count / total) * 360);
    return `${segment.color} ${start.toFixed(2)}deg ${cursor.toFixed(2)}deg`;
  });
  if (cursor < 360) {
    stops.push(`var(--muted) ${cursor.toFixed(2)}deg 360deg`);
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

const pageStyles = {
  "batch-status": uiPatterns["batch-status"],
  "batch-status-blocked": "bg-warning/10 text-warning",
  "batch-status-failed": "bg-destructive/10 text-destructive",
  "batch-status-neutral": "bg-muted text-muted-foreground",
  "batch-status-succeeded": "bg-success/10 text-success",
  "case-outcome-summary":
    "flex flex-wrap gap-2 [padding:4px_0_12px] text-muted-foreground text-xs [&_strong]:text-foreground",
  "insight-advanced-filters":
    "[&_label]:grid [&_label]:min-w-0 [&_label]:gap-1.5 [&_label]:text-muted-foreground [&_label]:text-xs [&_label]:font-semibold [&_.ui-disclosure-label]:inline-flex [&_.ui-disclosure-label]:min-h-8 [&_.ui-disclosure-label]:items-center [&_.ui-disclosure-label]:gap-2 [&_.ui-disclosure-label]:text-info [&_.ui-disclosure-label]:text-sm [&_.ui-disclosure-body_>_div]:grid [&_.ui-disclosure-body_>_div]:grid-cols-3 [&_.ui-disclosure-body_>_div]:gap-3 [&_.ui-disclosure-body_>_div]:pt-3",
  "insight-case-outcome-chart": "flex min-h-0 flex-1 flex-wrap items-center justify-center gap-5",
  "insight-change-column":
    "[&_>_b]:text-muted-foreground [&_>_b]:text-xs [&_>_b]:tabular-nums [&_>_small]:overflow-hidden [&_>_small]:text-muted-foreground [&_>_small]:text-xs [&_>_small]:text-ellipsis [&_>_small]:whitespace-nowrap grid min-w-0 [grid-template-rows:auto_140px_auto] items-end gap-1.5 text-center [&_>_span]:flex [&_>_span]:h-[140px] [&_>_span]:items-end [&_>_span]:justify-center [&_>_span_>_i]:block [&_>_span_>_i]:w-[min(44px,_70%)] [&_>_span_>_i]:min-h-0 [&_>_span_>_i]:rounded-lg [&_>_span_>_i]:shadow-xs",
  "insight-change-column-chart":
    "grid min-w-0 gap-3 [&_>_p]:m-0 [&_>_p]:text-xs [&_>_p]:text-center",
  "insight-change-columns":
    "grid min-h-[180px] grid-cols-[repeat(4,_minmax(54px,_1fr))] items-end gap-[clamp(14px,_2vw,_30px)] px-3 border-b border-solid border-border",
  "insight-chart":
    "[&.insight-chart-success]:bg-success [&.insight-chart-danger]:bg-destructive [&.insight-chart-warning]:bg-warning [&.insight-chart-violet]:bg-info",
  "insight-chart-caption": "[margin:4px_0_0] text-muted-foreground text-xs text-right",
  "insight-chart-card":
    "flex min-h-96 min-w-0 flex-col overflow-hidden p-4 xl:p-5 [&_.ui-card-content_>_.inline-empty]:flex [&_.ui-card-content_>_.inline-empty]:flex-1 [&_.ui-card-content_>_.inline-empty]:items-center [&_.ui-card-content_>_.inline-empty]:justify-center [&_.section-heading]:flex-nowrap [&_.section-heading]:gap-2 [&_.section-heading_>_div:first-child]:min-w-0 [&_.section-heading_>_div:first-child]:flex-1 [&_.section-heading_.insight-chart-description]:mb-0 [&_.section-heading_.insight-chart-description]:text-xs [&_.section-heading_.insight-chart-description]:font-normal [&_.section-heading_.insight-chart-description]:leading-5 [&_.insight-chart-description]:line-clamp-2 [&_.insight-chart-description]:[overflow-wrap:anywhere]",
  "insight-chart-danger": "bg-destructive!",
  "insight-chart-info": "bg-info!",
  "insight-chart-legend":
    "flex justify-end gap-3.5 text-muted-foreground text-xs [&_span]:inline-flex [&_span]:items-center [&_span]:gap-1.5 [&_i]:w-2 [&_i]:h-2 [&_i]:[flex:0_0_auto] [&_i]:rounded-md",
  "insight-chart-neutral": "bg-muted-foreground!",
  "insight-chart-success": "bg-success!",
  "insight-chart-violet": "bg-info!",
  "insight-chart-warning": "bg-warning!",
  "insight-column-stack":
    "flex w-[min(34px,_70%)] min-h-1.5 overflow-hidden flex-col justify-end rounded-md bg-muted shadow-xs [&_>_i]:block [&_>_i]:w-full [&_>_i]:min-h-0.5",
  "insight-column-track":
    "flex w-full h-[150px] items-end justify-center [@media(min-width:_1024px)_and_(max-width:_1180px)]:h-[130px]",
  "insight-comparison-card": "col-span-full min-h-72",
  "insight-comparison-overview":
    "grid min-h-0 flex-1 grid-cols-2 items-center gap-6 border-t border-border pt-4",
  "insight-data-table": "min-w-[620px]",
  "insight-detail-content": "flex w-full min-h-0 flex-col gap-3",
  "insight-detail-long-text": "w-[52%] min-w-0",
  "insight-detail-table-scroll":
    "w-full min-h-0 [flex:1_1_auto] overflow-x-hidden overflow-y-auto [overscroll-behavior:contain] border border-solid border-border rounded-xl [scrollbar-gutter:stable] [&_.data-table]:w-full [&_.data-table]:min-w-0 [&_.data-table]:[table-layout:fixed] [&_.data-table_th]:sticky [&_.data-table_th]:z-1 [&_.data-table_th]:top-0 [&_.data-table_th]:shadow-xs [&_.data-table_td]:py-[13px] [&_.data-table_td]:leading-[1.5] [&_.data-table_td]:overflow-hidden [&_.data-table_td]:text-ellipsis [&_.data-table_td]:whitespace-nowrap [&_.data-table_tbody_tr:nth-child(even)]:bg-muted [&_.insight-comparison-table_th]:py-1 [&_.insight-comparison-table_th]:leading-[1.3] [&_.insight-comparison-table_td]:py-1 [&_.insight-comparison-table_td]:leading-[1.3] [&_.insight-comparison-table_th:last-child]:px-2 [&_.insight-comparison-table_td:last-child]:px-2",
  "insight-detail-wide-table": "min-w-0!",
  "insight-donut":
    "grid w-[156px] [aspect-ratio:1] [flex:0_0_auto] place-items-center rounded-full shadow-xs [&_>_span]:grid [&_>_span]:w-[104px] [&_>_span]:[aspect-ratio:1] [&_>_span]:[place-content:center] [&_>_span]:border [&_>_span]:border-solid [&_>_span]:border-border [&_>_span]:rounded-full [&_>_span]:bg-card [&_>_span]:shadow-xs [&_>_span]:text-center [&_strong]:text-2xl [&_strong]:tabular-nums [&_strong]:leading-[1.05] [&_small]:mt-1 [&_small]:text-muted-foreground [&_small]:text-xs",
  "insight-donut-group": "flex min-w-0 items-center justify-center gap-6.5 max-[1281px]:gap-4",
  "insight-donut-legend":
    "[&_span]:inline-flex [&_span]:items-center [&_span]:gap-1.5 [&_i]:w-2 [&_i]:h-2 [&_i]:[flex:0_0_auto] [&_i]:rounded-md grid min-w-[110px] gap-[9px] text-muted-foreground text-xs",
  "insight-failure-pie-chart":
    "grid min-h-0 flex-1 grid-cols-[96px_minmax(0,1fr)] items-center gap-4 min-[1440px]:grid-cols-[128px_minmax(0,1fr)]",
  "insight-filter":
    "grid min-w-0 gap-2 [&_label]:grid [&_label]:min-w-0 [&_label]:gap-1.5 [&_label]:text-muted-foreground [&_label]:text-xs [&_label]:font-semibold",
  "insight-flaky-card": "[grid-column:auto] max-[1181px]:[grid-column:auto]",
  "insight-flaky-column":
    "grid min-w-0 [grid-template-rows:auto_150px_auto_auto] items-end gap-[5px] text-center [&_>_b]:text-muted-foreground [&_>_b]:text-xs [&_>_b]:tabular-nums [&_>_small]:overflow-hidden [&_>_small]:text-muted-foreground [&_>_small]:text-xs [&_>_small]:text-ellipsis [&_>_small]:whitespace-nowrap [&_>_em]:text-muted-foreground [&_>_em]:text-xs [&_>_em]:[font-style:normal] [@media(min-width:_1024px)_and_(max-width:_1180px)]:[grid-template-rows:auto_130px_auto_auto]",
  "insight-flaky-column-chart":
    "grid min-w-0 min-h-0 [flex:1_1_auto] [grid-template-rows:auto_minmax(0,_1fr)_auto] gap-2 pt-2.5",
  "insight-flaky-columns":
    "grid min-h-[190px] grid-cols-[repeat(6,_minmax(42px,_1fr))] items-end gap-[clamp(8px,_1.4vw,_18px)] [padding:8px_8px_0] border-b border-solid border-border [background:repeating-linear-gradient(_to_bottom,_transparent_0,_transparent_49px,_var(--border)_50px_)] [@media(min-width:_1024px)_and_(max-width:_1180px)]:gap-[7px] [@media(min-width:_1024px)_and_(max-width:_1180px)]:px-0.5",
  "insight-flaky-filter":
    "grid grid-cols-2 items-end gap-2 rounded-lg border border-border bg-muted/40 p-3 [&_label]:grid [&_label]:min-w-0 [&_label]:gap-1 [&_label]:text-xs [&_label]:text-muted-foreground [&_label:first-child]:col-span-full [&_>_.ui-button]:w-fit min-[1440px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] min-[1440px]:[&_>_.ui-button]:max-w-full",
  "insight-flaky-scope": "mb-0 mt-2 text-xs [overflow-wrap:anywhere]",
  "insight-grid":
    "grid grid-cols-2 items-stretch gap-4 min-[1440px]:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]",
  "insight-heading-actions": "flex shrink-0 items-start justify-end",
  "insight-line-area": "[fill:url(#insight-trend-area)]",
  "insight-line-axis": "flex justify-between px-0.5 text-muted-foreground text-xs",
  "insight-line-axis-single": "justify-center",
  "insight-line-chart": "flex min-h-0 flex-1 flex-col justify-center gap-2",
  "insight-line-failed":
    "[fill:none] [stroke-linecap:round] [stroke-linejoin:round] [vector-effect:non-scaling-stroke] stroke-destructive [stroke-width:2.2]",
  "insight-line-grid": "stroke-border [stroke-dasharray:3_6] [stroke-width:1]",
  "insight-line-marker":
    "fill-card stroke-info [stroke-width:2] [vector-effect:non-scaling-stroke]",
  "insight-line-passed":
    "[fill:none] [stroke-linecap:round] [stroke-linejoin:round] [vector-effect:non-scaling-stroke] stroke-success [stroke-width:2.7]",
  "insight-line-plot": "block h-52 w-full overflow-visible",
  "insight-line-skipped":
    "[fill:none] [stroke-linecap:round] [stroke-linejoin:round] [vector-effect:non-scaling-stroke] stroke-warning [stroke-width:2.2]",
  "insight-line-summary":
    "flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-muted-foreground text-xs [&_span]:flex [&_span]:items-center [&_span]:gap-1.5 [&_i]:size-2 [&_i]:rounded-sm [&_b]:text-foreground [&_b]:tabular-nums [&_small]:text-xs",
  "insight-line-total":
    "[fill:none] [stroke-linecap:round] [stroke-linejoin:round] [vector-effect:non-scaling-stroke] stroke-info [stroke-opacity:0.42] [stroke-width:2]",
  "insight-metric":
    "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1 p-4 [&_.insight-metric-label]:col-start-1 [&_.insight-metric-label]:row-start-1 [&_.insight-metric-label]:text-muted-foreground [&_.insight-metric-label]:text-sm [&_strong]:col-start-1 [&_strong]:row-start-2 [&_strong]:text-2xl [&_strong]:tabular-nums [&_strong]:leading-8 [&_.insight-metric-description]:col-span-full [&_.insight-metric-description]:mt-1 [&_.insight-metric-description]:text-xs [&_.insight-metric-description]:text-muted-foreground [&.insight-metric-success_.insight-metric-icon]:bg-success/10 [&.insight-metric-success_.insight-metric-icon]:text-success [&.insight-metric-success_strong]:text-success [&.insight-metric-danger_.insight-metric-icon]:bg-destructive/10 [&.insight-metric-danger_.insight-metric-icon]:text-destructive [&.insight-metric-danger_strong]:text-destructive",
  "insight-metric-icon":
    "col-start-2 row-span-2 row-start-1 grid size-9 place-items-center rounded-lg bg-info/10 text-info",
  "insight-metrics": "grid grid-cols-4 gap-3",
  "insight-outcome-legend":
    "grid min-w-0 flex-1 basis-40 grid-cols-2 gap-2 [&_>_span]:grid [&_>_span]:min-w-0 [&_>_span]:grid-cols-[auto_minmax(0,1fr)] [&_>_span]:items-center [&_>_span]:gap-1.5 [&_>_span]:rounded-lg [&_>_span]:border [&_>_span]:border-border [&_>_span]:bg-muted/40 [&_>_span]:p-3 [&_i]:size-2 [&_i]:rounded-sm [&_small]:text-xs [&_small]:text-muted-foreground [&_strong]:col-span-full [&_strong]:text-xl [&_strong]:tabular-nums [&_em]:col-span-full [&_em]:text-muted-foreground [&_em]:text-xs [&_em]:not-italic",
  "insight-pie":
    "grid w-full aspect-square place-items-center rounded-full [&_>_span]:grid [&_>_span]:w-2/3 [&_>_span]:aspect-square [&_>_span]:place-content-center [&_>_span]:rounded-full [&_>_span]:bg-card [&_>_span]:text-center [&_strong]:text-xl [&_strong]:tabular-nums [&_small]:mt-1 [&_small]:text-muted-foreground [&_small]:text-xs",
  "insight-pie-legend":
    "grid min-w-0 gap-2 [&_>_span]:grid [&_>_span]:min-w-0 [&_>_span]:grid-cols-[8px_minmax(0,1fr)_auto] [&_>_span]:items-start [&_>_span]:gap-2 [&_>_span]:text-muted-foreground [&_>_span]:text-xs [&_>_span]:border-b [&_>_span]:border-border/60 [&_>_span]:pb-2 [&_i]:mt-1.5 [&_i]:size-2 [&_i]:rounded-sm [&_em]:text-foreground [&_em]:not-italic [&_em]:tabular-nums [&_em]:font-semibold [&_em]:leading-5",
  "insight-primary-filters":
    "grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto] items-end gap-3",
  "insight-trend-card": "min-w-0",
  "insights-page": "gap-4 [&_.page-hero]:flex-wrap",
  pagination: "flex justify-end py-3.5 px-4.5 border-t border-solid border-border",
  "status-warning":
    "[margin:0_0_10px] border border-solid border-transparent rounded-lg py-2 px-2.5 text-warning bg-warning/10 text-xs",
  "trend-failed": "bg-destructive",
  "trend-passed": "bg-success",
  "trend-skipped": "bg-warning",
} as const;
