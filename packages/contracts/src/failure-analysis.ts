import { z } from "zod";

export const failureAnalysisCategorySchema = z.enum([
  "rerun_passed",
  "case_fixed",
  "code_issue_filed",
]);

export const failureAnalysisStatusSchema = z.enum(["claimed", "analyzing", "completed"]);

export const failureAnalysisScreenshotSchema = z.object({
  fileName: z.string().min(1),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const failureAnalysisSortSchema = z.enum([
  "class_path",
  "failure_summary",
  "case_name",
  "claim_status",
]);

export const failureAnalysisCompletionOrderSchema = z.enum(["pending_first", "completed_first"]);

export const failureAnalysisCandidateSchema = z.object({
  executionRunId: z.string().min(1),
  caseDefinitionId: z.string().min(1),
  attemptId: z.string().min(1),
  caseName: z.string().min(1),
  className: z.string().min(1),
  attemptNumber: z.number().int().positive(),
  failureSummary: z.string(),
  resultCode: z.string().optional(),
  claim: z
    .object({
      id: z.string().min(1),
      status: failureAnalysisStatusSchema,
      category: failureAnalysisCategorySchema.optional(),
      claimantId: z.string().min(1),
      claimantUsername: z.string().min(1),
      claimantDisplayName: z.string().min(1),
      claimedAt: z.string().datetime(),
      analysisStartedAt: z.string().datetime().optional(),
      completedAt: z.string().datetime().optional(),
      updatedAt: z.string().datetime(),
    })
    .optional(),
});

export const failureAnalysisCandidatePageSchema = z.object({
  items: z.array(failureAnalysisCandidateSchema),
  nextCursor: z.string().optional(),
});

export const failureAnalysisBatchSchema = z.object({
  id: z.string().min(1),
  sequenceNumber: z.number().int().positive(),
  suiteName: z.string().min(1),
  currentRound: z.number().int().positive(),
  failedRuns: z.number().int().nonnegative(),
  claimedRuns: z.number().int().nonnegative(),
  completedRuns: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});

export const failureAnalysisBatchPageSchema = z.object({
  items: z.array(failureAnalysisBatchSchema),
  nextCursor: z.string().optional(),
});

export const failureAnalysisClaimSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  batchId: z.string().min(1),
  executionRunId: z.string().min(1),
  caseDefinitionId: z.string().min(1),
  attemptId: z.string().min(1),
  caseName: z.string().min(1),
  className: z.string().min(1),
  attemptNumber: z.number().int().positive(),
  failureSummary: z.string(),
  resultCode: z.string().optional(),
  status: failureAnalysisStatusSchema,
  category: failureAnalysisCategorySchema.optional(),
  claimantId: z.string().min(1),
  claimantUsername: z.string().min(1),
  claimantDisplayName: z.string().min(1),
  claimedAt: z.string().datetime(),
  analysisStartedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  issueDescription: z.string().optional(),
  caseFixEvidence: z.string().optional(),
  ticketReference: z.string().optional(),
  remark: z.string().optional(),
  rerunProofAttemptId: z.string().optional(),
  rerunProofUrl: z.string().optional(),
  screenshot: failureAnalysisScreenshotSchema.optional(),
  updatedAt: z.string().datetime(),
});

export const failureAnalysisClaimPageSchema = z.object({
  items: z.array(failureAnalysisClaimSchema),
  nextCursor: z.string().optional(),
});

export const failureAnalysisCategoryCountsSchema = z.object({
  rerunPassed: z.number().int().nonnegative(),
  caseFixed: z.number().int().nonnegative(),
  codeIssueFiled: z.number().int().nonnegative(),
});

export const failureAnalysisStatisticsSummarySchema = z.object({
  claimed: z.number().int().nonnegative(),
  analyzing: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  categories: failureAnalysisCategoryCountsSchema,
});

export const failureAnalysisAnalystStatisticsSchema = z.object({
  claimantId: z.string().min(1),
  claimantUsername: z.string().min(1),
  claimantDisplayName: z.string().min(1),
  total: z.number().int().nonnegative(),
  claimed: z.number().int().nonnegative(),
  analyzing: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  categories: failureAnalysisCategoryCountsSchema,
  lastActivityAt: z.string().datetime(),
});

export const failureAnalysisStatisticsPageSchema = z.object({
  summary: failureAnalysisStatisticsSummarySchema,
  analysts: z.array(failureAnalysisAnalystStatisticsSchema),
  nextCursor: z.string().optional(),
  generatedAt: z.string().datetime(),
});

export const failureAnalysisHistoryItemSchema = z.object({
  claim: failureAnalysisClaimSchema,
  batchSequenceNumber: z.number().int().positive(),
  batchName: z.string().min(1),
});

export const failureAnalysisHistoryPageSchema = z.object({
  items: z.array(failureAnalysisHistoryItemSchema),
  nextCursor: z.string().optional(),
});

