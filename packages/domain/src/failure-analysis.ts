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
