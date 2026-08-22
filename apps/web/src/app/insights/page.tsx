import { Button, DatetimeInput, Input, Select } from "@/components/ui";

import type { AnalyticsFilter } from "@autoforge/contracts";
import type { CaseDefinitionWithMethods } from "@autoforge/domain";
import { BarChart3, FlaskConical, SlidersHorizontal, TrendingUp } from "lucide-react";
import Link from "next/link";

import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { formatRate, type CaseLatestRun } from "@/lib/case-selection-stats";
import { classifyAttemptResult } from "@autoforge/domain";
import { AnalyticsExportControl } from "@/components/analytics-export-control";
import {
  selectableProjectIds,
  selectedProjectHierarchy,
  selectedProjectId,
} from "@/lib/selected-project";
import { formatLocalDateTime, runBatchStatusLabel } from "@/lib/run-batch-presentation";

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
    ...analyticsFilter({
      ...parameters,
      projectId: undefined,
      projectVersionId: undefined,
      testStageId: undefined,
    }),
    ...(caseProjectId ? { projectId: caseProjectId } : {}),
    ...(hierarchy.projectVersionId ? { projectVersionId: hierarchy.projectVersionId } : {}),
    ...(hierarchy.testStageId ? { testStageId: hierarchy.testStageId } : {}),
  };
  const [summary, suites, runners, recentBatches] = await Promise.all([
    services.platformOperations.analytics(identity, filter),
    services.caseSuites.list(500, caseProjectId ? [caseProjectId] : []),
    services.runnerControl.list(500),
    services.runBatches.list(100, caseProjectId ? [caseProjectId] : []),
  ]);
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
  const trendMaximum = Math.max(1, ...summary.trend.map((entry) => entry.total));
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
          <Button className="button button-primary" type="submit">
            应用筛选
          </Button>
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
              开始时间（本地）
              <DatetimeInput
                defaultValue={dateTimeLocal(filter.completedAfter)}
                name="completedAfter"
              />
            </label>
            <label>
              结束时间（本地）
              <DatetimeInput
                defaultValue={dateTimeLocal(filter.completedBefore)}
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
        <article className="content-card insight-trend-card">
          <div className="section-heading">
            <div>
              <span className="eyebrow">TREND</span>
              <h2>每日趋势</h2>
            </div>
            <span className="muted">
              已确认方法结果 {methodSampleCount} 个 · 执行样本 {summary.sampleCount} 次
            </span>
          </div>
          {summary.trend.length === 0 ? (
            <div className="inline-empty">当前筛选范围还没有已确认执行结果。</div>
          ) : (
            <>
              <div className="trend-legend" aria-hidden="true">
                <span>
                  <i className="trend-passed" />
                  通过
                </span>
                <span>
                  <i className="trend-failed" />
                  失败
                </span>
                <span>
                  <i className="trend-skipped" />
                  跳过
                </span>
              </div>
              <div
                className="trend-bars"
                role="img"
                aria-label="每日 TestNG 方法通过、失败与跳过趋势图"
                style={{
                  gridTemplateColumns: `repeat(${summary.trend.length}, minmax(54px, 84px))`,
                  maxWidth: `${summary.trend.length * 92}px`,
                }}
              >
                {summary.trend.map((bucket) => (
                  <div className="trend-column" key={bucket.bucket}>
                    <div
                      className="trend-column-bars"
                      title={`${bucket.bucket.slice(0, 10)}：通过 ${bucket.passed}，失败 ${bucket.failed}，跳过 ${bucket.skipped}`}
                    >
                      <span
                        className="trend-passed"
                        style={{ height: `${(bucket.passed / trendMaximum) * 100}%` }}
                      />
                      <span
                        className="trend-failed"
                        style={{ height: `${(bucket.failed / trendMaximum) * 100}%` }}
                      />
                      <span
                        className="trend-skipped"
                        style={{ height: `${(bucket.skipped / trendMaximum) * 100}%` }}
                      />
                    </div>
                    <em>{bucket.total}</em>
                    <small>{bucket.bucket.slice(5, 10)}</small>
                  </div>
                ))}
              </div>
            </>
          )}
          {summary.trend.length > 0 ? (
            <details className="insight-trend-details">
              <summary>查看每日明细（{summary.trend.length} 天）</summary>
              <div className="table-scroll">
                <table className="data-table insight-data-table">
                  <thead>
                    <tr>
                      <th>日期（UTC）</th>
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
              </div>
            </details>
          ) : null}
        </article>

        <article className="content-card insight-failure-card">
          <div className="section-heading">
            <div>
              <span className="eyebrow">FAILURES</span>
              <h2>失败原因</h2>
            </div>
          </div>
          {summary.failures.length === 0 ? (
            <div className="inline-empty">暂无可聚类的失败。</div>
          ) : (
            <ol className="failure-signature-list">
              {summary.failures.map((failure) => (
                <li key={failure.signature}>
                  <span>
                    <strong title={failure.description}>{failure.description}</strong>
                    <small>最近出现于 {formatLocalDateTime(failure.lastSeenAt)}</small>
                  </span>
                  <b>{failure.count} 次</b>
                </li>
              ))}
            </ol>
          )}
        </article>

        <article className="content-card insight-flaky-card">
          <div className="section-heading">
            <div>
              <span className="eyebrow">FLAKY</span>
              <h2>不稳定用例</h2>
            </div>
          </div>
          {summary.flakyCases.length === 0 ? (
            <div className="inline-empty">至少需要 5 个成功与失败混合样本。</div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>用例</th>
                    <th>样本</th>
                    <th>成功/失败</th>
                    <th>置信</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.flakyCases.map((item) => (
                    <tr key={item.caseDefinitionId}>
                      <td>
                        <Link href={`/cases/${item.caseDefinitionId}`}>{item.displayName}</Link>
                      </td>
                      <td>{item.samples}</td>
                      <td>
                        {item.passed}/{item.failed}
                      </td>
                      <td>{percent(item.confidence)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>
      </section>

      <section aria-label="当前层级用例执行情况" className="content-card insight-case-outcome-card">
        <div className="section-heading">
          <div>
            <span className="eyebrow">CASE OUTCOMES</span>
            <h2>当前层级用例执行情况</h2>
          </div>
          {caseOutcomeReport ? (
            <span className="muted">
              {caseOutcomeReport.versionName} / {caseOutcomeReport.stageName} · 本页{" "}
              {caseOutcomeReport.cases.length} 个用例
            </span>
          ) : null}
        </div>
        {caseOutcomeReport ? (
          <CaseOutcomeSummary
            parameters={parameters}
            report={caseOutcomeReport}
            trail={caseCursorTrail}
          />
        ) : (
          <div className="inline-empty">请在顶栏选择项目，并确认该项目已配置可用版本。</div>
        )}
      </section>

      <section className="content-card insight-comparison-card">
        <div className="section-heading">
          <div>
            <span className="eyebrow">COMPARE</span>
            <h2>批次对比</h2>
          </div>
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
          <Button className="button button-secondary" type="submit">
            开始对比
          </Button>
        </form>
        <p className="muted">可选择当前项目最近 100 个批次；更早记录请先在执行记录中定位。</p>
        {comparison ? (
          <>
            <p className={comparison.comparableScope ? "status-success" : "status-warning"}>
              共同用例 {comparison.commonCaseCount} 个；仅基准 {comparison.onlyLeftCaseCount}{" "}
              个；仅对比 {comparison.onlyRightCaseCount} 个。
              {comparison.comparableScope
                ? " 样本范围一致。"
                : " 样本范围不同，不直接比较总体百分比。"}
            </p>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>用例</th>
                    <th>版本变化</th>
                    <th>结果变化</th>
                    <th>耗时变化</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.cases.map((item) => (
                    <tr key={item.caseDefinitionId}>
                      <td>
                        {item.displayName}
                        <small className="table-secondary">{item.caseDefinitionId}</small>
                      </td>
                      <td>
                        {item.leftVersion ?? "-"} → {item.rightVersion ?? "-"}
                      </td>
                      <td>
                        {item.leftOutcome ?? "-"} → {item.rightOutcome ?? "-"}
                      </td>
                      <td>
                        {item.durationDeltaMs === undefined
                          ? "-"
                          : `${item.durationDeltaMs >= 0 ? "+" : ""}${item.durationDeltaMs} ms`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="inline-empty">
            选择两个可访问批次，按相同用例范围比较版本、环境、Runner、结果和耗时。
          </div>
        )}
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

function analyticsFilter(
  parameters: Record<string, string | string[] | undefined>,
): AnalyticsFilter {
  const value = (key: string) =>
    typeof parameters[key] === "string" && parameters[key]
      ? (parameters[key] as string)
      : undefined;
  const iso = (key: string) => {
    const raw = value(key);
    if (!raw) return undefined;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
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
function dateTimeLocal(value?: string): string {
  return value ? value.slice(0, 16) : "";
}

function CaseOutcomeSummary({
  report,
  parameters,
  trail,
}: {
  report: CaseOutcomeReport;
  parameters: Record<string, string | string[] | undefined>;
  trail: readonly string[];
}) {
  const total = report.cases.length;
  let succeededCount = 0;
  let failedCount = 0;
  let blockedCount = 0;
  for (const item of report.cases) {
    const run = report.outcomes.get(item.id);
    if (!run) continue;
    switch (classifyAttemptResult(run)) {
      case "succeeded":
        succeededCount += 1;
        break;
      case "failed":
        failedCount += 1;
        break;
      case "blocked":
        blockedCount += 1;
        break;
    }
  }
  const neverRunCount = total - succeededCount - failedCount - blockedCount;
  // 失败与阻塞优先展示：把尚未稳定的用例排在表格前面。
  const rows = [...report.cases].sort(
    (left, right) =>
      outcomeRank(report.outcomes.get(left.id)).localeCompare(
        outcomeRank(report.outcomes.get(right.id)),
      ) || left.displayName.localeCompare(right.displayName),
  );
  return (
    <>
      <div className="case-outcome-summary" role="status">
        <span>
          本页 <strong>{total}</strong> 个用例
        </span>
        <span className="batch-status batch-status-succeeded">
          成功 {succeededCount}（{formatRate(succeededCount, total)}）
        </span>
        <span className="batch-status batch-status-failed">
          失败 {failedCount}（{formatRate(failedCount, total)}）
        </span>
        <span className="batch-status batch-status-blocked">
          阻塞 {blockedCount}（{formatRate(blockedCount, total)}）
        </span>
        <span className="batch-status batch-status-neutral">
          未执行 {neverRunCount}（{formatRate(neverRunCount, total)}）
        </span>
      </div>
      {total === 0 ? (
        <div className="inline-empty">该项目版本还没有用例。</div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
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
                    <td>
                      <Link href={`/cases/${encodeURIComponent(item.id)}`}>{item.displayName}</Link>
                    </td>
                    <td>
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
                          {formatLocalDateTime(report.executedAt.get(item.id)!)}
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
    </>
  );
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
