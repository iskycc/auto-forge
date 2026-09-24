import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { failureAnalysisBatchPageSchema } from "@autoforge/contracts";
import { ReadModelStatusBar } from "@/components/read-model-status";
import { DEFAULT_PROJECT_ID, hasPermission } from "@autoforge/domain";
import { SearchCheck } from "lucide-react";

import { StartFailureAnalysisDialog } from "@/components/start-failure-analysis-dialog";
import { FailureAnalysisBatches } from "@/components/failure-analysis-batches";
import { analysisPageStyles as pageStyles } from "@/components/failure-analysis-batches.styles";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
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
  const view = singleParameter(parameters.view) === "archived" ? "archived" : "started";
  const cursor = singleParameter(parameters.cursor);
  const batchProjection = hierarchy.projectVersionId
    ? await services.readModels.read({
        kind: "analysis_batches",
        lifecycleVersion: 2,
        view,
        projectId,
        projectVersionId: hierarchy.projectVersionId,
        ...(cursor ? { cursor } : {}),
        limit: 24,
      })
    : undefined;
  const batchPage = batchProjection?.generation
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
          <span>
            {view === "archived"
              ? "归档任务保留分析记录，当前项目内有查看权限的人员均可查阅。"
              : "仅展示正在处理的分析任务，当前项目内有查看权限的人员均可见。"}
          </span>
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

      <FailureAnalysisBatches
        key={`${projectId}:${hierarchy.projectVersionId}:${view}`}
        batchPage={batchPage}
        view={view}
        projectId={projectId}
        projectVersionId={hierarchy.projectVersionId ?? ""}
        canOrganize={hasPermission(identity, "analysis.assign", projectId)}
        canReadStatistics={hasPermission(identity, "audit.read", projectId)}
        loading={Boolean(batchProjection && !batchProjection.generation)}
      />
    </div>
  );
}

function singleParameter(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
