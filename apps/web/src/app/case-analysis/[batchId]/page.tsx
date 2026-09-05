import { ReadModelStatusBar } from "@/components/read-model-status";
import {
  failureAnalysisClaimSchema,
  failureAnalysisBatchSchema,
  failureAnalysisCompletionOrderSchema,
  failureAnalysisSortSchema,
} from "@autoforge/contracts";
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
  const initialFilters = {
    candidateQuery: searchQueryParameter(parameters.candidateQuery),
    candidateSort: enumParameter(parameters.candidateSort, failureAnalysisSortSchema, "class_path"),
    candidateDirection: directionParameter(parameters.candidateDirection),
    analysisQuery: searchQueryParameter(parameters.analysisQuery),
    analysisSort: enumParameter(parameters.analysisSort, failureAnalysisSortSchema, "class_path"),
    analysisDirection: directionParameter(parameters.analysisDirection),
    completionOrder: enumParameter(
      parameters.completionOrder,
      failureAnalysisCompletionOrderSchema,
      "pending_first",
    ),
    includeCompleted: singleParameter(parameters.includeCompleted) !== "false",
  } as const;
  const projection = await services.readModels.read({
    kind: "analysis_batch",
    projectId,
    projectVersionId: hierarchy.projectVersionId,
    batchId,
  });
  if (!projection.generation) return <ReadModelStatusBar snapshots={[projection.status]} />;
  const batch = projection.payload ? failureAnalysisBatchSchema.parse(projection.payload) : null;
  if (!batch) notFound();
  const [initialCandidatePage, initialClaimPage, initialMyClaimCount, progress] = await Promise.all(
    [
      initialView === "claim"
        ? services.failureAnalysis.listCandidates({
            projectId,
            projectVersionId: hierarchy.projectVersionId,
            batchId,
            sort: initialFilters.candidateSort,
            direction: initialFilters.candidateDirection,
            limit: 50,
            ...(initialFilters.candidateQuery ? { query: initialFilters.candidateQuery } : {}),
          })
        : undefined,
      initialView === "workbench"
        ? services.failureAnalysis.listMyClaims({
            projectId,
            projectVersionId: hierarchy.projectVersionId,
            claimantId: identity.user.id,
            batchId,
            sort: initialFilters.analysisSort,
            direction: initialFilters.analysisDirection,
            completionOrder: initialFilters.completionOrder,
            includeCompleted: initialFilters.includeCompleted,
            limit: 50,
            ...(initialFilters.analysisQuery ? { query: initialFilters.analysisQuery } : {}),
          })
        : undefined,
      services.failureAnalysis.countMyClaims({
        projectId,
        projectVersionId: hierarchy.projectVersionId,
        claimantId: identity.user.id,
        batchId,
      }),
      services.failureAnalysis.readBatchProgress(projectId, batchId),
    ],
  );
  if (!batch) notFound();

  return (
    <FailureAnalysisDetail
      batch={{ ...batch, ...progress }}
      currentUserId={identity.user.id}
      canAssign={hasPermission(identity, "analysis.assign", projectId)}
      canReadStatistics={hasPermission(identity, "audit.read", projectId)}
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
      initialFilters={initialFilters}
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

function searchQueryParameter(value: string | string[] | undefined): string {
  return singleParameter(value)?.trim().slice(0, 240) ?? "";
}

function directionParameter(value: string | string[] | undefined): "asc" | "desc" {
  return singleParameter(value) === "desc" ? "desc" : "asc";
}

function enumParameter<Value extends string>(
  value: string | string[] | undefined,
  schema: {
    safeParse(value: unknown): { success: true; data: Value } | { success: false };
  },
  fallback: Value,
): Value {
  const parsed = schema.safeParse(singleParameter(value));
  return parsed.success ? parsed.data : fallback;
}
