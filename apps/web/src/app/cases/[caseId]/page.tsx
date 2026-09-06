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
    <div className="page-stack case-detail-page">
      <section className="page-hero case-detail-hero">
        <div>
          <Link
            className="back-link"
            href={`/cases?${new URLSearchParams({
              projectId: definition.projectId,
              projectVersionId: definition.projectVersionId!,
              testStageId: definition.testStageId!,
            }).toString()}`}
          >
            <ArrowLeft size={15} aria-hidden="true" /> 返回用例管理
          </Link>
          <span className="eyebrow case-detail-eyebrow">Case Definition</span>
          <h1 title={definition.displayName}>{definition.displayName}</h1>
          <p>
            <code>{definition.className}</code>
          </p>
        </div>
        <div className="case-detail-actions">
          <CasePermanentShare caseDefinitionId={definition.id} />
          {canRun && definition.enabled && !definition.archived && executable ? (
            <OpenRunDialogButton
              caseDefinitionId={definition.id}
              className="button button-primary"
            />
          ) : null}
          <span className="storage-pill">
            <FileCode2 size={16} aria-hidden="true" /> 当前版本 v{definition.currentVersion}
          </span>
        </div>
      </section>

      <CaseDetailContent detail={detail} />
    </div>
  );
}
