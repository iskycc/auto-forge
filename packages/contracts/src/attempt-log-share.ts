/**
 * 执行结果导出与日志公开访问的共享契约。
 *
 * 导出接口：GET /api/v1/run-batches/[batchId]/export
 *   ?template=results|failure-analysis
 *   &scope=round|final|all    round=指定轮次；final=每个用例最新尝试；all=所有轮次
 *   &round=<n>               scope=round 时必填（轮次号，1 为初始轮次）
 *   &outcomes=succeeded,failed,timed_out,cancelled,blocked
 * 响应：200 application/vnd.openxmlformats-officedocument.spreadsheetml.sheet 附件。
 *
 * 免登日志页：/share/attempt-log/[token]
 * token 在导出时由服务端生成并持久化（存 SHA-256 哈希），链接永久有效；token
 * 以签发 attempt 为锚点，可访问同一批次、同一用例的其他轮次和手动诊断重跑。
 */

/** 导出筛选项；blocked 表示 Adapter 未正常完成的超时、取消或基础设施异常。 */
export type ExportOutcomeFilter = "succeeded" | "failed" | "timed_out" | "cancelled" | "blocked";

export const EXPORT_OUTCOME_FILTERS: readonly ExportOutcomeFilter[] = [
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "blocked",
];

export const RUN_BATCH_EXPORT_TEMPLATES = ["results", "failure-analysis"] as const;
export type RunBatchExportTemplate = (typeof RUN_BATCH_EXPORT_TEMPLATES)[number];
export const FAILURE_ANALYSIS_EXPORT_OUTCOMES = [
  "failed",
  "blocked",
] as const satisfies readonly ExportOutcomeFilter[];

export type SharedAttemptLogOutcome =
  "assigned" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled";

/** 同一批次、同一用例的轮次和手动重跑，用于公开日志页的安全导航。 */
export interface SharedAttemptLogRoundView {
  attemptId: string;
  /** 物理尝试序号；Runner 基础设施重调度会递增。 */
  attemptNumber: number;
  /** 用户可见逻辑轮次；Runner 基础设施重调度不会递增。 */
  executionRound: number;
  outcome: SharedAttemptLogOutcome;
  resultCode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  kind?: "round" | "manual_rerun";
  requestedBy?: { username: string; source: "local" | "ldap" } | null;
}

/** 导出/日志公开访问页共用的单行数据结构。 */
export interface SharedAttemptLogView {
  batchId: string;
  /** 批次自然递增展示编号，界面优先展示；batchId 仍是权威 UUID。 */
  batchSequenceNumber: number;
  attemptId: string;
  /** 物理尝试序号；用于区分同一逻辑轮次内的 Runner 重调度。 */
  attemptNumber: number;
  /** 用户可见逻辑轮次。 */
  executionRound: number;
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
  kind?: "round" | "manual_rerun";
  requestedBy?: { username: string; source: "local" | "ldap" } | null;
  /** adapter 执行该用例的输出流日志；公开页最多读取前 512 KiB。 */
  logText: string;
  /** 日志仍有后续内容未载入时为 true，避免先全量读入内存再由页面截断。 */
  logTruncated?: boolean;
  /** 按执行时间排列，仅包含当前分享链接所授权用例的轮次与诊断重跑。 */
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
