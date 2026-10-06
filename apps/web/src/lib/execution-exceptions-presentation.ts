const reasonLabels: Readonly<Record<string, string>> = {
  QUEUE_TIMEOUT: "排队超时",
  EXECUTION_TIMEOUT: "执行超时",
  ASSIGNMENT_CLAIM_TIMEOUT: "领取超时",
  UPLOAD_TIMEOUT: "上传超时",
  LEASE_EXPIRED: "租约过期",
  PROCESS_START_FAILED: "进程启动失败",
  JENKINS_ROUND_RECOVERY_FAILED: "轮次恢复失败",
  UNKNOWN_RESULT: "缺少原因记录",
};

export function executionExceptionReasonLabel(resultCode: string): string {
  return reasonLabels[resultCode] ?? "执行异常";
}
