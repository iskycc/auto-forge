export type RunnerState = "online" | "offline" | "draining" | "disabled";

export type RunnerResourceSnapshot = {
  cpuUtilizationPercent: number;
  memoryUtilizationPercent: number;
  loadAverage1m: number;
  logicalCpuCount: number;
  observedAt: string;
};

export type Runner = {
  id: string;
  name: string;
  state: RunnerState;
  os: string;
  architecture: string;
  agentVersion: string;
  protocolVersion: number;
  labels: string[];
  capabilities: string[];
  maxConcurrency: number;
  busySlots: number;
  lastSeenAt: string;
  resourceSnapshot?: RunnerResourceSnapshot;
  terminalEnabled: boolean;
  credentialVersion: number;
  credentialRevokedAt?: string;
  credentialRotationRequestedAt?: string;
  deregisteredAt?: string;
  // purgedAt 是注销后的墓碑标记：记录从列表隐藏，凭据材料已被清除，执行历史保留。
  purgedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type RunnerAuthenticationBlock = "deregistered" | "credential-revoked" | "disabled";

/**
 * 判断执行机是否还能通过凭据认证。注销与凭据撤销优先于禁用状态报告，
 * 因为它们代表身份失效而非临时生命周期状态。
 */
export function runnerAuthenticationBlock(runner: Runner): RunnerAuthenticationBlock | null {
  // 已清除的执行机视同已注销：身份材料不复存在，任何情况下都不能再认证。
  if (runner.purgedAt) return "deregistered";
  if (runner.deregisteredAt) return "deregistered";
  if (runner.credentialRevokedAt) return "credential-revoked";
  if (runner.state === "disabled") return "disabled";
  return null;
}
