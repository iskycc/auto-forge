import type { SharedAttemptLogView } from "@autoforge/contracts";
import { DomainError, runAttemptOutcome } from "@autoforge/domain";

import type {
  AttemptLogShareRepository,
  Clock,
  ExecutionControlRepository,
  IdGenerator,
  RunBatchRepository,
} from "./ports";

/**
 * 分享链接有效期固定 30 天：离线部署没有外部吊销通道，链接一旦泄露只能等待过期收敛暴露面，
 * 30 天在审计可追溯与导出结果的可用性之间取平衡。
 */
export const ATTEMPT_LOG_SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

/** 读取完整日志时的单页大小；日志内容在写入侧已脱敏，这里原样拼接，截断由展示层负责。 */
const LOG_PAGE_LIMIT = 500;

export type AttemptLogShareTokenPort = {
  /** 生成 32 字节随机数的 base64url 字符串作为链接 token。 */
  issue(): string;
  /** SHA-256 hex；库中只存哈希，明文不出现在持久层。 */
  hash(value: string): string;
};

export class AttemptLogShareService {
  constructor(
    private readonly shares: AttemptLogShareRepository,
    private readonly batches: RunBatchRepository,
    private readonly executions: ExecutionControlRepository,
    private readonly tokens: AttemptLogShareTokenPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /**
   * 免登读取分享日志。token 无效、过期、批次或 attempt 已删除时统一返回 null，
   * 不向外区分失败原因。分享页无会话，不能再按项目裁剪权限。
   */
  async getSharedAttemptLog(token: string): Promise<SharedAttemptLogView | null> {
    const now = this.clock.now().toISOString();
    const share = await this.shares.findActiveByTokenHash(this.tokens.hash(token), now);
    if (!share) return null;
    const batch = await this.batches.get(share.batchId);
    const attempt = batch?.attempts.find((candidate) => candidate.id === share.attemptId);
    if (!batch || !attempt) return null;
    const outcome = runAttemptOutcome(attempt);
    if (!outcome) return null;
    const run = batch.runs.find((candidate) => candidate.id === attempt.executionRunId);
    return {
      batchId: batch.id,
      attemptId: attempt.id,
      attemptNumber: attempt.attemptNumber,
      casePath: run?.className ?? "",
      displayName: run?.displayName ?? "",
      outcome,
      resultCode: attempt.resultCode ?? null,
      summary: outcome === "succeeded" ? null : (attempt.resultSummary ?? null),
      startedAt: attempt.startedAt ?? null,
      finishedAt: attempt.finishedAt ?? null,
      durationMs: attempt.durationMs ?? null,
      logText: await this.readAttemptLogText(share.attemptId),
      expiresAt: share.expiresAt,
    };
  }

  /**
   * 为一组 attempt 准备分享链接，返回 attemptId 到明文 token 的映射。
   * token 只存哈希、无法还原，因此已存在有效分享时不能复用旧链接；新分享沿用该 attempt
   * 现有有效分享的过期时间，避免反复导出无限延长暴露窗口。同一调用内重复的 attemptId
   * 复用同一条分享。
   */
  async ensureSharesForAttempts(
    attemptIds: readonly string[],
    createdBy: string,
  ): Promise<Map<string, string>> {
    const now = this.clock.now();
    const tokensByAttempt = new Map<string, string>();
    for (const attemptId of attemptIds) {
      if (tokensByAttempt.has(attemptId)) continue;
      const context = await this.executions.resolveAttemptSchedulingContext(attemptId);
      if (!context) {
        throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "指定的执行尝试不存在。");
      }
      const existing = await this.shares.findActiveByAttemptId(attemptId, now.toISOString());
      const token = this.tokens.issue();
      await this.shares.create({
        id: this.ids.next(),
        tokenHash: this.tokens.hash(token),
        attemptId,
        batchId: context.batchId,
        createdBy,
        createdAt: now.toISOString(),
        expiresAt:
          existing?.expiresAt ?? new Date(now.getTime() + ATTEMPT_LOG_SHARE_TTL_MS).toISOString(),
      });
      tokensByAttempt.set(attemptId, token);
    }
    return tokensByAttempt;
  }

  /** 复用执行控制仓储的分页读取，合并 stdout/stderr 为完整日志文本。 */
  private async readAttemptLogText(attemptId: string): Promise<string> {
    const chunks: Array<{ stream: string; sequence: number; content: string; recordedAt: string }> =
      [];
    for (const stream of ["stdout", "stderr"] as const) {
      let afterSequence = -1;
      for (;;) {
        const page = await this.executions.listLogChunks({
          attemptId,
          stream,
          afterSequence,
          limit: LOG_PAGE_LIMIT,
        });
        chunks.push(...page.items);
        if (page.nextSequence === undefined) break;
        afterSequence = page.nextSequence;
      }
    }
    chunks.sort((left, right) => {
      const byTime = left.recordedAt.localeCompare(right.recordedAt);
      if (byTime !== 0) return byTime;
      const byStream = left.stream.localeCompare(right.stream);
      if (byStream !== 0) return byStream;
      return left.sequence - right.sequence;
    });
    return chunks.map((chunk) => chunk.content).join("");
  }
}
