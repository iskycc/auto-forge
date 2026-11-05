import {
  failureAnalysisSheetPageSchema,
  publicFailureAnalysisPath,
  type CompleteFailureAnalysisSheetInput,
  type FailureAnalysisSheetQuery,
} from "@autoforge/contracts";
import { DomainError, type FailureAnalysisClaim } from "@autoforge/domain";
import type { Clock, FailureAnalysisRepository } from "./ports";
import type { FailureAnalysisService } from "./manage-failure-analysis";

export type FailureAnalysisSheetScope = {
  batchId: string;
  projectId: string;
  projectVersionId: string;
  suiteName: string;
  sequenceNumber: number;
  archivedAt?: string;
  publisher?: { id: string; username: string; publishedAt: string };
};

export interface FailureAnalysisPublicationRepository {
  batch(batchId: string): Promise<FailureAnalysisSheetScope | null>;
  read(batchId: string): Promise<FailureAnalysisSheetScope | null>;
  publish(batchId: string, publisherId: string, publishedAt: string): Promise<void>;
  revoke(batchId: string, revokedAt: string): Promise<void>;
  failureAttempt(batchId: string, executionRunId: string): Promise<string | null>;
}

export class FailureAnalysisPublicationService {
  constructor(
    private readonly repository: FailureAnalysisPublicationRepository,
    private readonly clock: Clock,
  ) {}

  async requireBatch(batchId: string) {
    const scope = await this.repository.batch(batchId);
    if (!scope) throw new DomainError("FAILURE_ANALYSIS_NOT_FOUND", "分析任务不存在或已关闭。");
    return scope;
  }
  async requirePublic(batchId: string) {
    const scope = await this.repository.read(batchId);
    if (!scope)
      throw new DomainError(
        "FAILURE_ANALYSIS_PUBLIC_NOT_FOUND",
        "公开分析链接未启用、已撤销，或分享人已停用。",
      );
    return scope;
  }
  async publish(batchId: string, publisherId: string) {
    await this.requireBatch(batchId);
    await this.repository.publish(batchId, publisherId, this.clock.now().toISOString());
    return publicFailureAnalysisPath(batchId);
  }
  revoke(batchId: string) {
    return this.repository.revoke(batchId, this.clock.now().toISOString());
  }
  async link(batchId: string) {
    return (await this.repository.read(batchId)) ? publicFailureAnalysisPath(batchId) : null;
  }
  async requireFailureAttempt(scope: FailureAnalysisSheetScope, executionRunId: string) {
    const attemptId = await this.repository.failureAttempt(scope.batchId, executionRunId);
    if (!attemptId)
      throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "该用例不在本次分析的失败范围内。");
    return attemptId;
  }
}

/** The sheet is a bounded projection and editor of the existing human-analysis workflow. */
export class FailureAnalysisSheetService {
  constructor(
    private readonly analysis: Pick<
      FailureAnalysisService,
      "listCandidates" | "listMyClaims" | "listExportClaims" | "complete"
    >,
    private readonly repository: Pick<FailureAnalysisRepository, "findOwnedClaims" | "getClaim">,
  ) {}

  async read(
    scope: FailureAnalysisSheetScope,
    query: FailureAnalysisSheetQuery,
    claimantId?: string,
  ) {
    const pageScope = {
      projectId: scope.projectId,
      projectVersionId: scope.projectVersionId,
      batchId: scope.batchId,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      ...(query.query ? { query: query.query } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    };
    if (query.view === "mine") {
      if (!claimantId) throw new DomainError("AUTH_REQUIRED", "请登录后查看自己认领的用例。");
      const page = await this.analysis.listMyClaims({
        ...pageScope,
        claimantId,
        includeCompleted: true,
      });
      return failureAnalysisSheetPageSchema.parse({
        ...page,
        items: page.items.map((claim) => ({ ...claim, analysis: claim })),
      });
    }
    const page = await this.analysis.listCandidates(pageScope);
    if (!page) throw new DomainError("FAILURE_ANALYSIS_NOT_FOUND", "分析任务不存在或已关闭。");
    const claims = await this.analysis.listExportClaims({
      projectId: scope.projectId,
      batchId: scope.batchId,
      executionRunIds: page.items.map((item) => item.executionRunId),
    });
    const byRun = new Map(claims.map((claim) => [claim.executionRunId, claim]));
    return failureAnalysisSheetPageSchema.parse({
      ...page,
      items: page.items.map((row) => ({ ...row, analysis: byRun.get(row.executionRunId) })),
    });
  }

  async requireClaim(scope: FailureAnalysisSheetScope, analysisId: string) {
    const claim = await this.repository.getClaim(analysisId, scope.projectId);
    if (!claim || claim.batchId !== scope.batchId)
      throw new DomainError("FAILURE_ANALYSIS_NOT_FOUND", "分析记录不属于此链接的任务。");
    return claim;
  }

  async requireOwned(
    scope: FailureAnalysisSheetScope,
    analysisIds: readonly string[],
    claimantId: string,
  ) {
    if (!analysisIds.length || analysisIds.length > 100)
      throw new DomainError("FAILURE_ANALYSIS_SELECTION_INVALID", "请选择 1–100 个分析记录。");
    const ids = [...new Set(analysisIds)];
    const claims = await this.repository.findOwnedClaims({
      projectId: scope.projectId,
      analysisIds: ids,
      claimantId,
    });
    if (claims.length !== ids.length || claims.some((claim) => claim.batchId !== scope.batchId))
      throw new DomainError(
        "FAILURE_ANALYSIS_NOT_FOUND",
        "部分记录不属于当前任务，或不是由当前用户认领。",
      );
    return claims;
  }

  async complete(
    scope: FailureAnalysisSheetScope,
    input: CompleteFailureAnalysisSheetInput,
    claimant: { id: string; username: string },
  ) {
    this.requireWritable(scope);
    const claims = await this.requireOwned(scope, input.analysisIds, claimant.id);
    // An acknowledgement lost on the network can be safely retried without changing completed conclusions.
    if (claims.every((claim) => sameCompletedConclusion(claim, input))) return claims;
    if (
      input.expectedUpdatedAt &&
      claims.some((claim) => claim.updatedAt !== input.expectedUpdatedAt)
    )
      throw new DomainError(
        "FAILURE_ANALYSIS_EDIT_CONFLICT",
        "记录已更新，请刷新核对后重新提交；当前草稿仍保留。",
      );
    return this.analysis.complete({
      projectId: scope.projectId,
      claimant,
      analysisIds: input.analysisIds,
      category: input.category,
      caseIssueConfirmed: input.caseIssueConfirmed,
      ...(input.issueDescription ? { issueDescription: input.issueDescription } : {}),
      ...(input.caseFixEvidence ? { caseFixEvidence: input.caseFixEvidence } : {}),
      ...(input.ticketReference ? { ticketReference: input.ticketReference } : {}),
      ...(input.remark ? { remark: input.remark } : {}),
    });
  }

  requireWritable(scope: FailureAnalysisSheetScope) {
    if (scope.archivedAt)
      throw new DomainError("FAILURE_ANALYSIS_ARCHIVED_CONFLICT", "分析任务已归档，只能查看。");
  }
}

function sameCompletedConclusion(
  claim: FailureAnalysisClaim,
  input: CompleteFailureAnalysisSheetInput,
) {
  return (
    claim.status === "completed" &&
    claim.category === input.category &&
    (["issueDescription", "caseFixEvidence", "ticketReference", "remark"] as const).every(
      (field) => (claim[field] ?? "") === (input[field]?.trim() ?? ""),
    )
  );
}
