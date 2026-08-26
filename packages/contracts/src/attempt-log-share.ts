/**
 * 执行结果导出与日志公开访问的共享契约。
 *
 * 导出接口：GET /api/v1/run-batches/[batchId]/export
 *   ?scope=round|final        round=指定轮次的尝试；final=每个用例取最新一次尝试
 *   &round=<n>               scope=round 时必填（轮次号，1 为初始轮次）
 *   &outcomes=succeeded,failed,timed_out,cancelled,blocked
 * 响应：200 application/vnd.openxmlformats-officedocument.spreadsheetml.sheet 附件。
 *
 * 免登日志页：/share/attempt-log/[token]
 * token 在导出时由服务端生成并持久化（存 SHA-256 哈希），链接永久有效；token
 * 以签发 attempt 为锚点，可访问同一批次、同一用例的其他已完成轮次。
 */

/** 导出筛选项；blocked 表示仍被轮次持有/等待中、尚未执行的用例（无执行时间与日志）。 */
export type ExportOutcomeFilter = "succeeded" | "failed" | "timed_out" | "cancelled" | "blocked";

export const EXPORT_OUTCOME_FILTERS: readonly ExportOutcomeFilter[] = [
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "blocked",
];

export type SharedAttemptLogOutcome = "succeeded" | "failed" | "timed_out" | "cancelled";

/** 同一批次、同一用例的已完成轮次，用于公开日志页的安全导航。 */
export interface SharedAttemptLogRoundView {
  attemptId: string;
  attemptNumber: number;
  outcome: SharedAttemptLogOutcome;
  resultCode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

/** 导出/日志公开访问页共用的单行数据结构。 */
export interface SharedAttemptLogView {
  batchId: string;
  /** 批次自然递增展示编号，界面优先展示；batchId 仍是权威 UUID。 */
  batchSequenceNumber: number;
  attemptId: string;
  attemptNumber: number;
  /** 用例路径，如 com.example.CheckoutTest */
  casePath: string;
  /** 用例名称（方法级显示名） */
  displayName: string;
  outcome: SharedAttemptLogOutcome;
  resultCode: string | null;
  /** 完整失败描述（可包含多行与非 ASCII 文本），仅非成功时有值 */
  summary: string | null;
  /** ISO 8601；尚未开始的尝试为 null */
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** adapter 执行该用例的完整输出流日志（已脱敏） */
  logText: string;
  /** 按轮次升序排列，仅包含当前分享链接所授权用例的已完成尝试。 */
  rounds: SharedAttemptLogRoundView[];
  /**
   * 兼容字段：链接当前永久有效，新记录固定为永久哨兵值（9999-12-31），
   * 旧版记录的有限过期时间仍按原值比较。保留字段以免破坏既有消费者。
   */
  expiresAt: string;
}

/** 导出请求被校验失败时的稳定错误码。 */
export type ExportErrorCode =
  "BATCH_NOT_FOUND" | "INVALID_SCOPE" | "INVALID_ROUND" | "INVALID_OUTCOMES";
