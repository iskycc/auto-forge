import { Button, Input, Select } from "@/components/ui";

import type { AnalyticsFilter } from "@autoforge/contracts";
import { BarChart3, FlaskConical, SlidersHorizontal, TrendingUp } from "lucide-react";
import Link from "next/link";

import { requirePageProjectScope } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { AnalyticsExportControl } from "@/components/analytics-export-control";

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
              失败签名
              <Input defaultValue={filter.failureSignature ?? ""} name="failureSignature" />
            </label>
            <label>
              开始时间（UTC）
              <Input
                defaultValue={dateTimeLocal(filter.completedAfter)}
                name="completedAfter"
                type="datetime-local"
              />
            </label>
            <label>
              结束时间（UTC）
              <Input
                defaultValue={dateTimeLocal(filter.completedBefore)}
                name="completedBefore"
                type="datetime-local"
              />
            </label>
          </div>
        </details>
      </form>

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
          label="成功率"
          tone="success"
          value={percent(summary.successRate)}
        />
        <Metric
          icon={BarChart3}
          label="失败率"
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
            <span className="muted">UTC · {summary.sampleCount} 个 attempt</span>
          </div>
          {summary.trend.length === 0 ? (
            <div className="inline-empty">当前筛选范围还没有已确认执行结果。</div>
          ) : (
            <div className="trend-bars" role="img" aria-label="每日成功失败趋势图">
              {summary.trend.map((bucket) => {
                const maximum = Math.max(1, ...summary.trend.map((entry) => entry.total));
                return (
                  <div
                    className="trend-column"
                    key={bucket.bucket}
                    title={`${bucket.bucket.slice(0, 10)}：${bucket.total}`}
                  >
                    <span
                      className="trend-failed"
                      style={{ height: `${(bucket.failed / maximum) * 100}%` }}
                    />
                    <span
                      className="trend-passed"
                      style={{ height: `${(bucket.passed / maximum) * 100}%` }}
                    />
                    <small>{bucket.bucket.slice(5, 10)}</small>
                  </div>
                );
              })}
            </div>
          )}
          {summary.trend.length > 0 ? (
            <div className="table-scroll">
              <table className="data-table insight-data-table">
                <thead>
                  <tr>
                    <th>日期（UTC）</th>
                    <th>Attempt</th>
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

        <article className="content-card">
          <div className="section-heading">
            <div>
              <span className="eyebrow">FAILURES</span>
              <h2>失败签名</h2>
            </div>
          </div>
          {summary.failures.length === 0 ? (
            <div className="inline-empty">暂无可聚类的失败。</div>
          ) : (
            <ol className="failure-signature-list">
              {summary.failures.map((failure) => (
                <li key={failure.signature}>
                  <span>
                    <strong>{failure.resultCode ?? "UNKNOWN"}</strong>
                    <small>{failure.signature}</small>
                  </span>
                  <b>{failure.count}</b>
                </li>
              ))}
            </ol>
          )}
        </article>

        <article className="content-card">
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
                        <Link href={`/cases/${item.caseDefinitionId}`}>
                          {item.caseDefinitionId}
                        </Link>
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
