import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { isDomainError } from "@autoforge/domain";
import { ArrowLeft, FileCode2 } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CaseDetailContent } from "@/components/case-detail-content";
import { CasePermanentShare } from "@/components/case-permanent-share";
import { OpenRunDialogButton } from "@/components/global-run-dialog";
import { requirePageProjectScope } from "@/lib/auth";
import { loadCaseDetail } from "@/lib/load-case-detail";
import { getPlatformServices } from "@/lib/services";

export const dynamic = "force-dynamic";

type CaseDetailPageProps = { params: Promise<{ caseId: string }> };

export default async function CaseDetailPage({ params }: CaseDetailPageProps) {
  const { identity, projectIds } = await requirePageProjectScope("case.read");
  const { caseId } = await params;
  const services = await getPlatformServices();
  let detail;
  try {
    detail = await loadCaseDetail(services, identity, caseId, projectIds);
  } catch (error) {
    if (isDomainError(error) && error.code === "CASE_DEFINITION_NOT_FOUND") notFound();
    throw error;
  }
  const { definition, canRun, executable } = detail;

  return (
    <div className={cn("page-stack case-detail-page", uiPatterns["page-stack"])}>
      <section className="case-detail-hero grid min-w-0 gap-3">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <Link
            className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-primary"
            href={`/cases?${new URLSearchParams({
              projectId: definition.projectId,
              projectVersionId: definition.projectVersionId!,
              testStageId: definition.testStageId!,
            }).toString()}`}
          >
            <ArrowLeft size={15} aria-hidden="true" /> 返回用例管理
          </Link>
          <div className="case-detail-actions flex max-w-full flex-wrap items-center gap-2">
            <CasePermanentShare caseDefinitionId={definition.id} />
            {canRun && definition.enabled && !definition.archived && executable ? (
              <OpenRunDialogButton caseDefinitionId={definition.id} variant="primary" />
            ) : null}
          </div>
        </div>
        <div className="min-w-0">
          <h1
            className="m-0 text-2xl font-semibold leading-snug break-all"
            title={definition.displayName}
          >
            {definition.displayName}
          </h1>
          <p className="mb-0 mt-2 text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
            <code>{definition.className}</code>
          </p>
        </div>

        <Badge variant="info">
          <FileCode2 size={14} aria-hidden="true" /> 当前版本 v{definition.currentVersion}
        </Badge>
      </section>

      <CaseDetailContent detail={detail} />
    </div>
  );
}
