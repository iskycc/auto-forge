import { Button, DatetimeInput, Input, Select } from "@/components/ui";

import type { AnalyticsFilter } from "@autoforge/contracts";
import type { CaseDefinitionWithMethods } from "@autoforge/domain";
import { BarChart3, FlaskConical, SlidersHorizontal, TrendingUp } from "lucide-react";
import Link from "next/link";

import { requirePageProjectScope } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { listCompleteCaseDirectory } from "@/lib/case-directory";
import { formatRate, type CaseLatestRun } from "@/lib/case-selection-stats";
import { classifyAttemptResult } from "@autoforge/domain";
import { AnalyticsExportControl } from "@/components/analytics-export-control";

const CASE_OUTCOME_DETAIL_LIMIT = 500;

type CaseOutcomeReport = {
  projectId: string;
  versionId: string;
  versionName: string;
  versions: Array<{ id: string; name: string }>;
  cases: CaseDefinitionWithMethods[];
  outcomes: Map<string, CaseLatestRun>;
  executedAt: Map<string, string>;
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
  const filter = analyticsFilter(parameters);
  const [summary, projects, suites, runners] = await Promise.all([
    services.platformOperations.analytics(identity, filter),
    services.identities.listProjects(projectIds),
    services.caseSuites.list(500, projectIds),
    services.runnerControl.list(500),
  ]);
  const comparison =
    typeof parameters.leftBatchId === "string" && typeof parameters.rightBatchId === "string"
      ? await services.platformOperations.compareBatches(
          identity,
          parameters.leftBatchId,
          parameters.rightBatchId,
        )
      : undefined;
  const visibleProjects = projectIds
    ? projects.filter((project) => projectIds.includes(project.id))
    : projects;
  const caseProjectId = stringParameter(parameters.caseProjectId) || undefined;
  const caseProjectVersionId = stringParameter(parameters.caseProjectVersionId) || undefined;
  const caseOutcomeReport = await loadCaseOutcomeReport({
    services,
    ...(caseProjectId ? { caseProjectId } : {}),
    ...(caseProjectVersionId ? { caseProjectVersionId } : {}),
    ...(projectIds ? { allowedProjectIds: projectIds } : {}),
  });
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
            项目
            <Select defaultValue={filter.projectId ?? ""} name="projectId">
              <option value="">全部可访问项目</option>
              {visibleProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </label>
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
              环境版本 ID
              <Input defaultValue={filter.environmentVersionId ?? ""} name="environmentVersionId" />
            </label>
            <label>
              失败特征
              <Input defaultValue={filter.failureSignature ?? ""} name="failureSignature" />
            </label>
            <label>
              开始时间（UTC）
              <DatetimeInput
                defaultValue={dateTimeLocal(filter.completedAfter)}
                name="completedAfter"
              />
            </label>
            <label>
              结束时间（UTC）
              <DatetimeInput
                defaultValue={dateTimeLocal(filter.completedBefore)}
                name="completedBefore"
              />
            </label>
          </div>
        </details>
      </form>

      <section aria-label="项目版本用例执行情况" className="content-card">
        <div className="section-heading">
          <div>
            <span className="eyebrow">CASE OUTCOMES</span>
            <h2>项目 / 版本用例执行情况</h2>
          </div>
          {caseOutcomeReport ? (
            <span className="muted">
              {caseOutcomeReport.versionName} · 共 {caseOutcomeReport.cases.length} 个用例
            </span>
          ) : null}
        </div>
        <form className="case-outcome-filter" method="get">
          <label>
            项目
            <Select defaultValue={caseProjectId ?? ""} name="caseProjectId">
              <option value="">请选择项目</option>
              {visibleProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </label>
          <label>
            项目版本
            <Select defaultValue={caseOutcomeReport?.versionId ?? ""} name="caseProjectVersionId">
              <option value="">默认版本</option>
              {caseOutcomeReport?.versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {version.name}
                </option>
              ))}
            </Select>
          </label>
          <Button className="button button-primary" type="submit">
            查看执行情况
          </Button>
        </form>
        {caseOutcomeReport ? (
          <CaseOutcomeSummary report={caseOutcomeReport} />
        ) : (
          <div className="inline-empty">选择项目与项目版本，查看该范围内用例的最新执行状态。</div>
        )}
      </section>

      <section className="content-card">
        <div className="section-heading">
          <div>
            <span className="eyebrow">COMPARE</span>
            <h2>批次对比</h2>
          </div>
        </div>
        <form className="batch-comparison-form" method="get">
          <Input
            name="leftBatchId"
            defaultValue={stringParameter(parameters.leftBatchId)}
            placeholder="基准批次 ID"
            required
          />
          <Input
            name="rightBatchId"
            defaultValue={stringParameter(parameters.rightBatchId)}
            placeholder="对比批次 ID"
            required
          />
          <Button className="button button-secondary" type="submit">
            开始对比
          </Button>
        </form>
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
            输入两个可访问批次 ID，按相同用例范围比较版本、环境、Runner、结果和耗时。
          </div>
        )}
      </section>

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
              UTC · {methodSampleCount} 个方法结果 · {summary.sampleCount} 次执行
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
                    <small>
                      最近出现于 {failure.lastSeenAt.slice(0, 19).replace("T", " ")} UTC
                    </small>
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
    ...(value("suiteId") ? { suiteId: value("suiteId") } : {}),
    ...(value("runnerId") ? { runnerId: value("runnerId") } : {}),
    ...(value("caseDefinitionId") ? { caseDefinitionId: value("caseDefinitionId") } : {}),
    ...(value("environmentVersionId")
      ? { environmentVersionId: value("environmentVersionId") }
      : {}),
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

function CaseOutcomeSummary({ report }: { report: CaseOutcomeReport }) {
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
          共 <strong>{total}</strong> 个用例
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
                <th>最近执行时间（UTC）</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, CASE_OUTCOME_DETAIL_LIMIT).map((item) => {
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
                    <td>{report.executedAt.get(item.id) ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {total > CASE_OUTCOME_DETAIL_LIMIT ? (
        <p className="muted">
          共 {total} 个用例，此处仅展示前 {CASE_OUTCOME_DETAIL_LIMIT}{" "}
          个；请使用项目/版本或搜索缩小范围。
        </p>
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
  allowedProjectIds?: string[];
}): Promise<CaseOutcomeReport | undefined> {
  const { services, caseProjectId, caseProjectVersionId, allowedProjectIds } = input;
  if (!caseProjectId) return undefined;
  if (allowedProjectIds && !allowedProjectIds.includes(caseProjectId)) return undefined;
  const structure = await services.projectStructures.list(caseProjectId).catch(() => undefined);
  if (!structure) return undefined;
  const version =
    structure.versions.find((candidate) => candidate.id === caseProjectVersionId) ??
    structure.versions[0];
  if (!version) return undefined;
  const cases = await listCompleteCaseDirectory(services.catalog, {
    projectIds: [caseProjectId],
    projectVersionId: version.id,
  });
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
    versions: structure.versions.map((candidate) => ({ id: candidate.id, name: candidate.name })),
    cases,
    outcomes,
    executedAt,
  };
}
