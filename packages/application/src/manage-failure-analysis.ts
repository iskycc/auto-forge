import { createHash } from "node:crypto";

import { failureAnalysisSortSchema, type FailureAnalysisSort } from "@autoforge/contracts";
import {
  DomainError,
  failureAnalysisCategories,
  type FailureAnalysisCategory,
  type FailureAnalysisClaim,
} from "@autoforge/domain";

import type { AttemptLogShareService } from "./attempt-log-shares";
import type { Clock, FailureAnalysisRepository, IdGenerator, JarObjectStorePort } from "./ports";

const MAXIMUM_PAGE_SIZE = 100;
const MAXIMUM_CLAIM_SIZE = 100;
export const FAILURE_ANALYSIS_SCREENSHOT_MAXIMUM_BYTES = 10 * 1024 * 1024;
const SCREENSHOT_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
type ScreenshotMediaType = (typeof SCREENSHOT_MEDIA_TYPES)[number];

export class FailureAnalysisService {
  constructor(
    private readonly repository: FailureAnalysisRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly objectStore?: Pick<JarObjectStorePort, "putObject" | "read" | "delete">,
    private readonly attemptLogShares?: Pick<AttemptLogShareService, "ensureSharesForAttempts">,
  ) {}

  listBatches(input: {
    projectId: string;
    projectVersionId?: string;
    cursor?: string;
    limit?: number;
  }) {
    return this.repository.listBatches({
      ...input,
      limit: boundedPageSize(input.limit),
    });
  }

  getBatch(input: { projectId: string; projectVersionId: string; batchId: string }) {
    return this.repository.getBatch(input);
  }

  listCandidates(input: {
    projectId: string;
    projectVersionId: string;
    batchId: string;
    query?: string;
    sort?: FailureAnalysisSort;
    direction?: "asc" | "desc";
    cursor?: string;
    limit?: number;
  }) {
    return this.repository.listCandidates({
      ...input,
      sort: failureAnalysisSortSchema.parse(input.sort ?? "class_path"),
      direction: input.direction ?? "asc",
      limit: boundedPageSize(input.limit),
    });
  }

  async claim(input: {
    projectId: string;
    projectVersionId: string;
    batchId: string;
    executionRunIds: readonly string[];
    claimant: { id: string; username: string; displayName: string };
  }) {
    const executionRunIds = [...new Set(input.executionRunIds)];
    if (executionRunIds.length === 0 || executionRunIds.length > MAXIMUM_CLAIM_SIZE) {
      throw new DomainError(
        "FAILURE_ANALYSIS_CLAIM_SIZE_INVALID",
        `每次需要认领 1-${MAXIMUM_CLAIM_SIZE} 个失败用例。`,
      );
    }
    const claimedAt = this.clock.now().toISOString();
    const result = await this.repository.claim({
      projectId: input.projectId,
      projectVersionId: input.projectVersionId,
      batchId: input.batchId,
      executionRunIds,
      claims: executionRunIds.map((executionRunId) => ({
        id: this.ids.next(),
        executionRunId,
      })),
      claimantId: input.claimant.id,
      claimantUsername: input.claimant.username,
      claimantDisplayName: input.claimant.displayName,
      claimedAt,
    });
    const claimsByRunId = new Map(result.claims.map((claim) => [claim.executionRunId, claim]));
    return {
      claimed: result.claims.filter((claim) => claim.claimantId === input.claimant.id),
      conflicts: result.unavailableExecutionRunIds.map((executionRunId) => ({
        executionRunId,
        claimantDisplayName: claimsByRunId.get(executionRunId)?.claimantDisplayName ?? "其他用户",
      })),
    };
  }

  listMyClaims(input: {
    projectId: string;
    projectVersionId?: string;
    claimantId: string;
    batchId?: string;
    sort?: FailureAnalysisSort;
    direction?: "asc" | "desc";
    cursor?: string;
    limit?: number;
  }) {
    return this.repository.listClaims({
      ...input,
      sort: failureAnalysisSortSchema.parse(input.sort ?? "class_path"),
      direction: input.direction ?? "asc",
      limit: boundedPageSize(input.limit),
    });
  }

  countMyClaims(input: {
    projectId: string;
    projectVersionId?: string;
    claimantId: string;
    batchId?: string;
  }) {
    return this.repository.countClaims(input);
  }

