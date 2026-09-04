import type {
  FailureAnalysisCandidate,
  FailureAnalysisCompletionOrder,
  FailureAnalysisSort,
  FailureAnalysisStatisticsPage,
} from "@autoforge/contracts";
import type { FailureAnalysisClaim } from "@autoforge/domain";

// 分析列表只承载失败概要；完整执行输出从弹窗日志/公开日志按需读取。限制单项概要可避免
// 极端异常堆栈把 50 行分页响应膨胀到数十 MiB，同时仍保留足够的根因上下文。
export const FAILURE_ANALYSIS_SUMMARY_MAXIMUM_CHARACTERS = 8_192;

export type FailureAnalysisStatisticsCountRow = {
  total: number | string | null;
  claimed: number | string | null;
  analyzing: number | string | null;
  completed: number | string | null;
  rerunPassed: number | string | null;
  caseFixed: number | string | null;
  codeIssueFiled: number | string | null;
};

export type FailureAnalysisAnalystRow = FailureAnalysisStatisticsCountRow & {
  claimantId: string;
  claimantUsername: string;
  claimantDisplayName: string;
  lastActivityAt: string;
};

export function statisticsPage(
  summaryRow: FailureAnalysisStatisticsCountRow,
  rows: readonly FailureAnalysisAnalystRow[],
  limit: number,
  generatedAt: string,
): FailureAnalysisStatisticsPage {
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    summary: statisticsCounts(summaryRow),
    analysts: pageRows.map((row) => ({
      claimantId: row.claimantId,
      claimantUsername: row.claimantUsername,
      claimantDisplayName: row.claimantDisplayName,
      ...statisticsCounts(row),
      lastActivityAt: row.lastActivityAt,
    })),
    ...(hasMore && last
      ? {
          nextCursor: Buffer.from(
            JSON.stringify({ createdAt: last.lastActivityAt, id: last.claimantId }),
            "utf8",
          ).toString("base64url"),
        }
      : {}),
    generatedAt,
  };
}

export function emptyStatisticsRow(): FailureAnalysisStatisticsCountRow {
  return {
    total: 0,
    claimed: 0,
    analyzing: 0,
    completed: 0,
    rerunPassed: 0,
    caseFixed: 0,
    codeIssueFiled: 0,
  };
}

function statisticsCounts(row: FailureAnalysisStatisticsCountRow) {
  return {
    total: Number(row.total ?? 0),
    claimed: Number(row.claimed ?? 0),
    analyzing: Number(row.analyzing ?? 0),
    completed: Number(row.completed ?? 0),
    categories: {
      rerunPassed: Number(row.rerunPassed ?? 0),
      caseFixed: Number(row.caseFixed ?? 0),
      codeIssueFiled: Number(row.codeIssueFiled ?? 0),
    },
  };
}

export type FailureAnalysisRow = {
  analysisId: string | null;
  projectId: string;
  batchId: string;
  executionRunId: string;
  caseDefinitionId: string;
  attemptId: string;
  caseName: string;
  className: string;
  attemptNumber: number;
  failureSummary: string;
  resultCode: string | null;
  analysisStatus: "claimed" | "analyzing" | "completed" | null;
  category: "rerun_passed" | "case_fixed" | "code_issue_filed" | null;
  claimantId: string | null;
  claimantUsername: string | null;
  claimantDisplayName: string | null;
  claimedAt: string | null;
  analysisStartedAt: string | null;
  completedAt: string | null;
  issueDescription: string | null;
  caseFixEvidence: string | null;
  ticketReference: string | null;
  remark: string | null;
  rerunProofAttemptId: string | null;
  rerunProofUrl: string | null;
  screenshotObjectKey: string | null;
  screenshotFileName: string | null;
  screenshotMediaType: "image/png" | "image/jpeg" | "image/webp" | null;
  screenshotSizeBytes: number | null;
  screenshotSha256: string | null;
  analysisUpdatedAt: string | null;
  claimRank?: number | string;
  sortValue?: string;
  completionRank?: number | string;
};

export function toFailureAnalysisCandidate(row: FailureAnalysisRow): FailureAnalysisCandidate {
  return {
    executionRunId: row.executionRunId,
    caseDefinitionId: row.caseDefinitionId,
    attemptId: row.attemptId,
    caseName: row.caseName,
    className: row.className,
    attemptNumber: row.attemptNumber,
    failureSummary: row.failureSummary,
    ...(row.resultCode ? { resultCode: row.resultCode } : {}),
    ...(hasCompleteClaim(row)
      ? {
          claim: {
            id: row.analysisId,
            status: row.analysisStatus,
            ...(row.category ? { category: row.category } : {}),
            claimantId: row.claimantId,
            claimantUsername: row.claimantUsername,
            claimantDisplayName: row.claimantDisplayName,
            claimedAt: row.claimedAt,
            ...(row.analysisStartedAt ? { analysisStartedAt: row.analysisStartedAt } : {}),
            ...(row.completedAt ? { completedAt: row.completedAt } : {}),
            updatedAt: row.analysisUpdatedAt,
          },
        }
      : {}),
  };
}

