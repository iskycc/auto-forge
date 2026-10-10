import type { SharedAttemptLogView } from "@autoforge/contracts";

/** 日志公开访问页服务端渲染的日志上限：超出部分截断并在页面顶部明确提示。 */
export const SHARED_LOG_MAX_BYTES = 512 * 1024;

/**
 * 按 UTF-8 字节数截断日志，回退到完整字符边界。
 * 服务端与浏览器共用；stream 解码丢弃末尾不完整字符，不产生替换符号。
 */
export function truncateSharedLogText(logText: string): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(logText);
  if (encoded.byteLength <= SHARED_LOG_MAX_BYTES) {
    return { text: logText, truncated: false };
  }
  return {
    text: new TextDecoder().decode(encoded.subarray(0, SHARED_LOG_MAX_BYTES), { stream: true }),
    truncated: true,
  };
}

const OUTCOME_LABELS: Record<SharedAttemptLogView["outcome"], string> = {
  assigned: "等待执行",
  running: "执行中",
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
    assigned: "batch-status-queued",
    running: "batch-status-running",
    succeeded: "batch-status-succeeded",
    failed: "batch-status-failed",
    timed_out: "batch-status-queued",
    cancelled: "batch-status-neutral",
  };
  return classes[outcome];
}
