import type { SharedAttemptLogView } from "@autoforge/contracts";

/** 日志公开访问页服务端渲染的日志上限：超出部分截断并在页面顶部明确提示。 */
export const SHARED_LOG_MAX_BYTES = 512 * 1024;

/**
 * 按 UTF-8 字节数截断日志，回退到完整字符边界。
 * Buffer.toString 会把截断处的残缺字节渲染为 U+FFFD，截断后统一剥掉结尾替换字符。
 */
export function truncateSharedLogText(logText: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(logText, "utf8") <= SHARED_LOG_MAX_BYTES) {
    return { text: logText, truncated: false };
  }
  let text = Buffer.from(logText, "utf8").subarray(0, SHARED_LOG_MAX_BYTES).toString("utf8");
  while (text.endsWith("\uFFFD")) text = text.slice(0, -1);
  return { text, truncated: true };
}

const OUTCOME_LABELS: Record<SharedAttemptLogView["outcome"], string> = {
  succeeded: "通过",
  failed: "失败",
  timed_out: "超时",
  cancelled: "已取消",
};

export function sharedOutcomeLabel(outcome: SharedAttemptLogView["outcome"]): string {
  return OUTCOME_LABELS[outcome];
}

// 复用轮次表的结果徽章配色：成功/失败/超时/取消分别对应语义色 token。
export function sharedOutcomeClass(outcome: SharedAttemptLogView["outcome"]): string {
  const classes: Record<SharedAttemptLogView["outcome"], string> = {
    succeeded: "batch-status-succeeded",
    failed: "batch-status-failed",
    timed_out: "batch-status-queued",
    cancelled: "batch-status-neutral",
  };
  return classes[outcome];
}
