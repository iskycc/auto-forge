import type { SharedAttemptLogOutcome, SharedAttemptLogView } from "@autoforge/contracts";
import { runAttemptOutcome, type RunAttempt } from "@autoforge/domain";

import type {
  AttemptLogShareRepository,
  Clock,
  ExecutionControlRepository,
  RunBatchRepository,
} from "./ports";

/**
 * 日志公开访问链接永久有效：离线部署没有外部吊销通道，链接一旦泄露只能靠删除对应
 * attempt/批次收敛暴露面，因此签发时即视为永久。expires_at 列为 NOT NULL 且仓储统一
 * 按 `expires_at > now` 判定有效性，故用一个远期哨兵时间表达“永久”，不改表结构。
 */
export const PERMANENT_LOG_ACCESS_EXPIRY = "9999-12-31T23:59:59.999Z";

/** 小页读取并在应用层提前停止，避免单个公开页把超大日志完整载入进程内存。 */
// The store retains its byte budget; larger row windows reduce repeated DB/worker round trips
// for small chunks. Remote owners may return their smaller protocol window with a cursor.
const LOG_PAGE_LIMIT = 128;
const SHARED_LOG_MAX_BYTES = 512 * 1024;

export type AttemptLogShareTokenPort = {
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
   * 已授权公开批次或日志入口复用有界读取与同用例历史边界。anchorAttemptId 必须
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
    const anchorBatch = await this.batches.getMetadata(anchorBatchId);
    if (!anchorBatch) return null;
    const rootBatchId =
      anchorBatch.kind === "case_log_rerun" ? anchorBatch.parentBatchId : anchorBatch.id;
    const rootExecutionRunId =
      anchorBatch.kind === "case_log_rerun"
        ? anchorBatch.sourceExecutionRunId
        : anchorContext.executionRunId;
    if (!rootBatchId || !rootExecutionRunId) return null;
    const rootSnapshot = await this.batches.getAttemptLogSnapshot(rootBatchId, rootExecutionRunId);
    if (!rootSnapshot) return null;
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
        batchId: rootBatchId,
        kind: "round" as const,
        requestedBy: null,
      })),
      ...diagnosticBatches.flatMap((diagnosticBatch) =>
        diagnosticBatch.attempts.map((attempt) => ({
          attempt,
          batchId: diagnosticBatch.id,
          kind: "manual_rerun" as const,
          requestedBy: diagnosticBatch.requestedBy ?? null,
        })),
      ),
    ];
    const visibleAttempts: Array<{
      attempt: RunAttempt;
      batchId: string;
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
    const selectedSnapshot =
      selected.batchId === rootBatchId
        ? rootSnapshot
        : await this.batches.getAttemptLogSnapshot(selected.batchId, attempt.executionRunId);
    if (!selectedSnapshot) return null;
    const log = await this.readAttemptLogText(attempt.id);
    return {
      batchId: rootSnapshot.batchId,
      batchSequenceNumber: rootSnapshot.batchSequenceNumber,
      attemptId: attempt.id,
      attemptNumber: attempt.attemptNumber,
      executionRound: attempt.executionRound ?? attempt.attemptNumber,
      casePath: selectedSnapshot.className,
      displayName: selectedSnapshot.displayName,
      caseType: selectedSnapshot.caseType,
      dependencyUpdatedAt: selectedSnapshot.dependencyUpdatedAt,
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
          executionRound: candidate.executionRound ?? candidate.attemptNumber,
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
