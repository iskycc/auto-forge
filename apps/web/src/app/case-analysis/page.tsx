import { LinkButton } from "@/components/ui/link-button";
import { Progress } from "@/components/ui/progress";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { failureAnalysisBatchPageSchema } from "@autoforge/contracts";
import { ReadModelStatusBar, ReadModelPendingPage } from "@/components/read-model-status";
import { DEFAULT_PROJECT_ID, hasPermission } from "@autoforge/domain";
import { ArrowRight, BarChart3, CheckCircle2, Clock3, SearchCheck } from "lucide-react";

import { StartFailureAnalysisDialog } from "@/components/start-failure-analysis-dialog";
import { FailureAnalysisExportButton } from "@/components/failure-analysis-export-button";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import {
  selectableProjectIds,
  selectedProjectHierarchy,
  selectedProjectId,
} from "@/lib/selected-project";
import { getPlatformServices } from "@/lib/services";

export const dynamic = "force-dynamic";

export default async function CaseAnalysisPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { identity } = await requirePageProjectScope("run.read");
  const services = await getPlatformServices();
  const parameters = await searchParams;
  const projects = await services.identities
    .listProjects(selectableProjectIds(identity))
    .catch(() => []);
  const projectId = (await selectedProjectId(identity, projects, "run.read")) ?? DEFAULT_PROJECT_ID;
  requireAuthorizedPageProjectScope(identity, "run.read", projectId);
  const structure = await services.projectStructures.list(projectId);
  const hierarchy = await selectedProjectHierarchy(structure);
  const selectedVersion = structure.versions.find(
    (version) => version.id === hierarchy.projectVersionId,
  );
  const cursor = singleParameter(parameters.cursor);
  const batchProjection = hierarchy.projectVersionId
    ? await services.readModels.read({
        kind: "analysis_batches",
        view: "started",
        projectId,
        projectVersionId: hierarchy.projectVersionId,
        ...(cursor ? { cursor } : {}),
        limit: 24,
      })
    : undefined;
  if (batchProjection && !batchProjection.generation)
    return <ReadModelPendingPage title="用例分析" snapshots={[batchProjection.status]} />;
  const batchPage = batchProjection
    ? failureAnalysisBatchPageSchema.parse(batchProjection.payload)
    : { items: [] };

  return (
    <div
      className={cn(
        "page-stack failure-analysis-page",
        uiPatterns["page-stack"],
        pageStyles["failure-analysis-page"],
      )}
    >
      <section className={cn("page-hero", uiPatterns["page-hero"])}>
        <div>
          <span className={cn("eyebrow", uiPatterns["eyebrow"])}>Failure Analysis</span>
          <h1>用例分析</h1>
          <p>按执行任务组织分析：先选择一次已结束的执行，再认领或分配最终失败用例。</p>
        </div>
        <span className={cn("hero-icon violet", pageStyles["hero-icon"])}>
          <SearchCheck size={24} />
        </span>
      </section>
      {batchProjection ? <ReadModelStatusBar snapshots={[batchProjection.status]} /> : null}
      <Card
        as="section"
        className={cn(
          "card case-scope-toolbar",
          uiPatterns["card"],
          pageStyles["case-scope-toolbar"],
        )}
        aria-label="用例分析范围"
      >
        <div className={cn("case-scope-heading", pageStyles["case-scope-heading"])}>
          <strong>当前分析范围</strong>
          <span>这里仅展示已开始分析的执行，当前项目内有查看权限的人员均可见。</span>
        </div>
        <div className={cn("case-scope-current", pageStyles["case-scope-current"])}>
          <span>
            <small>项目版本</small>
            <strong>{selectedVersion?.name ?? "尚未配置"}</strong>
          </span>
          {hierarchy.projectVersionId && hasPermission(identity, "analysis.manage", projectId) ? (
            <StartFailureAnalysisDialog
              projectId={projectId}
              projectVersionId={hierarchy.projectVersionId}
            />
          ) : null}
        </div>
      </Card>

      {batchPage.items.length === 0 ? (
        <Card
          as="section"
          className={cn(
            "content-card failure-analysis-empty",
            uiPatterns["content-card"],
            pageStyles["failure-analysis-empty"],
          )}
        >
          <CheckCircle2 size={26} />
          <strong>当前版本尚未创建分析任务</strong>
          <span>点击“新建分析任务”选择最近执行，也可从执行历史或执行详情开始分析。</span>
        </Card>
      ) : (
        <section
          className={cn("failure-analysis-batch-grid", pageStyles["failure-analysis-batch-grid"])}
          aria-label="可分析任务"
        >
          {batchPage.items.map((batch) => (
            <Card
              as="article"
              className={cn(
                "content-card failure-analysis-batch-card",
                uiPatterns["content-card"],
                pageStyles["failure-analysis-batch-card"],
              )}
              key={batch.id}
            >
              <div
                className={cn(
                  "failure-analysis-batch-heading",
                  pageStyles["failure-analysis-batch-heading"],
                )}
              >
                <span className={cn("eyebrow", uiPatterns["eyebrow"])}>
                  任务 #{batch.sequenceNumber}
                </span>
                <span
                  className={cn(
                    pageStyles["analysis-status"],
                    `analysis-status ${batch.completedRuns === batch.failedRuns ? "completed" : "available"}`,
                  )}
                >
                  {batch.completedRuns === batch.failedRuns ? "分析完成" : "分析中"}
                </span>
              </div>
              <h2>{batch.suiteName}</h2>
              <p>
                <Clock3 size={14} /> {formatPlatformDateTime(batch.createdAt)}
              </p>
              <dl>
                <div className={"round-metric"}>
                  <dt>最终轮次</dt>
                  <dd>第 {batch.currentRound} 轮</dd>
                </div>
                <div className={"failure-metric"}>
                  <dt>最终失败</dt>
                  <dd>{batch.failedRuns}</dd>
                </div>
                <div className={"claimed-metric"}>
                  <dt>已认领</dt>
                  <dd>{batch.claimedRuns}</dd>
                </div>
                <div className={"completed-metric"}>
                  <dt>已完成分析</dt>
                  <dd>{batch.completedRuns}</dd>
                </div>
              </dl>
              <div
                className={cn(
                  "failure-analysis-batch-progress",
                  pageStyles["failure-analysis-batch-progress"],
                )}
              >
                <span>
                  分析进度
                  <strong>
                    {batch.completedRuns} / {batch.failedRuns}
                  </strong>
                </span>
                <Progress
                  aria-label={`任务 ${batch.suiteName} 分析进度`}
                  max={Math.max(1, batch.failedRuns)}
                  value={batch.completedRuns}
                />
              </div>
              <div
                className={cn(
                  "failure-analysis-batch-actions",
                  pageStyles["failure-analysis-batch-actions"],
                )}
              >
                {hasPermission(identity, "audit.read", projectId) ? (
                  <LinkButton
                    className={"ui-button ui-button-secondary"}
                    href={`/case-analysis/${encodeURIComponent(batch.id)}/statistics`}
                  >
                    <BarChart3 size={15} /> 分析统计
                  </LinkButton>
                ) : null}
                <FailureAnalysisExportButton batchId={batch.id} />
                <LinkButton
                  aria-label="查看用例分析详情"
                  className={"ui-button ui-button-secondary failure-analysis-batch-link"}
                  href={`/case-analysis/${encodeURIComponent(batch.id)}`}
                >
                  进入分析工作台 <ArrowRight size={15} />
                </LinkButton>
              </div>
            </Card>
          ))}
        </section>
      )}

      {batchPage.items.length > 0 ? (
        <nav
          className={cn("failure-analysis-pagination", pageStyles["failure-analysis-pagination"])}
          aria-label="用例分析任务分页"
        >
          <span>本页 {batchPage.items.length} 个任务</span>
          {batchPage.nextCursor ? (
            <LinkButton
              className={"ui-button ui-button-secondary"}
              href={`/case-analysis?cursor=${encodeURIComponent(batchPage.nextCursor)}`}
            >
              查看更早任务 <ArrowRight size={15} />
            </LinkButton>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

function singleParameter(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const pageStyles = {
  "analysis-status":
    "inline-flex max-w-full [flex:0_0_auto] flex-wrap items-center gap-[5px] py-[3px] px-[7px] rounded-full bg-muted text-muted-foreground text-xs font-semibold [&.available]:bg-info/10 [&.available]:text-info [&.claimed]:bg-warning/10 [&.claimed]:text-warning [&.analyzing]:bg-info/10 [&.analyzing]:text-info [&.completed]:bg-success/10 [&.completed]:text-success [&_small]:overflow-hidden [&_small]:max-w-full [&_small]:text-inherit! [&_small]:text-ellipsis [&_small]:whitespace-nowrap",
  "case-scope-current":
    "[&_>_span]:flex [&_>_span]:min-w-0 [&_>_span]:gap-2 [&_>_span]:border-l [&_>_span]:border-solid [&_>_span]:border-border [&_>_span]:pl-3.5 [&_>_span]:items-center [&_small]:text-muted-foreground [&_small]:shrink-0 [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_strong]:[overflow-wrap:anywhere] grid min-w-0 grid-cols-[repeat(2,_minmax(140px,_1fr))] justify-self-end gap-2.5 max-[1181px]:w-full max-[1181px]:justify-self-stretch",
  "case-scope-heading":
    "grid gap-[3px] [&_span]:text-muted-foreground [&_span]:text-xs [&_summary]:cursor-pointer [&_summary]:text-muted-foreground [&_summary]:text-sm",
  "case-scope-toolbar":
    "grid grid-cols-[minmax(0,_1fr)_minmax(0,_2fr)] items-center gap-3 py-4 px-4.5 py-2 max-[1181px]:grid-cols-[1fr]",
  "failure-analysis-batch-actions":
    "flex flex-wrap items-center justify-end gap-2 [&_.ui-button]:[text-decoration:none]",
  "failure-analysis-batch-card":
    "[&_.failure-metric_dd]:text-destructive [&_.claimed-metric_dd]:text-info [&_.completed-metric_dd]:text-success grid min-w-0 gap-[9px] py-[15px] px-[17px] transition-colors duration-150 motion-reduce:transition-none [&:hover]:[border-color:color-mix(in_srgb,_var(--info)_24%,_var(--border))] [&:hover]:shadow-xs [&_.ui-card-content_>_p]:flex [&_.ui-card-content_>_p]:items-center [&_.ui-card-content_>_p]:gap-1.5 [&_.ui-card-content_>_p]:text-muted-foreground [&_.ui-card-content_>_p]:text-xs [&_dl]:grid [&_dl]:items-center [&_dl]:m-0 [&_dl]:grid-cols-2 [&_dl]:gap-[7px] [&_h2]:m-0 [&_h2]:overflow-hidden [&_h2]:text-lg [&_h2]:text-ellipsis [&_h2]:whitespace-nowrap [&_p]:m-0 [&_dl_>_div]:grid [&_dl_>_div]:gap-[3px] [&_dl_>_div]:py-[7px] [&_dl_>_div]:px-[9px] [&_dl_>_div]:rounded-lg [&_dl_>_div]:bg-muted [&_dt]:text-muted-foreground [&_dt]:text-xs [&_dd]:m-0 [&_dd]:font-semibold",
  "failure-analysis-batch-grid": "grid grid-cols-2 gap-3 max-[1025px]:grid-cols-[1fr]",
  "failure-analysis-batch-heading": "flex items-center justify-between gap-2",
  "failure-analysis-batch-progress":
    "grid gap-[7px] [&_>_span]:flex [&_>_span]:items-center [&_>_span]:justify-between [&_>_span]:text-muted-foreground [&_>_span]:text-xs [&_strong]:text-muted-foreground [&_.ui-progress]:w-full [&_.ui-progress]:h-[7px] [&_.ui-progress]:overflow-hidden [&_.ui-progress]:border-0 [&_.ui-progress]:rounded-full [&_.ui-progress]:bg-muted [&_.ui-progress]:[appearance:none] [&_progress::-webkit-progress-bar]:rounded-full [&_progress::-webkit-progress-bar]:bg-muted [&_progress::-webkit-progress-value]:rounded-full [&_progress::-webkit-progress-value]:bg-card [&_progress::-moz-progress-bar]:rounded-full [&_progress::-moz-progress-bar]:bg-card",
  "failure-analysis-empty":
    "grid min-h-[190px] place-items-center [align-content:center] gap-[9px] p-7 border border-dashed border-border rounded-lg bg-muted text-muted-foreground text-center [&_strong]:text-foreground",
  "failure-analysis-page": "gap-[clamp(14px,_1.5vw,_20px)]",
  "failure-analysis-pagination":
    "flex items-center justify-between gap-3 [&_>_span]:text-muted-foreground [&_>_span]:text-xs",
  "hero-icon":
    "inline-flex items-center gap-2 border border-solid border-border rounded-lg p-0 bg-card text-muted-foreground text-xs font-semibold shadow-xs w-12 h-12 justify-center [&.violet]:bg-muted [&.violet]:text-info",
} as const;
