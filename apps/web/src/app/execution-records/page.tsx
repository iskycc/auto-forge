import { Button, DatetimeInput, Input, Select } from "@/components/ui";
import {
  ExecutionRecordsTable,
  type ExecutionRecordRow,
} from "@/components/execution-records-table";

import { ClipboardList } from "lucide-react";
import Link from "next/link";

import { getPlatformServices } from "@/lib/services";
import { hasPermissionInAnyScope, requirePageProjectScope } from "@/lib/auth";
import {
  localDateTimeInputValue,
  refreshQueryFromFilter,
  runBatchFilterFromSearch,
} from "@/lib/run-batch-filter";

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
  const rows: ExecutionRecordRow[] = batchPage.items.map((batch) => ({
    id: batch.id,
    sequenceNumber: batch.sequenceNumber,
    suiteName: batch.suiteName,
    suiteVersion: batch.suiteVersion,
    status: batch.status,
    totalRuns: batch.totalRuns,
    succeededRuns: batch.succeededRuns,
    failedRuns: batch.failedRuns,
    timedOutRuns: batch.timedOutRuns,
    retryMode: batch.retryMode,
    currentRound: batch.currentRound,
    selectedRunnerCount: batch.selectedRunnerIds.length,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
  }));
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
          <ExecutionRecordsTable rows={rows} />
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
