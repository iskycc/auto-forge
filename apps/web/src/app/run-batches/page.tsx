import { Button, Input, Select } from "@/components/ui";

import { Activity } from "lucide-react";

import { RunBatchPlanner } from "@/components/run-batch-planner";
import { getPlatformServices } from "@/lib/services";
import { hasPermissionInAnyScope, requirePageProjectScope } from "@/lib/auth";
import type { RunBatchListQuery } from "@autoforge/application";
import { projectIdsForPermission } from "@autoforge/domain";

export const dynamic = "force-dynamic";

export default async function RunBatchesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { identity, projectIds } = await requirePageProjectScope("run.read");
  const services = await getPlatformServices();
  const parameters = await searchParams;
  const filter = runBatchFilter(parameters, projectIds);
  const creatableProjectIds = projectIdsForPermission(identity, "run.create");
  const canCreateRuns = creatableProjectIds === undefined || creatableProjectIds.length > 0;
  const canReadRunners = hasPermissionInAnyScope(identity, "runner.read");
  const environmentProjectIds = hasPermissionInAnyScope(identity, "environment.read")
    ? services.identityAccess.projectScope(identity, "environment.read")
    : [];
  const [suites, runners, batchPage, projects, environmentSummaries] = await Promise.all([
    services.caseSuites.list(200, projectIds),
    canReadRunners ? services.runnerControl.list(500) : Promise.resolve([]),
    services.runBatches.listPage(filter),
    services.identities.listProjects(projectIds),
    environmentProjectIds?.length === 0
      ? Promise.resolve([])
      : services.executionEnvironments.list(environmentProjectIds),
  ]);
  const environments = await Promise.all(
    environmentSummaries.map((environment) =>
      services.executionEnvironments.get(environment.id, environmentProjectIds),
    ),
  );
  const refreshQuery = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (key !== "projectIds" && value !== undefined) refreshQuery.set(key, String(value));
  }
  const nextQuery = new URLSearchParams(refreshQuery);
  if (batchPage.nextCursor) nextQuery.set("cursor", batchPage.nextCursor);
  const visibleProjects = projectIds
    ? projects.filter((project) => projectIds.includes(project.id))
    : projects;
  const creatableSuites =
    creatableProjectIds === undefined
      ? suites
      : suites.filter((suite) => creatableProjectIds.includes(suite.projectId));
  return (
    <div className="page-stack">
      <section className="page-hero">
        <div>
          <span className="eyebrow">Dynamic Scheduler</span>
          <h1>用例批跑</h1>
          <p>选择任务、执行机和环境，平台依据 Agent 实时资源快照动态生成执行分配。</p>
        </div>
        <span className="hero-icon violet">
          <Activity size={24} />
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
          <Input
            defaultValue={localDateTime(filter.createdAfter)}
            name="createdAfter"
            type="datetime-local"
          />
        </label>
        <label>
          结束时间
          <Input
            defaultValue={localDateTime(filter.createdBefore)}
            name="createdBefore"
            type="datetime-local"
          />
        </label>
        <Button className="button button-secondary" type="submit">
          筛选记录
        </Button>
      </form>
      <RunBatchPlanner
        canCreate={canCreateRuns}
        initialSuites={creatableSuites}
        initialRunners={runners}
        initialEnvironments={environments}
        initialBatches={batchPage.items}
        historyRefreshUrl={`/api/v1/run-batches?${refreshQuery}`}
        {...(batchPage.nextCursor ? { nextPageHref: `/run-batches?${nextQuery}` } : {})}
        policy={services.runBatches.policy()}
      />
    </div>
  );
}

function runBatchFilter(
  parameters: Record<string, string | string[] | undefined>,
  projectIds: string[] | undefined,
): RunBatchListQuery {
  const value = (key: string) =>
    typeof parameters[key] === "string" && parameters[key]
      ? (parameters[key] as string)
      : undefined;
  const date = (key: string) => {
    const raw = value(key);
    if (!raw) return undefined;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  };
  const status = value("status");
  const cursor = value("cursor");
  const projectId = value("projectId");
  const suiteId = value("suiteId");
  const caseDefinitionId = value("caseDefinitionId");
  const runnerId = value("runnerId");
  const createdAfter = date("createdAfter");
  const createdBefore = date("createdBefore");
  const normalizedStatus =
    status && ["queued", "running", "succeeded", "failed", "cancelled"].includes(status)
      ? (status as NonNullable<RunBatchListQuery["status"]>)
      : undefined;
  return {
    limit: 50,
    ...(projectIds ? { projectIds } : {}),
    ...(cursor ? { cursor } : {}),
    ...(projectId ? { projectId } : {}),
    ...(suiteId ? { suiteId } : {}),
    ...(caseDefinitionId ? { caseDefinitionId } : {}),
    ...(runnerId ? { runnerId } : {}),
    ...(createdAfter ? { createdAfter } : {}),
    ...(createdBefore ? { createdBefore } : {}),
    ...(normalizedStatus ? { status: normalizedStatus } : {}),
  };
}

function localDateTime(value: string | undefined): string {
  return value ? value.slice(0, 16) : "";
}
