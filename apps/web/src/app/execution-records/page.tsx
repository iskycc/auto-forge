import { Button, DatetimeInput, Input, Select } from "@/components/ui";
import {
  ExecutionRecordsTable,
  type ExecutionRecordRow,
} from "@/components/execution-records-table";

import { ClipboardList } from "lucide-react";
import Link from "next/link";

import { getPlatformServices } from "@/lib/services";
import {
  hasPermissionInAnyScope,
  requireAuthorizedPageProjectScope,
  requirePageProjectScope,
} from "@/lib/auth";
import {
  selectableProjectIds,
  selectedProjectHierarchy,
  selectedProjectId,
} from "@/lib/selected-project";
import { hasPermission } from "@autoforge/domain";
import {
  localDateTimeInputValue,
  refreshQueryFromFilter,
  runBatchFilterFromSearch,
  RUN_BATCH_PAGE_SIZE_OPTIONS,
} from "@/lib/run-batch-filter";

export const dynamic = "force-dynamic";

export default async function ExecutionRecordsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { identity } = await requirePageProjectScope("run.read");
  const services = await getPlatformServices();
  const parameters = await searchParams;
  const canReadRunners = hasPermissionInAnyScope(identity, "runner.read");
  const projects = await services.identities
    .listProjects(selectableProjectIds(identity))
    .catch(() => []);
  const projectId = await selectedProjectId(identity, projects, "run.read");
  requireAuthorizedPageProjectScope(identity, "run.read", projectId);
  const structure = projectId
    ? await services.projectStructures.list(projectId).catch(() => undefined)
    : undefined;
  const hierarchy = await selectedProjectHierarchy(structure);
  const projectVersion = structure?.versions.find(
    (version) => version.id === hierarchy.projectVersionId,
  );
  const filter = {
    ...runBatchFilterFromSearch(
      { ...parameters, projectId: undefined },
      projectId ? [projectId] : [],
    ),
    ...(projectId ? { projectId } : {}),
    ...(hierarchy.projectVersionId ? { projectVersionId: hierarchy.projectVersionId } : {}),
  };
  const [batchPage, suites, runners] = await Promise.all([
    hierarchy.projectVersionId
      ? services.runBatches.listPage(filter)
      : Promise.resolve({ items: [], nextCursor: undefined }),
    hierarchy.projectVersionId
      ? services.caseSuites.list(200, projectId ? [projectId] : [], hierarchy.projectVersionId)
      : Promise.resolve([]),
    canReadRunners ? services.runnerControl.list(500) : Promise.resolve([]),
  ]);
  const refreshQuery = refreshQueryFromFilter(filter);
  const nextQuery = new URLSearchParams(refreshQuery);
  if (batchPage.nextCursor) nextQuery.set("cursor", batchPage.nextCursor);
  const observedAt = new Date().toISOString();
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
    scheduledFor: batch.scheduledFor,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    observedAt,
    ...(batch.terminationRequestedAt
      ? { terminationRequestedAt: batch.terminationRequestedAt }
      : {}),
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
      <section className="card case-scope-toolbar" aria-label="执行记录范围">
        <div className="case-scope-heading">
          <strong>当前执行范围</strong>
          <span>仅展示顶栏当前项目版本创建的任务和执行批次。</span>
        </div>
        <div className="case-scope-current">
          <span>
            <small>项目版本</small>
            <strong>{projectVersion?.name ?? "尚未配置"}</strong>
          </span>
        </div>
      </section>
      <form className="content-card run-history-filter" method="get">
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
            <option value="succeeded">执行完成</option>
            <option value="failed">执行异常</option>
            <option value="cancelled">已终止</option>
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
        <label>
          每页条数
          <Select defaultValue={String(filter.limit)} name="limit">
            {RUN_BATCH_PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={String(size)}>
                {size} 条
              </option>
            ))}
          </Select>
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
          <span className="table-count">
            本页 {batchPage.items.length} 条 · 每页 {filter.limit} 条
          </span>
        </div>
        {batchPage.items.length === 0 ? (
          <div className="table-empty">
            <p>暂无符合条件的执行记录。</p>
            <Link className="button button-primary" href="/run-batches">
              前往发起执行
            </Link>
          </div>
        ) : (
          <ExecutionRecordsTable
            canTerminate={hasPermission(identity, "run.cancel", projectId)}
            rows={rows}
          />
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
