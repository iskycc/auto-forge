import { EmptyState } from "@/components/ui/empty-state";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { ExecutionCaseFilter } from "@/components/execution-case-filter";
import { ReadModelStatusBar } from "@/components/read-model-status";
import { Button, DatetimeInput, Select } from "@/components/ui";
import {
  ExecutionRecordsTable,
  type ExecutionRecordRow,
} from "@/components/execution-records-table";

import { ClipboardList } from "lucide-react";
import { LinkButton } from "@/components/ui/link-button";

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
  const timeZone = services.configurationStore.read().web.timeZone;
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
      timeZone,
    ),
    ...(projectId ? { projectId } : {}),
    ...(hierarchy.projectVersionId ? { projectVersionId: hierarchy.projectVersionId } : {}),
  };
  const [batchPage, suites, runners] = await Promise.all([
    hierarchy.projectVersionId
      ? services.executionBatchPage(filter)
      : Promise.resolve({ items: [], nextCursor: undefined, statistics: undefined }),
    hierarchy.projectVersionId
      ? services.caseSuites.list(200, projectId ? [projectId] : [], hierarchy.projectVersionId)
      : Promise.resolve([]),
    canReadRunners ? services.runnerControl.list(500) : Promise.resolve([]),
  ]);
  const refreshQuery = refreshQueryFromFilter(filter);
  const nextQuery = new URLSearchParams(refreshQuery);
  if (batchPage.nextCursor) nextQuery.set("cursor", batchPage.nextCursor);
  const observedAt = services.clock.now().toISOString();
  const rows: ExecutionRecordRow[] = batchPage.items.map((batch) => ({
    id: batch.id,
    ...((batch.kind ?? "standard") === "standard" &&
    !batch.suiteId.startsWith("single:") &&
    batch.policy?.projectVersionId &&
    hasPermission(identity, "analysis.manage", batch.projectId)
      ? {
          analysisScope: {
            projectId: batch.projectId,
            projectVersionId: batch.policy.projectVersionId,
            batchId: batch.id,
          },
        }
      : {}),
    sequenceNumber: batch.sequenceNumber,
    suiteName: batch.suiteName,
    suiteVersion: batch.suiteVersion,
    status: batch.status,
    totalRuns: batch.totalRuns,
    succeededRuns: batch.succeededRuns,
    statisticsPending: batch.statisticsPending,
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
    <div
      className={cn(
        "page-stack execution-records-page",
        uiPatterns["page-stack"],
        pageStyles["execution-records-page"],
      )}
    >
      <section className={cn("page-hero", uiPatterns["page-hero"])}>
        <div>
          <span className={cn("eyebrow", uiPatterns["eyebrow"])}>Execution Records</span>
          <h1>执行记录</h1>
          <p>每一次执行都以独立批次记录，可按任务、状态与时间筛选，点击进入详情查看日志与产物。</p>
        </div>
        <span className={cn("hero-icon violet", pageStyles["hero-icon"])}>
          <ClipboardList size={24} />
        </span>
      </section>
      <section
        className={cn("scope-caption", pageStyles["scope-caption"])}
        aria-label="执行记录范围"
      >
        当前版本：{projectVersion?.name ?? "尚未配置"} · 仅展示此版本的任务与执行批次
      </section>
      <form
        className={cn(
          "content-card run-history-filter",
          uiPatterns["content-card"],
          pageStyles["run-history-filter"],
        )}
        method="get"
      >
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
        <ExecutionCaseFilter
          key={`${filter.caseDefinitionId ?? ""}:${hierarchy.projectVersionId}:${hierarchy.testStageId}`}
          initialId={filter.caseDefinitionId}
          projectId={projectId}
          projectVersionId={hierarchy.projectVersionId}
          testStageId={hierarchy.testStageId}
          canReadCases={hasPermission(identity, "case.read", projectId)}
        />
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
          开始时间
          <DatetimeInput
            defaultValue={localDateTimeInputValue(filter.createdAfter, timeZone)}
            name="createdAfter"
          />
        </label>
        <label>
          结束时间
          <DatetimeInput
            defaultValue={localDateTimeInputValue(filter.createdBefore, timeZone)}
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
        <div className="flex min-w-0 items-center gap-2 [&_>_*]:flex-1">
          <Button type="submit" variant="primary">
            筛选记录
          </Button>
          <LinkButton href="/execution-records">重置筛选</LinkButton>
        </div>
      </form>
      {batchPage.statistics ? <ReadModelStatusBar snapshots={[batchPage.statistics]} /> : null}
      <Card
        as="section"
        className={cn(
          "content-card execution-records-card",
          uiPatterns["content-card"],
          pageStyles["execution-records-card"],
        )}
      >
        <div className={"records-table-header"}>
          <h2>批次列表</h2>
          <span className={cn("table-count", pageStyles["table-count"])}>
            本页 {batchPage.items.length} 条 · 每页 {filter.limit} 条
          </span>
        </div>
        {batchPage.items.length === 0 ? (
          <EmptyState className={cn("table-empty", uiPatterns["table-empty"])}>
            <p>暂无符合条件的执行记录。</p>
            <LinkButton
              variant="primary"
              className={cn(
                "button button-primary",
                uiPatterns["button"],
                uiPatterns["button-primary"],
              )}
              href="/run-batches"
            >
              前往发起执行
            </LinkButton>
          </EmptyState>
        ) : (
          <ExecutionRecordsTable
            canTerminate={hasPermission(identity, "run.cancel", projectId)}
            rows={rows}
          />
        )}
        {batchPage.nextCursor ? (
          <LinkButton
            className={cn(
              "button button-secondary batch-next-page",
              uiPatterns["button"],
              uiPatterns["button-secondary"],
              pageStyles["batch-next-page"],
            )}
            href={`/execution-records?${nextQuery}`}
          >
            查看更早记录
          </LinkButton>
        ) : null}
      </Card>
    </div>
  );
}

const pageStyles = {
  "batch-next-page": "mt-4 w-full justify-center",
  "execution-records-card":
    "[&_.records-table-header]:flex [&_.records-table-header]:items-center [&_.records-table-header]:justify-between [&_.records-table-header]:gap-3 [&_.records-table-header]:[padding:4px_0_14px] [&_.records-table-header_h2]:m-0 [&_.records-table-header_h2]:text-base [&_.batch-next-page]:mt-4",
  "execution-records-page": "[&_.run-history-filter]:p-3 [&_.run-history-filter]:gap-3",
  "hero-icon":
    "inline-flex items-center gap-2 border border-solid border-border rounded-lg p-0 bg-card text-muted-foreground text-xs font-semibold shadow-xs w-12 h-12 justify-center [&.violet]:bg-muted [&.violet]:text-info",
  "run-history-filter":
    "grid grid-cols-[repeat(auto-fit,_minmax(180px,_1fr))] gap-3 items-end [&_label]:grid [&_label]:min-w-0 [&_label]:gap-2 [&_label]:text-muted-foreground [&_label]:text-xs [&_label]:font-semibold",
  "scope-caption": "m-0 text-muted-foreground text-sm",
  "table-count": "text-muted-foreground text-xs whitespace-nowrap",
} as const;