  async releaseClaim(input: {
    analysisId: string;
    projectId: string;
    claimantId: string;
    reason: string;
  }) {
    const reason = optionalTrimmed(input.reason);
    if (!reason || reason.length > 1_000) {
      throw new DomainError(
        "FAILURE_ANALYSIS_RELEASE_REASON_REQUIRED",
        "请填写取消认领原因，最多 1000 个字符。",
      );
    }
    const released = await this.repository.release({
      id: this.ids.next(),
      analysisId: input.analysisId,
      projectId: input.projectId,
      claimantId: input.claimantId,
      reason,
      releasedAt: this.clock.now().toISOString(),
    });
    if (!released) {
      throw new DomainError(
        "FAILURE_ANALYSIS_RELEASE_NOT_ALLOWED",
        "分析任务不存在、不是由当前账号认领，或已经完成，无法取消认领。",
      );
    }
    return released;
  }

  async listExportClaims(input: {
    projectId: string;
    batchId: string;
    executionRunIds: readonly string[];
  }): Promise<FailureAnalysisClaim[]> {
    return this.repository.findClaimsByExecutionRunIds({
      projectId: input.projectId,
      batchId: input.batchId,
      executionRunIds: [...new Set(input.executionRunIds)],
    });
  }

  listCaseHistory(input: {
    projectId: string;
    caseDefinitionId: string;
    cursor?: string;
    limit?: number;
  }) {
    return this.repository.listCaseHistory({
      ...input,
      limit: boundedPageSize(input.limit),
    });
  }

  listRecentCaseHistories(input: {
    projectId: string;
    caseDefinitionIds: readonly string[];
    limitPerCase?: number;
  }) {
    const caseDefinitionIds = [...new Set(input.caseDefinitionIds)];
    if (caseDefinitionIds.length === 0 || caseDefinitionIds.length > MAXIMUM_CLAIM_SIZE) {
      throw new DomainError(
        "FAILURE_ANALYSIS_HISTORY_SELECTION_INVALID",
        `每次需要查询 1-${MAXIMUM_CLAIM_SIZE} 个用例的分析历史。`,
      );
    }
    return this.repository.listRecentCaseHistories({
      projectId: input.projectId,
      caseDefinitionIds,
      limitPerCase: Math.min(10, Math.max(1, Math.trunc(input.limitPerCase ?? 5))),
    });
  }

  async start(input: {
    analysisId: string;
    projectId: string;
    claimantId: string;
    category: FailureAnalysisCategory;
  }) {
    if (!failureAnalysisCategories.includes(input.category)) {
      throw new DomainError("FAILURE_ANALYSIS_CATEGORY_INVALID", "请选择有效的失败类别。");
    }
    const claim = await this.repository.start({
      ...input,
      category: input.category,
      startedAt: this.clock.now().toISOString(),
    });
    if (!claim) {
      throw new DomainError(
        "FAILURE_ANALYSIS_NOT_FOUND",
        "分析任务不存在、已由其他用户认领，或当前账号无权操作。",
      );
    }
    return claim;
  }

  async uploadScreenshot(input: {
    analysisIds: readonly string[];
    projectId: string;
    claimantId: string;
    fileName: string;
    mediaType: string;
    content: Uint8Array;
  }): Promise<FailureAnalysisClaim[]> {
    if (!this.objectStore) {
      throw new DomainError(
        "FAILURE_ANALYSIS_EVIDENCE_UNAVAILABLE",
        "当前运行时无法保存分析证明。",
      );
    }
    const analysisIds = boundedAnalysisIds(input.analysisIds);
    const claims = await this.requireOwnedClaims(analysisIds, input.projectId, input.claimantId);
    const mediaType = screenshotMediaType(input.mediaType);
    if (
      input.content.byteLength === 0 ||
      input.content.byteLength > FAILURE_ANALYSIS_SCREENSHOT_MAXIMUM_BYTES
    ) {
      throw new DomainError(
        "FAILURE_ANALYSIS_SCREENSHOT_SIZE_INVALID",
        `截图大小必须在 1 字节到 ${FAILURE_ANALYSIS_SCREENSHOT_MAXIMUM_BYTES} 字节之间。`,
      );
    }
    ensureScreenshotSignature(input.content, mediaType);
    const sha256 = createHash("sha256").update(input.content).digest("hex");
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[mediaType];
    const evidenceId = this.ids.next();
    const objectKey = `projects/${input.projectId}/failure-analysis/${claims[0]!.batchId}/${evidenceId}-${sha256.slice(0, 16)}.${extension}`;
    await this.objectStore.putObject({
      objectKey,
      sha256,
      sizeBytes: input.content.byteLength,
      mediaType,
      content: oneChunk(input.content),
    });
    try {
      return await this.repository.attachScreenshot({
        analysisIds,
        projectId: input.projectId,
        claimantId: input.claimantId,
        screenshot: {
          objectKey,
          fileName: safeScreenshotFileName(input.fileName, extension),
          mediaType,
          sizeBytes: input.content.byteLength,
          sha256,
        },
        updatedAt: this.clock.now().toISOString(),
      });
    } catch (persistenceError) {
      try {
        await this.objectStore.delete(objectKey);
      } catch (cleanupError) {
        throw new AggregateError(
          [persistenceError, cleanupError],
          "保存分析证明元数据失败，且无法清理已上传对象。",
        );
      }
      throw persistenceError;
    }
  }

