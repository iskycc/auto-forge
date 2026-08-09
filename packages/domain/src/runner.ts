export type RunnerState = "online" | "offline" | "disabled";

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
  maxConcurrency: number;
  busySlots: number;
  lastSeenAt: string;
  resourceSnapshot?: RunnerResourceSnapshot;
  terminalEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};
