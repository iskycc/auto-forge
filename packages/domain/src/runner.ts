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
  createdAt: string;
  updatedAt: string;
};

export type RunnerAuthenticationBlock = "deregistered" | "credential-revoked" | "disabled";

/**
 * 判断执行机是否还能通过凭据认证。注销与凭据撤销优先于禁用状态报告，
 * 因为它们代表身份失效而非临时生命周期状态。
 */
export function runnerAuthenticationBlock(runner: Runner): RunnerAuthenticationBlock | null {
  if (runner.deregisteredAt) return "deregistered";
  if (runner.credentialRevokedAt) return "credential-revoked";
  if (runner.state === "disabled") return "disabled";
  return null;
}
