import { Button, DatetimeInput, Input, Select } from "@/components/ui";

import { ClipboardList } from "lucide-react";
import Link from "next/link";

import { getPlatformServices } from "@/lib/services";
import { hasPermissionInAnyScope, requirePageProjectScope } from "@/lib/auth";
import {
  localDateTimeInputValue,
  refreshQueryFromFilter,
  runBatchFilterFromSearch,
} from "@/lib/run-batch-filter";
import {
  formatBatchDuration,
  isActiveRunBatch,
  runBatchDurationMs,
  runBatchPassRate,
  runBatchStatusLabel,
} from "@/lib/run-batch-presentation";

export const dynamic = "force-dynamic";

export default async function ExecutionRecordsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { identity, projectIds } = await requirePageProjectScope("run.read");
  const services = await getPlatformServices();
  const parameters = await searchParams;
  const filter = runBatchFilterFromSearch(parameters, projectIds);
  const canReadRunners = hasPermissionInAnyScope(identity, "runner.read");
  const [batchPage, suites, runners, projects] = await Promise.all([
    services.runBatches.listPage(filter),
    services.caseSuites.list(200, projectIds),
    canReadRunners ? services.runnerControl.list(500) : Promise.resolve([]),
    services.identities.listProjects(projectIds),
  ]);
  const visibleProjects = projectIds
    ? projects.filter((project) => projectIds.includes(project.id))
    : projects;
  const refreshQuery = refreshQueryFromFilter(filter);
  const nextQuery = new URLSearchParams(refreshQuery);
  if (batchPage.nextCursor) nextQuery.set("cursor", batchPage.nextCursor);
  return (
    <div className="page-stack">
      <section className="page-hero">
        <div>
          <span className="eyebrow">Execution Records</span>
          <h1>执行记录</h1>
          <p>每一次执行都以独立批次记录，可按任务、状态与时间筛选，点击进入详情查看日志与产物。</p>
        </div>
        <span className="hero-icon violet">
          <ClipboardList size={24} />
        </span>
      </section>
      <form className="content-card run-history-filter" method="get">
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
          用例 ID
          <Input defaultValue={filter.caseDefinitionId ?? ""} name="caseDefinitionId" />
        </label>
        <label>
          状态
          <Select defaultValue={filter.status ?? ""} name="status">
            <option value="">全部状态</option>
            <option value="queued">排队中</option>
            <option value="running">执行中</option>
            <option value="succeeded">成功</option>
            <option value="failed">失败</option>
            <option value="cancelled">已取消</option>
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
          开始时间
          <DatetimeInput
            defaultValue={localDateTimeInputValue(filter.createdAfter)}
            name="createdAfter"
          />
        </label>
        <label>
          结束时间
          <DatetimeInput
            defaultValue={localDateTimeInputValue(filter.createdBefore)}
            name="createdBefore"
          />
        </label>
        <Button className="button button-secondary" type="submit">
          筛选记录
        </Button>
        <Link className="button button-secondary" href={`/execution-records?${refreshQuery}`}>
          刷新
        </Link>
      </form>
      <section className="content-card execution-records-card">
        <div className="records-table-header">
          <h2>批次列表</h2>
          <span className="table-count">共 {batchPage.items.length} 条记录</span>
        </div>
        {batchPage.items.length === 0 ? (
          <div className="table-empty">
            <p>暂无符合条件的执行记录。</p>
            <Link className="button button-primary" href="/run-batches">
              前往发起执行
            </Link>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data-table execution-records-table">
              <thead>
                <tr>
                  <th>批次 ID</th>
                  <th>任务（Suite）</th>
                  <th>状态</th>
                  <th>通过率</th>
                  <th>已通过</th>
                  <th>已失败</th>
                  <th>当前轮次</th>
                  <th>重跑方式</th>
                  <th>执行机</th>
                  <th>创建时间</th>
                  <th>耗时</th>
                </tr>
              </thead>
              <tbody>
                {batchPage.items.map((batch) => (
                  <tr key={batch.id}>
                    <td>
                      <Link
                        className="table-link"
                        href={`/run-batches/${encodeURIComponent(batch.id)}`}
                      >
                        {batch.id.slice(0, 8)}…
                      </Link>
                    </td>
                    <td>
                      <strong>{batch.suiteName}</strong>
                      <small> v{batch.suiteVersion}</small>
                    </td>
                    <td>
                      <span className={`batch-status batch-status-${batch.status}`}>
                        {runBatchStatusLabel(batch.status)}
                      </span>
                    </td>
                    <td>{runBatchPassRate(batch)}%</td>
                    <td>{batch.succeededRuns}</td>
                    <td>{batch.failedRuns + batch.timedOutRuns}</td>
                    <td>{batch.retryMode === "round" ? `第 ${batch.currentRound} 轮` : "-"}</td>
                    <td>{batch.retryMode === "round" ? "整轮轮次" : "立即重跑"}</td>
                    <td>{batch.selectedRunnerIds.length}</td>
                    <td>
                      <time dateTime={batch.createdAt}>{formatRecordTime(batch.createdAt)}</time>
                    </td>
                    <td>
                      {isActiveRunBatch(batch.status)
                        ? "执行中"
                        : formatBatchDuration(runBatchDurationMs(batch))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {batchPage.nextCursor ? (
          <Link
            className="button button-secondary batch-next-page"
            href={`/execution-records?${nextQuery}`}
          >
            查看更早记录
          </Link>
        ) : null}
      </section>
    </div>
  );
}

function formatRecordTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}