  async readScreenshot(analysisId: string, projectId: string) {
    if (!this.objectStore) return null;
    const claim = await this.repository.getClaim(analysisId, projectId);
    if (!claim?.screenshot) return null;
    const content = await this.objectStore.read(claim.screenshot.objectKey);
    const digest = createHash("sha256").update(content).digest("hex");
    if (content.byteLength !== claim.screenshot.sizeBytes || digest !== claim.screenshot.sha256) {
      throw new DomainError(
        "FAILURE_ANALYSIS_EVIDENCE_CORRUPT",
        "分析证明截图大小或摘要校验失败。",
      );
    }
    return { ...claim.screenshot, content };
  }

  async complete(input: {
    analysisIds: readonly string[];
    projectId: string;
    claimant: { id: string; username: string };
    category: FailureAnalysisCategory;
    issueDescription?: string;
    caseFixEvidence?: string;
    ticketReference?: string;
    remark?: string;
    caseIssueConfirmed: boolean;
  }): Promise<FailureAnalysisClaim[]> {
    const analysisIds = boundedAnalysisIds(input.analysisIds);
    const claims = await this.requireOwnedClaims(analysisIds, input.projectId, input.claimant.id);
    const issueDescription = optionalTrimmed(input.issueDescription);
    const caseFixEvidence = optionalTrimmed(input.caseFixEvidence);
    const ticketReference = optionalTrimmed(input.ticketReference);
    const remark = optionalTrimmed(input.remark);
    validateCompletionFields({
      category: input.category,
      caseIssueConfirmed: input.caseIssueConfirmed,
      ...(issueDescription ? { issueDescription } : {}),
      ...(caseFixEvidence ? { caseFixEvidence } : {}),
      ...(ticketReference ? { ticketReference } : {}),
    });
    const successfulAttempts =
      input.category === "rerun_passed"
        ? await this.repository.findSuccessfulManualRerunAttempts({
            analysisIds,
            projectId: input.projectId,
            claimantId: input.claimant.id,
          })
        : new Map<string, string>();
    const rerunProofs = new Map<string, { attemptId: string; url: string }>();
    if (input.category === "rerun_passed") {
      if (!this.attemptLogShares) {
        throw new DomainError(
          "FAILURE_ANALYSIS_LOG_SHARE_UNAVAILABLE",
          "当前无法生成重跑日志证明。",
        );
      }
      for (const claim of claims) {
        const attemptId = successfulAttempts.get(claim.id);
        if (!attemptId && !claim.screenshot) {
          throw new DomainError(
            "FAILURE_ANALYSIS_RERUN_PROOF_REQUIRED",
            `“${claim.caseName}”未检测到公开日志页重跑通过记录，请粘贴执行通过截图。`,
          );
        }
      }
      const tokensByAttempt = await this.attemptLogShares.ensureSharesForAttempts(
        [...new Set(successfulAttempts.values())],
        input.claimant.id,
      );
      for (const claim of claims) {
        const attemptId = successfulAttempts.get(claim.id);
        if (!attemptId) continue;
        const token = tokensByAttempt.get(attemptId);
        if (!token) {
          throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "重跑通过日志不存在或已被删除。");
        }
        rerunProofs.set(claim.id, {
          attemptId,
          url: `/share/attempt-log/${token}`,
        });
      }
    }
    return this.repository.complete({
      analysisIds,
      projectId: input.projectId,
      claimantId: input.claimant.id,
      category: input.category,
      ...(issueDescription ? { issueDescription } : {}),
      ...(caseFixEvidence ? { caseFixEvidence } : {}),
      ...(ticketReference ? { ticketReference } : {}),
      ...(remark ? { remark } : {}),
      rerunProofs,
      completedAt: this.clock.now().toISOString(),
    });
  }

  private async requireOwnedClaims(
    analysisIds: readonly string[],
    projectId: string,
    claimantId: string,
  ): Promise<FailureAnalysisClaim[]> {
    const claims = await this.repository.findOwnedClaims({ analysisIds, projectId, claimantId });
    if (claims.length !== analysisIds.length) {
      throw new DomainError(
        "FAILURE_ANALYSIS_NOT_FOUND",
        "部分分析任务不存在、已由其他用户认领，或当前账号无权操作。",
      );
    }
    return claims;
  }
}

