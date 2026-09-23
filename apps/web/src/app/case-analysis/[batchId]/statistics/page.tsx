import { LinkButton } from "@/components/ui/link-button";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import {
  failureAnalysisBatchSchema,
  failureAnalysisStatisticsPageSchema,
} from "@autoforge/contracts";
import { ReadModelStatusBar, ReadModelPendingPage } from "@/components/read-model-status";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { notFound } from "next/navigation";
import { BarChart3 } from "lucide-react";

import { FailureAnalysisStatistics } from "@/components/failure-analysis-statistics";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import {
  selectableProjectIds,
  selectedProjectHierarchy,
  selectedProjectId,
} from "@/lib/selected-project";
import { getPlatformServices } from "@/lib/services";

export const dynamic = "force-dynamic";

export default async function FailureAnalysisStatisticsPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;
  const { identity } = await requirePageProjectScope("audit.read");
  const services = await getPlatformServices();
  const projects = await services.identities
    .listProjects(selectableProjectIds(identity))
    .catch(() => []);
  const projectId =
    (await selectedProjectId(identity, projects, "audit.read")) ?? DEFAULT_PROJECT_ID;
  requireAuthorizedPageProjectScope(identity, "audit.read", projectId);
  const hierarchy = await selectedProjectHierarchy(
    await services.projectStructures.list(projectId),
  );
  if (!hierarchy.projectVersionId) notFound();
  const batchProjection = await services.readModels.read({
    kind: "analysis_batch",
    projectId,
    projectVersionId: hierarchy.projectVersionId,
    batchId,
  });

  const projection = await services.readModels.read({
    kind: "analysis_statistics",
    projectId,
    batchId,
    projectVersionId: hierarchy.projectVersionId,
    limit: 50,
  });

  if (!projection.generation || !batchProjection.generation)
    return (
      <ReadModelPendingPage
        title="分析统计"
        snapshots={[projection.status, batchProjection.status]}
      />
    );
  if (!batchProjection.payload) notFound();
  const batch = failureAnalysisBatchSchema.parse(batchProjection.payload);
  const initialPage = failureAnalysisStatisticsPageSchema.parse(projection.payload);
  return (
    <div className={cn("page-stack failure-analysis-statistics-page", uiPatterns["page-stack"])}>
      <section className={cn("page-hero", uiPatterns["page-hero"])}>
        <div>
          <span className={cn("eyebrow", uiPatterns["eyebrow"])}>
            Failure Analysis · Statistics
          </span>
          <h1>分析统计</h1>
          <p>
            任务 #{batch.sequenceNumber} · {batch.suiteName}；仅统计这一次执行的分析进度与人员结论。
          </p>
          <LinkButton
            className={"ui-button ui-button-secondary"}
            href={`/case-analysis/${encodeURIComponent(batchId)}`}
          >
            返回当前分析任务
          </LinkButton>
        </div>
        <span className={cn("hero-icon violet", pageStyles["hero-icon"])}>
          <BarChart3 aria-hidden="true" size={24} />
        </span>
      </section>
      <ReadModelStatusBar snapshots={[projection.status, batchProjection.status]} />
      <FailureAnalysisStatistics
        initialPage={initialPage}
        failedRuns={batch.failedRuns}
        batchId={batchId}
        projectId={projectId}
        {...(hierarchy.projectVersionId ? { projectVersionId: hierarchy.projectVersionId } : {})}
      />
    </div>
  );
}

const pageStyles = {
  "hero-icon":
    "inline-flex items-center gap-2 border border-solid border-border rounded-lg p-0 bg-card text-muted-foreground text-xs font-semibold shadow-xs w-12 h-12 justify-center [&.violet]:bg-muted [&.violet]:text-info",
} as const;
