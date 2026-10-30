import type { Runner } from "@autoforge/domain";
import type { RunBatchMetadata } from "./ports";

/** Metadata and aggregates only. Never transfer case bodies, credentials or execution specs. */
export type ConcurrencySnapshot = {
  batch: Pick<
    RunBatchMetadata,
    | "id"
    | "projectId"
    | "status"
    | "scheduledFor"
    | "terminationRequestedAt"
    | "pauseRequestedAt"
    | "policy"
  >;
  targetConcurrency: number | null;
  runningRuns: number;
  assignedRuns: number;
  readyRuns: number;
  heldRuns: number;
  recoveryPending: boolean;
  projectActiveRuns: number;
  requiredCapabilities: string[];
  omittedNodes: number;
  nodes: Array<{ runner: Runner; reservedSlots: number; batchReservedSlots: number }>;
};
