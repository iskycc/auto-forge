import type {
  ExecutionEnvironmentSecretBinding,
  ExecutionEnvironmentVariable,
} from "./environment";

export type RunBatchStatus =
  "queued" | "dispatching" | "scheduled" | "running" | "succeeded" | "failed" | "cancelled";

export type ExecutionRunStatus =
  "queued" | "assigned" | "running" | "succeeded" | "failed" | "cancelled";

export type RunAttemptStatus =
  "assigned" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled";

export type TestNgResultCounts = {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  configurationFailures: number;
};

export type TestNgMethodResult = {
  name: string;
  signature?: string | undefined;
  status: "passed" | "failed" | "skipped";
  configuration: boolean;
  durationMs: number;
};

export type TestNgClassResult = TestNgResultCounts & {
  name: string;
  durationMs: number;
  methods: TestNgMethodResult[];
};

export type TestNgTestResult = TestNgResultCounts & {
  name: string;
  durationMs: number;
  classes: TestNgClassResult[];
};

export type TestNgSuiteResult = TestNgResultCounts & {
  name: string;
  durationMs: number;
  tests: TestNgTestResult[];
};

export type TestNgResultDetails = TestNgResultCounts & {
  detailsTruncated: boolean;
  suites: TestNgSuiteResult[];
};

export type RunBatch = {
  id: string;
  projectId: string;
  environmentId?: string;
  environmentVersionId?: string;
  suiteId: string;
  suiteName: string;
  suiteVersion: number;
  status: RunBatchStatus;
  retryLimit: number;
  queueTimeoutMs: number;
  claimTimeoutMs: number;
  executionTimeoutMs: number;
  uploadTimeoutMs: number;
  environmentVariables: ExecutionEnvironmentVariable[];
  secretBindings: ExecutionEnvironmentSecretBinding[];
  selectedRunnerIds: string[];
  totalRuns: number;
  queuedRuns: number;
  assignedRuns: number;
  runningRuns: number;
  succeededRuns: number;
  failedRuns: number;
  timedOutRuns: number;
  cancelledRuns: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type RunBatchStatusEvent = {
  id: string;
  batchId: string;
  fromStatus?: RunBatchStatus;
  toStatus: RunBatchStatus;
  batchVersion: number;
  reason: string;
  recordedAt: string;
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
  terminalReasonCode?: string;
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
  durationMs?: number;
  testNg?: TestNgResultDetails;
  createdAt: string;
};

export type RunBatchDetails = RunBatch & {
  runs: ExecutionRun[];
  attempts: RunAttempt[];
  statusHistory: RunBatchStatusEvent[];
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
