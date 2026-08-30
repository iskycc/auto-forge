import type { SharedAttemptLogOutcome, SharedAttemptLogView } from "@autoforge/contracts";
import { DomainError, runAttemptOutcome, type RunAttempt } from "@autoforge/domain";

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

/** 小页读取并在应用层提前停止，避免单个公开页把超大日志完整载入进程内存。 */
const LOG_PAGE_LIMIT = 16;
const SHARED_LOG_MAX_BYTES = 512 * 1024;

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
   * ExecutionRun 的轮次及其手动诊断重跑之间切换；进行中的手动重跑也会进入历史，
   * 以便已登录用户从日志详情直接打开实时日志。目标 attempt 不满足该边界时
   * 统一返回 null。
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
    return this.getAttemptLogInBatch(
      share.batchId,
      share.attemptId,
      selectedAttemptId,
      share.expiresAt,
    );
  }

  /**
   * 永久批次分享页复用其 HMAC 授权读取该批次中的用例日志。anchorAttemptId 必须
   * 直接属于已分享批次；selectedAttemptId 只能在同一 ExecutionRun 的轮次/诊断
   * 重跑家族内切换，避免通过猜测 attemptId 越过批次边界。
   */
  async getSharedAttemptLogForBatch(
    batchId: string,
    anchorAttemptId: string,
    selectedAttemptId?: string,
  ): Promise<SharedAttemptLogView | null> {
    return this.getAttemptLogInBatch(
      batchId,
      anchorAttemptId,
      selectedAttemptId,
      PERMANENT_LOG_ACCESS_EXPIRY,
    );
  }

  private async getAttemptLogInBatch(
    anchorBatchId: string,
    anchorAttemptId: string,
    selectedAttemptId: string | undefined,
    expiresAt: string,
  ): Promise<SharedAttemptLogView | null> {
    const anchorContext = await this.executions.resolveAttemptSchedulingContext(anchorAttemptId);
    if (!anchorContext || anchorContext.batchId !== anchorBatchId) return null;
    const anchorBatch = await this.batches.getSummary(anchorBatchId);
    if (!anchorBatch) return null;
    const rootBatchId =
      anchorBatch.kind === "case_log_rerun" ? anchorBatch.parentBatchId : anchorBatch.id;
    const rootExecutionRunId =
      anchorBatch.kind === "case_log_rerun"
        ? anchorBatch.sourceExecutionRunId
        : anchorContext.executionRunId;
    if (!rootBatchId || !rootExecutionRunId) return null;
    const rootSnapshot = await this.batches.getRerunSnapshot(rootBatchId, {
      executionRunId: rootExecutionRunId,
    });
    if (!rootSnapshot) return null;
    const batch = rootSnapshot.batch;
    const run = rootSnapshot.runs.find((candidate) => candidate.id === rootExecutionRunId);
    if (!run) return null;
    // 生产 Lite/Full 仓储只查当前 ExecutionRun 的 attempts。兼容回退仅供仍使用旧
    // fake 的调用方，不能成为生产大批次的默认路径。
    const roundAttempts = this.batches.listAttemptsForExecutionRun
      ? await this.batches.listAttemptsForExecutionRun(rootExecutionRunId)
      : ((await this.batches.get(rootBatchId))?.attempts.filter(
          (candidate) => candidate.executionRunId === rootExecutionRunId,
        ) ?? []);
    const diagnosticBatches = await this.batches.listCaseLogRerunBatches(
      rootBatchId,
      rootExecutionRunId,
      500,
    );
    const familyAttempts = [
      ...roundAttempts.map((attempt) => ({
        attempt,
        kind: "round" as const,
        requestedBy: null,
      })),
      ...diagnosticBatches.flatMap((diagnosticBatch) =>
        diagnosticBatch.attempts.map((attempt) => ({
          attempt,
          kind: "manual_rerun" as const,
          requestedBy: diagnosticBatch.requestedBy ?? null,
        })),
      ),
    ];
    const visibleAttempts: Array<{
      attempt: RunAttempt;
      outcome: SharedAttemptLogOutcome;
      kind: "round" | "manual_rerun";
      requestedBy: { username: string; source: "local" | "ldap" } | null;
    }> = familyAttempts
      .flatMap((candidate) => {
        const outcome =
          runAttemptOutcome(candidate.attempt) ??
          (["assigned", "running"] as const).find((status) => status === candidate.attempt.status);
        return outcome ? [{ ...candidate, outcome }] : [];
      })
      .sort((left, right) => {
        const byTime = left.attempt.createdAt.localeCompare(right.attempt.createdAt);
        return byTime || left.attempt.id.localeCompare(right.attempt.id);
      });
    const selected = visibleAttempts.find(
      ({ attempt }) => attempt.id === (selectedAttemptId ?? anchorAttemptId),
    );
    if (!selected) return null;
    const { attempt, outcome, kind, requestedBy } = selected;
    const log = await this.readAttemptLogText(attempt.id);
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
      kind,
      requestedBy,
      logText: log.text,
      ...(log.truncated ? { logTruncated: true } : {}),
      rounds: visibleAttempts.map(
        ({ attempt: candidate, outcome: candidateOutcome, kind: candidateKind, requestedBy }) => ({
          attemptId: candidate.id,
          attemptNumber: candidate.attemptNumber,
          outcome: candidateOutcome,
          resultCode: candidate.resultCode ?? null,
          startedAt: candidate.startedAt ?? null,
          finishedAt: candidate.finishedAt ?? null,
          durationMs: candidate.durationMs ?? null,
          kind: candidateKind,
          requestedBy,
        }),
      ),
      expiresAt,
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

  /** 复用执行控制仓储的分页读取；每条流有界读取，合并后再按 UTF-8 边界截断。 */
  private async readAttemptLogText(
    attemptId: string,
  ): Promise<{ text: string; truncated: boolean }> {
    const chunks: Array<{ stream: string; sequence: number; content: string; recordedAt: string }> =
      [];
    let truncated = false;
    for (const stream of ["stdout", "stderr"] as const) {
      let afterSequence = -1;
      let streamBytes = 0;
      for (;;) {
        const page = await this.executions.listLogChunks({
          attemptId,
          stream,
          afterSequence,
          limit: LOG_PAGE_LIMIT,
        });
        chunks.push(...page.items);
        streamBytes += page.items.reduce(
          (total, chunk) => total + utf8ByteLength(chunk.content),
          0,
        );
        if (page.nextSequence === undefined) {
          truncated ||= page.truncated;
          break;
        }
        if (streamBytes >= SHARED_LOG_MAX_BYTES) {
          truncated = true;
          break;
        }
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
    const joined = chunks.map((chunk) => chunk.content).join("");
    const bounded = truncateUtf8(joined, SHARED_LOG_MAX_BYTES);
    return { text: bounded.text, truncated: truncated || bounded.truncated };
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maximumBytes: number): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maximumBytes) return { text: value, truncated: false };
  return {
    // stream=true 会保留并丢弃末尾不完整的多字节字符，不产生误导性的 U+FFFD。
    text: new TextDecoder("utf-8", { fatal: false }).decode(encoded.subarray(0, maximumBytes), {
      stream: true,
    }),
    truncated: true,
  };
}
