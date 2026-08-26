import type { SharedAttemptLogView } from "@autoforge/contracts";
import { DomainError, runAttemptOutcome } from "@autoforge/domain";

import type {
  AttemptLogShareRecord,
  AttemptLogShareRepository,
  Clock,
  ExecutionControlRepository,
  IdGenerator,
  RunBatchRepository,
} from "./ports";

/**
 * 日志公开访问链接永久有效：离线部署没有外部吊销通道，链接一旦泄露只能靠删除对应
 * attempt/批次收敛暴露面，因此签发时即视为永久。expires_at 列为 NOT NULL 且仓储统一
 * 按 `expires_at > now` 判定有效性，故用一个远期哨兵时间表达“永久”，不改表结构。
 */
export const PERMANENT_LOG_ACCESS_EXPIRY = "9999-12-31T23:59:59.999Z";

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
   * 免登读取公开日志。token 以签发时的 attempt 为授权锚点，可在同一批次、同一
   * ExecutionRun 的已完成轮次之间切换；目标 attempt 不满足该边界时统一返回 null。
   * token 无效、失效（旧记录过期或批次/attempt 已删除）时也返回 null，不向外
   * 区分失败原因。公开页无会话，不能再按项目裁剪权限。
   */
  async getSharedAttemptLog(
    token: string,
    selectedAttemptId?: string,
  ): Promise<SharedAttemptLogView | null> {
    const now = this.clock.now().toISOString();
    const share = await this.shares.findActiveByTokenHash(this.tokens.hash(token), now);
    if (!share) return null;
    const batch = await this.batches.get(share.batchId);
    const sharedAttempt = batch?.attempts.find((candidate) => candidate.id === share.attemptId);
    if (!batch || !sharedAttempt) return null;
    const run = batch.runs.find((candidate) => candidate.id === sharedAttempt.executionRunId);
    if (!run) return null;
    const completedAttempts = batch.attempts
      .filter((candidate) => candidate.executionRunId === run.id)
      .map((candidate) => ({ attempt: candidate, outcome: runAttemptOutcome(candidate) }))
      .filter(
        (
          candidate,
        ): candidate is {
          attempt: (typeof batch.attempts)[number];
          outcome: NonNullable<ReturnType<typeof runAttemptOutcome>>;
        } => candidate.outcome !== undefined,
      )
      .sort((left, right) => {
        const byRound = left.attempt.attemptNumber - right.attempt.attemptNumber;
        return byRound || left.attempt.createdAt.localeCompare(right.attempt.createdAt);
      });
    const selected = completedAttempts.find(
      ({ attempt }) => attempt.id === (selectedAttemptId ?? share.attemptId),
    );
    if (!selected) return null;
    const { attempt, outcome } = selected;
    return {
      batchId: batch.id,
      batchSequenceNumber: batch.sequenceNumber,
      attemptId: attempt.id,
      attemptNumber: attempt.attemptNumber,
      casePath: run.className,
      displayName: run.displayName,
      outcome,
      resultCode: attempt.resultCode ?? null,
      summary: outcome === "succeeded" ? null : (attempt.resultSummary ?? null),
      startedAt: attempt.startedAt ?? null,
      finishedAt: attempt.finishedAt ?? null,
      durationMs: attempt.durationMs ?? null,
      logText: await this.readAttemptLogText(attempt.id),
      rounds: completedAttempts.map(({ attempt: candidate, outcome: candidateOutcome }) => ({
        attemptId: candidate.id,
        attemptNumber: candidate.attemptNumber,
        outcome: candidateOutcome,
        resultCode: candidate.resultCode ?? null,
        startedAt: candidate.startedAt ?? null,
        finishedAt: candidate.finishedAt ?? null,
        durationMs: candidate.durationMs ?? null,
      })),
      expiresAt: share.expiresAt,
    };
  }

  /**
   * 为一组 attempt 准备日志公开访问链接，返回 attemptId 到明文 token 的映射。
   * token 只存哈希、无法还原，因此已存在有效链接时不能复用旧链接；新链接沿用该 attempt
   * 现有有效链接的过期时间（当前均为永久哨兵值），保持同一 attempt 的链接有效期一致。
   * 同一调用内重复的 attemptId 复用同一条记录。
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
        expiresAt: existing?.expiresAt ?? PERMANENT_LOG_ACCESS_EXPIRY,
      });
      tokensByAttempt.set(attemptId, token);
    }
    return tokensByAttempt;
  }

  /**
   * 为单个 attempt 创建日志公开访问链接并返回明文 token；projectIds 为调用方的日志读取范围，
   * attempt 不在范围内按不存在处理，与日志读取接口的越权语义保持一致。
   */
  async ensureShareForAttempt(
    attemptId: string,
    createdBy: string,
    projectIds?: readonly string[],
  ): Promise<string> {
    if (projectIds) {
      const projectId = await this.executions.resolveAttemptProjectId(attemptId);
      if (!projectId || !projectIds.includes(projectId)) {
        throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "指定的执行尝试不存在。");
      }
    }
    const tokens = await this.ensureSharesForAttempts([attemptId], createdBy);
    const token = tokens.get(attemptId);
    if (!token) throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "指定的执行尝试不存在。");
    return token;
  }

  /**
   * 为同一批次的全部 attempt 批量准备日志公开访问链接，返回 attemptId 到明文 token 的映射。
   * 与逐条版语义一致（token 只存哈希、已有有效链接沿用过期时间），但把 3N 次串行
   * 查询收敛为分批存在性校验、分批查有效链接与单事务批量写入，供 5 万行级导出使用；
   * 详情页的单个链接仍走 ensureSharesForAttempts。
   */
  async ensureSharesForAttemptsInBatch(
    attemptIds: readonly string[],
    batchId: string,
    createdBy: string,
  ): Promise<Map<string, string>> {
    const uniqueAttemptIds = [...new Set(attemptIds)];
    if (uniqueAttemptIds.length === 0) return new Map();
    const now = this.clock.now();
    const existingCount = await this.executions.countExistingAttemptIds(uniqueAttemptIds);
    if (existingCount !== uniqueAttemptIds.length) {
      throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "指定的执行尝试不存在。");
    }
    const activeShares = await this.shares.findActiveByAttemptIds(
      uniqueAttemptIds,
      now.toISOString(),
    );
    const activeExpiryByAttempt = new Map(
      activeShares.map((share) => [share.attemptId, share.expiresAt]),
    );
    const tokensByAttempt = new Map<string, string>();
    const newShares: AttemptLogShareRecord[] = [];
    for (const attemptId of uniqueAttemptIds) {
      const token = this.tokens.issue();
      tokensByAttempt.set(attemptId, token);
      newShares.push({
        id: this.ids.next(),
        tokenHash: this.tokens.hash(token),
        attemptId,
        batchId,
        createdBy,
        createdAt: now.toISOString(),
        expiresAt: activeExpiryByAttempt.get(attemptId) ?? PERMANENT_LOG_ACCESS_EXPIRY,
      });
    }
    await this.shares.createMany(newShares);
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
