export type RunnerState = "online" | "offline" | "disabled";

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
  terminalEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};
