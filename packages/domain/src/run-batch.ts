export type RunBatchStatus =
  "queued" | "dispatching" | "scheduled" | "running" | "succeeded" | "failed" | "cancelled";

export type ExecutionRunStatus =
  "queued" | "assigned" | "running" | "succeeded" | "failed" | "cancelled";

export type RunAttemptStatus =
  "assigned" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled";

export type ExecutionEnvironmentVariable = {
  name: string;
  value: string;
};

export type RunBatch = {
  id: string;
  suiteId: string;
  suiteName: string;
  suiteVersion: number;
  status: RunBatchStatus;
  retryLimit: number;
  environmentVariables: ExecutionEnvironmentVariable[];
  selectedRunnerIds: string[];
  totalRuns: number;
  queuedRuns: number;
  assignedRuns: number;
  runningRuns: number;
  succeededRuns: number;
  failedRuns: number;
  timedOutRuns: number;
  cancelledRuns: number;
  createdAt: string;
  updatedAt: string;
};

export type ExecutionRun = {
  id: string;
  batchId: string;
  caseDefinitionId: string;
  caseVersion: number;
  displayName: string;
  className: string;
  status: ExecutionRunStatus;
  assignedRunnerId?: string;
  attemptCount: number;
  schedulingScore?: number;
  terminalOutcome?: "succeeded" | "failed" | "timed_out" | "cancelled";
  cancelRequestedAt?: string;
  version: number;
  createdAt: string;
  assignedAt?: string;
  updatedAt: string;
};

export type RunAttempt = {
  id: string;
  executionRunId: string;
  runnerId: string;
  attemptNumber: number;
  status: RunAttemptStatus;
  schedulingScore: number;
  version: number;
  startedAt?: string;
  finishedAt?: string;
  outcome?: "succeeded" | "failed" | "timed_out" | "cancelled";
  resultCode?: string;
  resultSummary?: string;
  createdAt: string;
};

export type RunBatchDetails = RunBatch & {
  runs: ExecutionRun[];
  attempts: RunAttempt[];
};

export function statusAfterFailedAttempt(
  attemptNumber: number,
  retryLimit: number,
): "queued" | "failed" {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error("attemptNumber must be a positive integer.");
  }
  if (!Number.isInteger(retryLimit) || retryLimit < 0) {
    throw new Error("retryLimit must be a non-negative integer.");
  }
  return attemptNumber <= retryLimit ? "queued" : "failed";
}
