export type ExecutionTimeoutEvidence = {
  startedAt: string | null;
  detectedAt: string;
  timeoutMs: number;
  leaseRenewedAt: string | null;
  leaseExpiresAt: string | null;
  runnerLastSeenAt: string | null;
};

/** Describe the watchdog's evidence without claiming it knows the JVM's blocking point. */
export function describeExecutionTimeout(evidence: ExecutionTimeoutEvidence): string {
  const measured = evidence.startedAt
    ? Math.max(0, Date.parse(evidence.detectedAt) - Date.parse(evidence.startedAt)) / 1_000
    : null;
  const elapsed = measured !== null && Number.isFinite(measured) ? measured : null;
  return [
    "平台超时恢复：该尝试从领取开始计时，超过平台配置的执行期限。",
    `配置期限：${evidence.timeoutMs / 1_000} 秒；已计时：${elapsed === null ? "未记录" : elapsed.toFixed(1) + " 秒"}。`,
    `领取／开始：${evidence.startedAt ?? "未记录"}；判定时间：${evidence.detectedAt}（UTC）。`,
    `最近续租：${evidence.leaseRenewedAt ?? "未记录"}；租约期限：${evidence.leaseExpiresAt ?? "未记录"}。`,
    `节点最近心跳：${evidence.runnerLastSeenAt ?? "未记录"}。`,
    evidence.leaseExpiresAt && Date.parse(evidence.leaseExpiresAt) > Date.parse(evidence.detectedAt)
      ? "判定时租约时间尚未到期；本次由执行时限触发，并非租约失联判定。"
      : "请结合续租与心跳时间核对节点及平台通信状态。",
    "此计时不能证明 OOM 或业务阻塞原因；请打开超时诊断查看执行机的日志上传状态及超时前 JVM 线程快照。",
  ].join("\n");
}
