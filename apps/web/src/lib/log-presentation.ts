const FAILURE_SUMMARY_CONTROL_PREFIX = "TestCase Run Failed Stack Base64: [";
const COMPLETE_FAILURE_SUMMARY_CONTROL_RECORD = new RegExp(
  `^${escapeForRegularExpression(FAILURE_SUMMARY_CONTROL_PREFIX)}[A-Za-z0-9+/=]*\\](?:\\r?\\n|$)`,
  "gm",
);
const INCOMPLETE_FAILURE_SUMMARY_CONTROL_RECORD = new RegExp(
  `^${escapeForRegularExpression(FAILURE_SUMMARY_CONTROL_PREFIX)}[A-Za-z0-9+/=]*$`,
  "gm",
);

/**
 * Adapter 控制记录用于服务端可靠提取失败摘要，属于协议元数据而非用例输出。
 * 原始日志仍保存在权威日志仓储中；这里只在用户可见视图隐藏完整记录，以及
 * 实时日志刚好按块切在记录中间时位于文本末尾的半条记录。
 */
export function visibleAttemptLogText(logText: string): string {
  return logText
    .replace(COMPLETE_FAILURE_SUMMARY_CONTROL_RECORD, "")
    .replace(INCOMPLETE_FAILURE_SUMMARY_CONTROL_RECORD, "");
}

function escapeForRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
