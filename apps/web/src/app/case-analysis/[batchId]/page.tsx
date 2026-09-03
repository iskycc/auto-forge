import { failureAnalysisClaimSchema } from "@autoforge/contracts";
import { DEFAULT_PROJECT_ID, hasPermission } from "@autoforge/domain";
import { notFound } from "next/navigation";

import { FailureAnalysisDetail } from "@/components/failure-analysis-detail";
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
  const [batch, initialCandidatePage, initialClaimPage, initialMyClaimCount] = await Promise.all([
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
          sort: "class_path",
          direction: "asc",
          limit: 50,
        })
      : undefined,
    services.failureAnalysis.countMyClaims({
      projectId,
      projectVersionId: hierarchy.projectVersionId,
      claimantId: identity.user.id,
      batchId,
    }),
  ]);
  if (!batch) notFound();

  return (
    <FailureAnalysisDetail
      batch={batch}
      canManage={hasPermission(identity, "analysis.manage", projectId)}
      initialCandidatePage={initialCandidatePage}
      initialClaimPage={
        initialClaimPage
          ? {
              ...initialClaimPage,
              items: failureAnalysisClaimSchema.array().parse(initialClaimPage.items),
            }
          : undefined
      }
      initialMyClaimCount={initialMyClaimCount}
      initialView={initialView}
      key={batch.id}
      projectId={projectId}
      projectVersionId={hierarchy.projectVersionId}
    />
  );
}

function singleParameter(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
