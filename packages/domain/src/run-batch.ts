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

// 批次创建时从用例任务策略固化的执行配置快照；缺省（历史数据）表示不限制并发、
// 仅使用内置必需标签与默认产物规则。
export type RunBatchExecutionPolicy = {
  executor: "testng" | "testng-container";
  concurrency: number;
  runnerLabels: string[];
  artifactPatterns: string[];
};

// 产物规则的媒体类型只是上传提示，按扩展名做保守推断，未知一律 octet-stream。
export function artifactMediaType(pattern: string): string {
  if (pattern.endsWith(".xml")) return "application/xml";
  if (pattern.endsWith(".json")) return "application/json";
  if (pattern.endsWith(".html") || pattern.endsWith(".htm")) return "text/html";
  if (pattern.endsWith(".txt") || pattern.endsWith(".log")) return "text/plain";
  if (pattern.endsWith(".png")) return "image/png";
  if (pattern.endsWith(".jpg") || pattern.endsWith(".jpeg")) return "image/jpeg";
  if (pattern.endsWith(".zip")) return "application/zip";
  return "application/octet-stream";
}

export type RunBatch = {
  id: string;
  projectId: string;
  environmentId?: string;
  environmentVersionId?: string;
  suiteId: string;
  suiteName: string;
  suiteVersion: number;
  status: RunBatchStatus;
  priority: number;
  retryLimit: number;
  retryMode: "immediate" | "round";
  // 当前执行轮次；immediate 模式恒为 1，round 模式随整轮推进递增。
  currentRound: number;
  queueTimeoutMs: number;
  claimTimeoutMs: number;
  executionTimeoutMs: number;
  uploadTimeoutMs: number;
  environmentVariables: ExecutionEnvironmentVariable[];
  secretBindings: ExecutionEnvironmentSecretBinding[];
  selectedRunnerIds: string[];
  policy?: RunBatchExecutionPolicy;
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
  // 轮次制下失败 run 等待释放的目标轮次；0 或未设置表示可立即调度。
  heldRound?: number;
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
