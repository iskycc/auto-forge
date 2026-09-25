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
    <div
      className={cn(
        "page-stack case-detail-page",
        uiPatterns["page-stack"],
        pageStyles["case-detail-page"],
      )}
    >
      <section
        className={cn(
          "page-hero case-detail-hero",
          uiPatterns["page-hero"],
          pageStyles["case-detail-hero"],
        )}
      >
        <div>
          <Link
            className={cn("back-link", pageStyles["back-link"])}
            href={`/cases?${new URLSearchParams({
              projectId: definition.projectId,
              projectVersionId: definition.projectVersionId!,
              testStageId: definition.testStageId!,
            }).toString()}`}
          >
            <ArrowLeft size={15} aria-hidden="true" /> 返回用例管理
          </Link>
          <span
            className={cn(
              "eyebrow case-detail-eyebrow",
              uiPatterns["eyebrow"],
              pageStyles["case-detail-eyebrow"],
            )}
          >
            Case Definition
          </span>
          <h1 title={definition.displayName}>{definition.displayName}</h1>
          <p>
            <code>{definition.className}</code>
          </p>
        </div>
        <div className={cn("case-detail-actions", pageStyles["case-detail-actions"])}>
          <CasePermanentShare caseDefinitionId={definition.id} />
          {canRun && definition.enabled && !definition.archived && executable ? (
            <OpenRunDialogButton
              caseDefinitionId={definition.id}
              className={cn(
                "button button-primary",
                uiPatterns["button"],
                uiPatterns["button-primary"],
              )}
            />
          ) : null}
          <Badge className={cn("storage-pill", pageStyles["storage-pill"])}>
            <FileCode2 size={16} aria-hidden="true" /> 当前版本 v{definition.currentVersion}
          </Badge>
        </div>
      </section>

      <CaseDetailContent detail={detail} />
    </div>
  );
}

const pageStyles = {
  "back-link":
    "text-muted-foreground font-semibold inline-flex items-center gap-1.5 mb-[5px] text-sm w-fit [&:hover]:[text-decoration:underline]",
  "case-detail-actions": "flex items-center justify-end gap-2",
  "case-detail-eyebrow": "block",
  "case-detail-hero":
    "[&_>_div]:grid [&_>_div]:min-w-0 [&_>_div]:justify-items-start [&_.back-link]:mb-[9px] [&_h1]:[display:-webkit-box] [&_h1]:max-w-full [&_h1]:overflow-hidden [&_h1]:[overflow-wrap:anywhere] [&_h1]:leading-[1.3] [&_h1]:[-webkit-box-orient:vertical] [&_h1]:[-webkit-line-clamp:2] [&_code]:[overflow-wrap:anywhere] [&_code]:[word-break:break-word]",
  "case-detail-page":
    "w-[min(100%,_clamp(1280px,_82vw,_1920px))] [&_.source-meta-grid]:grid-cols-4 [&_.source-meta-grid_strong]:overflow-visible [&_.source-meta-grid_strong]:text-sm [&_.source-meta-grid_strong]:leading-[1.45] [&_.source-meta-grid_strong]:text-clip [&_.source-meta-grid_strong]:whitespace-normal [&_.source-meta-grid_strong]:[overflow-wrap:anywhere] [&_.source-meta-grid_code]:overflow-visible [&_.source-meta-grid_code]:text-sm [&_.source-meta-grid_code]:leading-[1.45] [&_.source-meta-grid_code]:text-clip [&_.source-meta-grid_code]:whitespace-normal [&_.source-meta-grid_code]:[overflow-wrap:anywhere] [&_.source-meta-wide]:col-span-full max-[1281px]:[&_.source-meta-grid]:grid-cols-2",
  "storage-pill":
    "inline-flex items-center gap-2 border border-solid border-border rounded-full py-[9px] px-[13px] bg-card text-muted-foreground text-xs font-semibold shadow-xs",
} as const;
