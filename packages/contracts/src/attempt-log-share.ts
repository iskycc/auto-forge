/**
 * 执行结果导出与免登录日志分享的共享契约。
 *
 * 导出接口：GET /api/v1/run-batches/[batchId]/export
 *   ?scope=round|final        round=指定轮次的尝试；final=每个用例取最新一次尝试
 *   &round=<n>               scope=round 时必填（轮次号，1 为初始轮次）
 *   &outcomes=succeeded,failed,timed_out,cancelled,blocked
 * 响应：200 application/vnd.openxmlformats-officedocument.spreadsheetml.sheet 附件。
 *
 * 免登录日志页：/share/attempt-log/[token]
 * token 在导出时由服务端生成并持久化（存 SHA-256 哈希），默认 30 天有效。
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

/** 导出/分享页共用的单行数据结构。 */
export interface SharedAttemptLogView {
  batchId: string;
  attemptId: string;
  attemptNumber: number;
  /** 用例路径，如 com.example.CheckoutTest */
  casePath: string;
  /** 用例名称（方法级显示名） */
  displayName: string;
  outcome: "succeeded" | "failed" | "timed_out" | "cancelled";
  resultCode: string | null;
  /** 失败精简描述（一行堆栈），仅非成功时有值 */
  summary: string | null;
  /** ISO 8601；尚未开始的尝试为 null */
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** adapter 执行该用例的完整输出流日志（已脱敏） */
  logText: string;
  /** 分享链接过期时间（ISO 8601） */
  expiresAt: string;
}

/** 导出请求被校验失败时的稳定错误码。 */
export type ExportErrorCode =
  "BATCH_NOT_FOUND" | "INVALID_SCOPE" | "INVALID_ROUND" | "INVALID_OUTCOMES";
