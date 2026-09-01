import { failureAnalysisClaimSchema } from "@autoforge/contracts";
import { DEFAULT_PROJECT_ID, hasPermission } from "@autoforge/domain";
import { ArrowLeft, SearchCheck } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { FailureAnalysisExportButton } from "@/components/failure-analysis-export-button";
import { FailureAnalysisWorkspace } from "@/components/failure-analysis-workspace";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import {
  selectableProjectIds,
  selectedProjectHierarchy,
  selectedProjectId,
} from "@/lib/selected-project";
import { getPlatformServices } from "@/lib/services";

export const dynamic = "force-dynamic";

export default async function CaseAnalysisDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { batchId } = await params;
  const parameters = await searchParams;
  const { identity } = await requirePageProjectScope("run.read");
  const services = await getPlatformServices();
  const projects = await services.identities
    .listProjects(selectableProjectIds(identity))
    .catch(() => []);
  const projectId = (await selectedProjectId(identity, projects, "run.read")) ?? DEFAULT_PROJECT_ID;
  requireAuthorizedPageProjectScope(identity, "run.read", projectId);
  const hierarchy = await selectedProjectHierarchy(
    await services.projectStructures.list(projectId),
  );
  if (!hierarchy.projectVersionId) notFound();
  const initialView = singleParameter(parameters.view) === "workbench" ? "workbench" : "claim";
  const [batch, initialCandidatePage, initialClaimPage] = await Promise.all([
    services.failureAnalysis.getBatch({
      projectId,
      projectVersionId: hierarchy.projectVersionId,
      batchId,
    }),
    initialView === "claim"
      ? services.failureAnalysis.listCandidates({
          projectId,
          projectVersionId: hierarchy.projectVersionId,
          batchId,
          sort: "class_path",
          direction: "asc",
          limit: 50,
        })
      : undefined,
    initialView === "workbench"
      ? services.failureAnalysis.listMyClaims({
          projectId,
          projectVersionId: hierarchy.projectVersionId,
          claimantId: identity.user.id,
          batchId,
          limit: 50,
        })
      : undefined,
  ]);
  if (!batch) notFound();

  return (
    <div className="page-stack failure-analysis-page">
      <section className="page-hero failure-analysis-detail-hero">
        <div className="failure-analysis-detail-heading">
          <Link className="text-link" href="/case-analysis">
            <ArrowLeft size={14} /> 返回分析任务
          </Link>
          <span className="eyebrow">Failure Analysis · #{batch.sequenceNumber}</span>
          <h1>{batch.suiteName}</h1>
          <div className="failure-analysis-detail-metrics" aria-label="任务分析概览">
            <span>
              最终轮次 <strong>第 {batch.currentRound} 轮</strong>
            </span>
            <span className="failure-metric">
              最终失败 <strong>{batch.failedRuns}</strong>
            </span>
            <span className="claimed-metric">
              已认领 <strong>{batch.claimedRuns}</strong>
            </span>
            <span className="completed-metric">
              已完成 <strong>{batch.completedRuns}</strong>
            </span>
          </div>
        </div>
        <div className="failure-analysis-detail-actions">
          <FailureAnalysisExportButton batchId={batch.id} />
          <span className="hero-icon violet">
            <SearchCheck size={24} />
          </span>
        </div>
      </section>
      <FailureAnalysisWorkspace
        canManage={hasPermission(identity, "analysis.manage", projectId)}
        initialCandidatePage={initialCandidatePage}
        initialBatchId={batch.id}
        initialClaimPage={
          initialClaimPage
            ? {
                ...initialClaimPage,
                items: failureAnalysisClaimSchema.array().parse(initialClaimPage.items),
              }
            : undefined
        }
        initialView={initialView}
        projectId={projectId}
        projectVersionId={hierarchy.projectVersionId}
      />
    </div>
  );
}

function singleParameter(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
