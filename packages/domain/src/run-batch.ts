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

export type RunBatchRoundStatus = "running" | "completed" | "waiting";

// 单个轮次的聚合视图。round 模式下 attemptNumber 即轮次号；immediate 模式下
// attemptNumber 是同一 run 的第几次尝试，两种模式共用同一套按轮统计规则。
export type RunBatchRoundSummary = {
  round: number;
  status: RunBatchRoundStatus;
  totalRuns: number;
  executed: number;
  passed: number;
  failed: number;
  timedOut: number;
  cancelled: number;
  blocked: number;
  // 本轮通过率（百分比，0-100）；本轮尚无 attempt 时为 null，由 UI 显示中间态。
  roundPassRate: number | null;
  // 截至本轮末，曾经通过的 run（按 executionRunId 去重）占总用例数的百分比。
  overallPassRate: number;
  startedAt: string | null;
  durationMs: number | null;
};

// 纯函数聚合：不读取系统时间，进行中的轮次 durationMs 为 null，由调用方决定如何倒计时。
export function summarizeRunBatchRounds(
  batch: RunBatch,
  runs: readonly ExecutionRun[],
  attempts: readonly RunAttempt[],
): RunBatchRoundSummary[] {
  const roundNumbers = collectRoundNumbers(runs, attempts);
  const passedRunIds = new Set<string>();
  return roundNumbers.map((round) => {
    const roundAttempts = attempts.filter((attempt) => attempt.attemptNumber === round);
    for (const attempt of roundAttempts) {
      if (attemptOutcome(attempt) === "succeeded") passedRunIds.add(attempt.executionRunId);
    }
    const status = roundStatus(roundAttempts);
    const executed = roundAttempts.length;
    const passed = countOutcome(roundAttempts, "succeeded");
    const timedOut = countOutcome(roundAttempts, "timed_out");
    const failed = countOutcome(roundAttempts, "failed");
    const cancelled = countOutcome(roundAttempts, "cancelled");
    return {
      round,
      status,
      totalRuns: batch.totalRuns,
      executed,
      passed,
      failed,
      timedOut,
      cancelled,
      blocked: countBlockedRuns(runs, roundAttempts, round, status),
      roundPassRate: executed === 0 ? null : Math.round((passed / executed) * 100),
      overallPassRate:
        batch.totalRuns === 0 ? 0 : Math.round((passedRunIds.size / batch.totalRuns) * 100),
      startedAt: roundStartedAt(roundAttempts),
      durationMs: roundDurationMs(roundAttempts),
    };
  });
}

function collectRoundNumbers(
  runs: readonly ExecutionRun[],
  attempts: readonly RunAttempt[],
): number[] {
  const numbers = new Set<number>([1]);
  for (const attempt of attempts) numbers.add(attempt.attemptNumber);
  for (const run of runs) {
    if (run.heldRound !== undefined && run.heldRound > 0) numbers.add(run.heldRound);
  }
  return [...numbers].sort((left, right) => left - right);
}

// 终态 attempt 的不变量保证 outcome 与 status 一致；防御性回退到 status 以覆盖历史数据。
function attemptOutcome(attempt: RunAttempt): RunAttempt["outcome"] {
  if (attempt.outcome) return attempt.outcome;
  const status = attempt.status;
  if (
    status === "succeeded" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled"
  ) {
    return status;
  }
  return undefined;
}

function roundStatus(roundAttempts: readonly RunAttempt[]): RunBatchRoundStatus {
  if (roundAttempts.length === 0) return "waiting";
  const hasActive = roundAttempts.some(
    (attempt) => attempt.status === "assigned" || attempt.status === "running",
  );
  return hasActive ? "running" : "completed";
}

function countOutcome(
  roundAttempts: readonly RunAttempt[],
  outcome: NonNullable<RunAttempt["outcome"]>,
): number {
  return roundAttempts.filter((attempt) => attemptOutcome(attempt) === outcome).length;
}

// blocked 只统计仍被轮次持有的 run：已完成轮次不再存在阻塞；进行中的轮次只算
// 等待未来轮释放的 run；尚未开始的轮次把等待本轮释放的 run 也计入。
function countBlockedRuns(
  runs: readonly ExecutionRun[],
  roundAttempts: readonly RunAttempt[],
  round: number,
  status: RunBatchRoundStatus,
): number {
  if (status === "completed") return 0;
  const attemptedRunIds = new Set(roundAttempts.map((attempt) => attempt.executionRunId));
  let blocked = 0;
  for (const run of runs) {
    const heldRound = run.heldRound ?? 0;
    if (heldRound === 0) continue;
    if (!attemptedRunIds.has(run.id) && heldRound > round) blocked += 1;
    else if (status === "waiting" && heldRound === round) blocked += 1;
  }
  return blocked;
}

function roundStartedAt(roundAttempts: readonly RunAttempt[]): string | null {
  let earliest: string | null = null;
  for (const attempt of roundAttempts) {
    const candidate = attempt.startedAt ?? attempt.createdAt;
    if (earliest === null || Date.parse(candidate) < Date.parse(earliest)) earliest = candidate;
  }
  return earliest;
}

function roundDurationMs(roundAttempts: readonly RunAttempt[]): number | null {
  const startedAt = roundStartedAt(roundAttempts);
  if (startedAt === null) return null;
  let latestFinish = Number.NaN;
  for (const attempt of roundAttempts) {
    if (!attempt.finishedAt) continue;
    const finished = Date.parse(attempt.finishedAt);
    if (Number.isNaN(latestFinish) || finished > latestFinish) latestFinish = finished;
  }
  if (Number.isNaN(latestFinish)) return null;
  return Math.max(0, latestFinish - Date.parse(startedAt));
}

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