export const claimFailureAnalysisInputSchema = z.object({
  projectId: z.string().min(1),
  projectVersionId: z.string().min(1),
  batchId: z.string().min(1),
  executionRunIds: z.array(z.string().min(1)).min(1).max(100),
});

export const claimFailureAnalysisResultSchema = z.object({
  claimed: z.array(failureAnalysisClaimSchema),
  conflicts: z.array(
    z.object({
      executionRunId: z.string().min(1),
      claimantDisplayName: z.string().min(1),
    }),
  ),
});

export const releaseFailureAnalysisClaimInputSchema = z.object({
  projectId: z.string().min(1),
  reason: z.string().trim().min(1).max(1_000),
});

export const failureAnalysisClaimReleaseSchema = z.object({
  id: z.string().min(1),
  analysisId: z.string().min(1),
  projectId: z.string().min(1),
  batchId: z.string().min(1),
  executionRunId: z.string().min(1),
  caseDefinitionId: z.string().min(1),
  claimantId: z.string().min(1),
  claimantUsername: z.string().min(1),
  claimantDisplayName: z.string().min(1),
  reason: z.string().min(1).max(1_000),
  claimedAt: z.string().datetime(),
  releasedAt: z.string().datetime(),
});

export const startFailureAnalysisInputSchema = z.object({
  category: failureAnalysisCategorySchema,
});

export const completeFailureAnalysisInputSchema = z.object({
  projectId: z.string().min(1),
  analysisIds: z.array(z.string().min(1)).min(1).max(100),
  category: failureAnalysisCategorySchema,
  issueDescription: z.string().trim().max(4_000).optional(),
  caseFixEvidence: z.string().trim().max(4_000).optional(),
  ticketReference: z.string().trim().max(1_000).optional(),
  remark: z.string().trim().max(4_000).optional(),
  caseIssueConfirmed: z.boolean().default(false),
});

export const lookupFailureAnalysisRerunProofsInputSchema = z.object({
  projectId: z.string().min(1),
  analysisIds: z.array(z.string().min(1)).min(1).max(100),
});

export const failureAnalysisRerunProofLookupItemSchema = z.discriminatedUnion("status", [
  z.object({
    analysisId: z.string().min(1),
    status: z.literal("found"),
    attemptId: z.string().min(1),
    url: z.string().startsWith("/share/attempt-log/").max(2_048),
  }),
  z.object({
    analysisId: z.string().min(1),
    status: z.literal("missing"),
  }),
]);

export const failureAnalysisRerunProofLookupResultSchema = z.object({
  items: z.array(failureAnalysisRerunProofLookupItemSchema).min(1).max(100),
});

export const uploadFailureAnalysisEvidenceQuerySchema = z.object({
  projectId: z.string().min(1),
  analysisIds: z.array(z.string().min(1)).min(1).max(100),
  fileName: z.string().trim().min(1).max(240),
});

export type FailureAnalysisSort = z.infer<typeof failureAnalysisSortSchema>;
export type FailureAnalysisCompletionOrder = z.infer<typeof failureAnalysisCompletionOrderSchema>;
export type FailureAnalysisCandidate = z.infer<typeof failureAnalysisCandidateSchema>;
export type FailureAnalysisCandidatePage = z.infer<typeof failureAnalysisCandidatePageSchema>;
export type FailureAnalysisBatch = z.infer<typeof failureAnalysisBatchSchema>;
export type FailureAnalysisBatchPage = z.infer<typeof failureAnalysisBatchPageSchema>;
export type FailureAnalysisClaimView = z.infer<typeof failureAnalysisClaimSchema>;
export type FailureAnalysisClaimPageView = z.infer<typeof failureAnalysisClaimPageSchema>;
export type FailureAnalysisCategoryCounts = z.infer<typeof failureAnalysisCategoryCountsSchema>;
export type FailureAnalysisStatisticsSummary = z.infer<
  typeof failureAnalysisStatisticsSummarySchema
>;
export type FailureAnalysisAnalystStatistics = z.infer<
  typeof failureAnalysisAnalystStatisticsSchema
>;
export type FailureAnalysisStatisticsPage = z.infer<typeof failureAnalysisStatisticsPageSchema>;
export type FailureAnalysisHistoryItemView = z.infer<typeof failureAnalysisHistoryItemSchema>;
export type FailureAnalysisHistoryPageView = z.infer<typeof failureAnalysisHistoryPageSchema>;
export type ClaimFailureAnalysisResult = z.infer<typeof claimFailureAnalysisResultSchema>;
export type FailureAnalysisClaimReleaseView = z.infer<typeof failureAnalysisClaimReleaseSchema>;
export type FailureAnalysisRerunProofLookupItem = z.infer<
  typeof failureAnalysisRerunProofLookupItemSchema
>;
export type FailureAnalysisRerunProofLookupResult = z.infer<
  typeof failureAnalysisRerunProofLookupResultSchema
>;
