import { DomainError } from "./errors";

export function requireActiveFailureAnalysisBatch(archivedAt: string | null | undefined): void {
  if (archivedAt)
    throw new DomainError(
      "FAILURE_ANALYSIS_ARCHIVED_CONFLICT",
      "该分析任务已归档，仅支持查看，不能继续修改。",
    );
}

export function requireFailureAnalysisBatchTransition(
  action: "close" | "archive",
  lifecycle: { progressStartedAt: string | null; archivedAt: string | null },
): void {
  requireActiveFailureAnalysisBatch(lifecycle.archivedAt);
  if (action === "close" && lifecycle.progressStartedAt)
    throw new DomainError(
      "FAILURE_ANALYSIS_HAS_PROGRESS_CONFLICT",
      "该任务已有分析进展，不能关闭，请使用归档。",
    );
  if (action === "archive" && !lifecycle.progressStartedAt)
    throw new DomainError(
      "FAILURE_ANALYSIS_NO_PROGRESS_CONFLICT",
      "该任务尚无分析进展，请使用关闭分析任务。",
    );
}

export const failureAnalysisCategories = [
  "rerun_passed",
  "case_fixed",
  "code_issue_filed",
] as const;

export type FailureAnalysisCategory = (typeof failureAnalysisCategories)[number];

export type FailureAnalysisStatus = "claimed" | "analyzing" | "completed";

export type FailureAnalysisScreenshot = {
  objectKey: string;
  fileName: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  sizeBytes: number;
  sha256: string;
};

export type FailureAnalysisRemarkImage = FailureAnalysisScreenshot & { id: string };

export type FailureAnalysisClaim = {
  id: string;
  projectId: string;
  batchId: string;
  executionRunId: string;
  caseDefinitionId: string;
  attemptId: string;
  caseName: string;
  className: string;
  attemptNumber: number;
  failureSummary: string;
  resultCode?: string;
  status: FailureAnalysisStatus;
  category?: FailureAnalysisCategory;
  claimantId: string;
  claimantUsername: string;
  claimantDisplayName: string;
  claimedAt: string;
  analysisStartedAt?: string;
  completedAt?: string;
  issueDescription?: string;
  caseFixEvidence?: string;
  ticketReference?: string;
  remark?: string;
  remarkImages?: FailureAnalysisRemarkImage[];
  rerunProofAttemptId?: string;
  rerunProofUrl?: string;
  screenshot?: FailureAnalysisScreenshot;
  updatedAt: string;
};

/** 认领释放后保留的审计快照；活动认领删除后，同一用例可以再次被认领。 */
export type FailureAnalysisClaimRelease = {
  id: string;
  analysisId: string;
  projectId: string;
  batchId: string;
  executionRunId: string;
  caseDefinitionId: string;
  claimantId: string;
  claimantUsername: string;
  claimantDisplayName: string;
  reason: string;
  claimedAt: string;
  releasedAt: string;
};
