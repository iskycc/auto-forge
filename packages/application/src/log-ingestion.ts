import type { LogIngestionPayload } from "@autoforge/contracts";

/** Only logs already authorized by the control plane enter this transport. */
export interface LogIngestionPort {
  persist(input: LogIngestionPayload): Promise<{ stdout: number; stderr: number; agent: number }>;
}