function boundedPageSize(limit = 50): number {
  return Math.min(MAXIMUM_PAGE_SIZE, Math.max(1, Math.trunc(limit)));
}

function boundedAnalysisIds(values: readonly string[]): string[] {
  const ids = [...new Set(values)];
  if (ids.length === 0 || ids.length > MAXIMUM_CLAIM_SIZE) {
    throw new DomainError(
      "FAILURE_ANALYSIS_SELECTION_INVALID",
      `每次需要选择 1-${MAXIMUM_CLAIM_SIZE} 个分析任务。`,
    );
  }
  return ids;
}

function screenshotMediaType(value: string): ScreenshotMediaType {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  if (!SCREENSHOT_MEDIA_TYPES.some((candidate) => candidate === mediaType)) {
    throw new DomainError(
      "FAILURE_ANALYSIS_SCREENSHOT_TYPE_INVALID",
      "截图只支持 PNG、JPEG 或 WebP。",
    );
  }
  return mediaType as ScreenshotMediaType;
}

function ensureScreenshotSignature(content: Uint8Array, mediaType: ScreenshotMediaType): void {
  const valid =
    mediaType === "image/png"
      ? content.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => content[i] === v)
      : mediaType === "image/jpeg"
        ? content.length >= 3 && content[0] === 255 && content[1] === 216 && content[2] === 255
        : content.length >= 12 &&
          new TextDecoder().decode(content.subarray(0, 4)) === "RIFF" &&
          new TextDecoder().decode(content.subarray(8, 12)) === "WEBP";
  if (!valid) {
    throw new DomainError(
      "FAILURE_ANALYSIS_SCREENSHOT_CONTENT_INVALID",
      "截图内容与声明的图片格式不一致。",
    );
  }
}

function safeScreenshotFileName(fileName: string, extension: string): string {
  const base = fileName
    .replace(/[\\/\u0000-\u001f]/gu, "_")
    .trim()
    .slice(0, 220);
  return base || `rerun-proof.${extension}`;
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function validateCompletionFields(input: {
  category: FailureAnalysisCategory;
  issueDescription?: string;
  caseFixEvidence?: string;
  ticketReference?: string;
  caseIssueConfirmed: boolean;
}): void {
  if (input.category === "case_fixed") {
    if (!input.issueDescription || !input.caseFixEvidence) {
      throw new DomainError(
        "FAILURE_ANALYSIS_CASE_FIELDS_REQUIRED",
        "用例问题已修改必须填写用例问题说明和用例已修改证明。",
      );
    }
    if (!input.caseIssueConfirmed) {
      throw new DomainError(
        "FAILURE_ANALYSIS_CASE_CONFIRMATION_REQUIRED",
        "请确认问题确实由用例引起后再提交。",
      );
    }
  }
  if (
    input.category === "code_issue_filed" &&
    (!input.issueDescription || !input.ticketReference)
  ) {
    throw new DomainError(
      "FAILURE_ANALYSIS_CODE_FIELDS_REQUIRED",
      "代码问题已提单必须填写问题说明和问题单链接或问题单号。",
    );
  }
}

async function* oneChunk(content: Uint8Array): AsyncGenerator<Uint8Array> {
  yield content;
}