export function toFailureAnalysisClaim(row: FailureAnalysisRow): FailureAnalysisClaim {
  if (!hasCompleteClaim(row)) throw new Error("Failure analysis claim row is incomplete.");
  return {
    id: row.analysisId,
    projectId: row.projectId,
    batchId: row.batchId,
    executionRunId: row.executionRunId,
    caseDefinitionId: row.caseDefinitionId,
    attemptId: row.attemptId,
    caseName: row.caseName,
    className: row.className,
    attemptNumber: row.attemptNumber,
    failureSummary: row.failureSummary,
    ...(row.resultCode ? { resultCode: row.resultCode } : {}),
    status: row.analysisStatus,
    ...(row.category ? { category: row.category } : {}),
    claimantId: row.claimantId,
    claimantUsername: row.claimantUsername,
    claimantDisplayName: row.claimantDisplayName,
    claimedAt: row.claimedAt,
    ...(row.analysisStartedAt ? { analysisStartedAt: row.analysisStartedAt } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.issueDescription ? { issueDescription: row.issueDescription } : {}),
    ...(row.caseFixEvidence ? { caseFixEvidence: row.caseFixEvidence } : {}),
    ...(row.ticketReference ? { ticketReference: row.ticketReference } : {}),
    ...(row.remark ? { remark: row.remark } : {}),
    ...(row.rerunProofAttemptId ? { rerunProofAttemptId: row.rerunProofAttemptId } : {}),
    ...(row.rerunProofUrl ? { rerunProofUrl: row.rerunProofUrl } : {}),
    ...(hasCompleteScreenshot(row)
      ? {
          screenshot: {
            objectKey: row.screenshotObjectKey,
            fileName: row.screenshotFileName,
            mediaType: row.screenshotMediaType,
            sizeBytes: row.screenshotSizeBytes,
            sha256: row.screenshotSha256,
          },
        }
      : {}),
    updatedAt: row.analysisUpdatedAt,
  };
}

type CandidateCursor = {
  sort: FailureAnalysisSort;
  direction: "asc" | "desc";
  claimRank: number;
  value: string;
  executionRunId: string;
};

type ClaimCursor = {
  sort: FailureAnalysisSort;
  direction: "asc" | "desc";
  completionOrder: FailureAnalysisCompletionOrder;
  completionRank: number;
  includeCompleted: boolean;
  value: string;
  analysisId: string;
};

export function encodeFailureAnalysisCandidateCursor(cursor: CandidateCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeFailureAnalysisCandidateCursor(
  encoded: string | undefined,
  sort: FailureAnalysisSort,
  direction: "asc" | "desc",
): CandidateCursor | undefined {
  if (!encoded || encoded.length > 1_024) return undefined;
  try {
    const value = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<CandidateCursor>;
    if (
      value.sort !== sort ||
      value.direction !== direction ||
      (value.claimRank !== 0 && value.claimRank !== 1) ||
      typeof value.value !== "string" ||
      value.value.length > 512 ||
      typeof value.executionRunId !== "string" ||
      value.executionRunId.length > 128
    ) {
      return undefined;
    }
    return value as CandidateCursor;
  } catch {
    return undefined;
  }
}

export function encodeFailureAnalysisClaimCursor(cursor: ClaimCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeFailureAnalysisClaimCursor(
  encoded: string | undefined,
  sort: FailureAnalysisSort,
  direction: "asc" | "desc",
  completionOrder: FailureAnalysisCompletionOrder,
  includeCompleted: boolean,
): ClaimCursor | undefined {
  if (!encoded || encoded.length > 1_024) return undefined;
  try {
    const value = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<ClaimCursor>;
    if (
      value.sort !== sort ||
      value.direction !== direction ||
      value.completionOrder !== completionOrder ||
      (value.completionRank !== 0 && value.completionRank !== 1) ||
      value.includeCompleted !== includeCompleted ||
      typeof value.value !== "string" ||
      value.value.length > 512 ||
      typeof value.analysisId !== "string" ||
      value.analysisId.length > 128
    ) {
      return undefined;
    }
    return value as ClaimCursor;
  } catch {
    return undefined;
  }
}

function hasCompleteClaim(row: FailureAnalysisRow): row is FailureAnalysisRow & {
  analysisId: string;
  analysisStatus: "claimed" | "analyzing" | "completed";
  claimantId: string;
  claimantUsername: string;
  claimantDisplayName: string;
  claimedAt: string;
  analysisUpdatedAt: string;
} {
  return Boolean(
    row.analysisId &&
    row.analysisStatus &&
    row.claimantId &&
    row.claimantUsername &&
    row.claimantDisplayName &&
    row.claimedAt &&
    row.analysisUpdatedAt,
  );
}

function hasCompleteScreenshot(row: FailureAnalysisRow): row is FailureAnalysisRow & {
  screenshotObjectKey: string;
  screenshotFileName: string;
  screenshotMediaType: "image/png" | "image/jpeg" | "image/webp";
  screenshotSizeBytes: number;
  screenshotSha256: string;
} {
  return Boolean(
    row.screenshotObjectKey &&
    row.screenshotFileName &&
    row.screenshotMediaType &&
    row.screenshotSizeBytes &&
    row.screenshotSha256,
  );
}
