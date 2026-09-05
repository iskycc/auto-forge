import type {
  ExecutionEnvironmentSecretBinding,
  ExecutionEnvironmentVariable,
} from "./environment";
import type { RetryConcurrencyRule } from "./case-suite";

export type RunBatchStatus =
  "queued" | "dispatching" | "scheduled" | "running" | "succeeded" | "failed" | "cancelled";

/**
 * 普通批次进入执行历史和质量统计；日志诊断重跑只作为原用例的日志历史存在，
 * 不得污染原批次轮次、Webhook、执行记录或质量洞察。
 */
export type RunBatchKind = "standard" | "final_failure_rerun" | "case_log_rerun";

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
  projectVersionId?: string;
  runnerLabels: string[];
  artifactPatterns: string[];
  retryConcurrencyRules?: RetryConcurrencyRule[];
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
  // 自然递增展示编号；UUID 仍是权威主键，该字段只用于界面展示。
  sequenceNumber: number;
  projectId: string;
  environmentId?: string;
  environmentVersionId?: string;
  suiteId: string;
  suiteName: string;
  suiteVersion: number;
  kind?: RunBatchKind;
  parentBatchId?: string;
  sourceExecutionRunId?: string;
  requestedBy?: {
    username: string;
    source: "local" | "ldap";
  };
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
  // 终止请求一经保存，调度器不得再创建或下发新 assignment；已有在途用例自然完成。
  // 在所有 run 进入终态前，批次仍保留其运行状态，由展示层显示“终止中”。
  terminationRequestedAt?: string;
  version: number;
  // 权威计划开始时间。立即执行时等于 createdAt；延时执行时由服务端时钟计算。
  scheduledFor: string;
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

export type RunBatchRoundRecoveryStatus =
  "idle" | "pending" | "polling" | "waiting" | "releasing" | "succeeded" | "failed" | "cancelled";

// 批次创建时固化的 Jenkins 环境恢复步骤。凭据只存在恢复仓储中，详情 DTO
// 仅暴露复盘所需的任务、构建与时间信息，可安全用于登录详情页和匿名分享页。
export type RunBatchRoundRecovery = {
  ruleId: string;
  afterRound: number;
  nextRound: number;
  jenkinsJobUrl: string;
  waitMinutes: number;
  status: RunBatchRoundRecoveryStatus;
  sourceBuildNumber?: number;
  rebuildNumber?: number;
  rebuildUrl?: string;
  activatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  buildResult?: string;
  errorMessage?: string;
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
  caseType?: "testng" | "ddt";
  ddtSrNum?: string;
  status: ExecutionRunStatus;
  assignedRunnerId?: string;
  attemptCount: number;
  /** 当前或最后一次调度所属的逻辑轮次；Runner 基础设施重调度不会推进该值。 */
  executionRound?: number;
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
  /** 逻辑执行轮次；旧数据或兼容调用未提供时回退到 attemptNumber。 */
  executionRound?: number;
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
  roundConcurrencies?: RunBatchRoundConcurrency[];
  roundRecoveries: RunBatchRoundRecovery[];
  statusHistory: RunBatchStatusEvent[];
};

export type RunBatchRoundConcurrencySource = "base" | "inherited_rule" | "rule_transition";

/** 每一轮首次进入调度时固化的有效并发，供批跑效率复盘使用。 */
export type RunBatchRoundConcurrency = {
  round: number;
  concurrency: number;
  source: RunBatchRoundConcurrencySource;
  ruleId?: string;
  previousConcurrency?: number;
  recordedAt: string;
};

export type RunBatchRoundStatus = "running" | "completed" | "waiting";

// 单个轮次的聚合视图。round 模式下 Runner 基础设施重调度仍属于原逻辑轮次；
// immediate 模式每次物理尝试各占一轮。
export type RunBatchRoundSummary = {
  round: number;
  status: RunBatchRoundStatus;
  totalRuns: number;
  executed: number;
  passed: number;
  failed: number;
  timedOut: number;
  cancelled: number;
  // 属于本轮但尚未产生 attempt 的用例数；进行中的轮次也必须实时计算。
  notExecuted: number;
  // 本轮通过率（百分比，0-100）；只以已进入终态的 attempt 为分母，进行中的
  // attempt 不属于“已执行完成”，本轮尚无终态 attempt 时为 null。
  roundPassRate: number | null;
  // 截至本轮末，曾经通过的 run（按 executionRunId 去重）占总用例数的百分比。
  overallPassed: number;
  overallPassRate: number;
  startedAt: string | null;
  durationMs: number | null;
};

export type RunBatchAllRoundsSummary = {
  totalRuns: number;
  passed: number;
  failed: number;
  timedOut: number;
  cancelled: number;
  notExecuted: number;
  passRate: number;
};

// “总结”虚拟轮次按初始用例去重：曾在任一轮通过即视为最终通过，否则取该
// 用例最后一次尝试的结果。字段与全部轮次汇总同构，但 totalRuns 永远不累加重试。
export type RunBatchFinalSummary = RunBatchAllRoundsSummary;

// 纯函数聚合：不读取系统时间，进行中的轮次 durationMs 为 null，由调用方决定如何倒计时。
export function summarizeRunBatchRounds(
  batch: Pick<RunBatch, "currentRound" | "retryMode" | "status" | "totalRuns">,
  runs: readonly ExecutionRun[],
  attempts: readonly RunAttempt[],
): RunBatchRoundSummary[] {
  const roundNumbers = runBatchRoundNumbers(batch, runs, attempts);
  const passedRunIds = new Set<string>();
  return roundNumbers.map((round) => {
    const roundAttempts = runAttemptsForExecutionRound(attempts, round);
    const eligibleRuns = executionRunsForRound(runs, attempts, round);
    const attemptedRunIds = new Set(roundAttempts.map((attempt) => attempt.executionRunId));
    for (const attempt of roundAttempts) {
      if (runAttemptOutcome(attempt) === "succeeded") passedRunIds.add(attempt.executionRunId);
    }
    const executed = attemptedRunIds.size;
    const status = roundStatus(batch, round, roundAttempts, eligibleRuns.length, executed);
    const passed = countOutcome(roundAttempts, "succeeded");
    const timedOut = countOutcome(roundAttempts, "timed_out");
    const failed = countOutcome(roundAttempts, "failed");
    const cancelled = countOutcome(roundAttempts, "cancelled");
    const completed = passed + failed + timedOut + cancelled;
    return {
      round,
      status,
      totalRuns: eligibleRuns.length,
      executed,
      passed,
      failed,
      timedOut,
      cancelled,
      notExecuted: Math.max(0, eligibleRuns.length - executed),
      roundPassRate: completed === 0 ? null : Math.round((passed / completed) * 100),
      overallPassed: passedRunIds.size,
      overallPassRate:
        batch.totalRuns === 0 ? 0 : Math.round((passedRunIds.size / batch.totalRuns) * 100),
      startedAt: roundStartedAt(roundAttempts),
      durationMs: status === "running" ? null : roundDurationMs(roundAttempts),
    };
  });
}

/**
 * 返回批次已有或已声明等待的轮次号。currentRound 必须纳入，否则一轮刚释放、
 * 尚未产生第一个 attempt 的短暂窗口会从页面消失。
 */
export function runBatchRoundNumbers(
  batch: Pick<RunBatch, "currentRound">,
  runs: readonly ExecutionRun[],
  attempts: readonly RunAttempt[],
): number[] {
  const numbers = new Set<number>([1, batch.currentRound]);
  for (const attempt of attempts) numbers.add(runAttemptExecutionRound(attempt));
  for (const run of runs) {
    if (run.executionRound !== undefined) numbers.add(run.executionRound);
    if (run.heldRound !== undefined && run.heldRound > 0) numbers.add(run.heldRound);
  }
  return [...numbers].sort((left, right) => left - right);
}

/**
 * 单一轮次资格规则：首轮包含批次全部用例；后续轮次只包含已经持久化到该逻辑
 * 轮次的 run 或 attempt。不得仅凭上一轮失败推断资格，否则已耗尽重跑额度的用例
 * 会被错误展示成“未执行”。旧调用未携带 executionRound 时保留原推导口径。
 */
export function executionRunsForRound(
  runs: readonly ExecutionRun[],
  attempts: readonly RunAttempt[],
  round: number,
): ExecutionRun[] {
  if (round === 1) return [...runs];
  const eligibleRunIds = new Set<string>();
  const runsById = new Map(runs.map((run) => [run.id, run]));
  for (const attempt of attempts) {
    if (runAttemptExecutionRound(attempt) === round) {
      eligibleRunIds.add(attempt.executionRunId);
    }
    const run = runsById.get(attempt.executionRunId);
    if (run?.executionRound !== undefined || attempt.executionRound !== undefined) continue;
    if (attempt.attemptNumber !== round - 1) continue;
    const outcome = runAttemptOutcome(attempt);
    if (outcome === "failed" || outcome === "timed_out") {
      eligibleRunIds.add(attempt.executionRunId);
    }
  }
  for (const run of runs) {
    if (run.executionRound === round) eligibleRunIds.add(run.id);
    if (run.heldRound === round) eligibleRunIds.add(run.id);
  }
  return runs.filter((run) => eligibleRunIds.has(run.id));
}

/**
 * 每个用例在同一逻辑轮次只展示最后一次物理尝试。前序 Runner 异常仍保存在
 * attempt 历史和执行机异常视图中，但不能重复计入该轮用例数与通过率。
 */
export function runAttemptsForExecutionRound(
  attempts: readonly RunAttempt[],
  round: number,
): RunAttempt[] {
  const latestByRunId = new Map<string, RunAttempt>();
  for (const attempt of attempts) {
    if (runAttemptExecutionRound(attempt) !== round) continue;
    const current = latestByRunId.get(attempt.executionRunId);
    if (!current || attempt.attemptNumber > current.attemptNumber) {
      latestByRunId.set(attempt.executionRunId, attempt);
    }
  }
  return [...latestByRunId.values()];
}

export function runAttemptExecutionRound(
  attempt: Pick<RunAttempt, "attemptNumber" | "executionRound">,
): number {
  return attempt.executionRound ?? attempt.attemptNumber;
}

/** 全部轮次按各真实轮次逐项求和，不再回退到首轮批次总数。 */
export function summarizeAllRunBatchRounds(
  summaries: readonly RunBatchRoundSummary[],
): RunBatchAllRoundsSummary {
  const totals = summaries.reduce<Omit<RunBatchAllRoundsSummary, "passRate">>(
    (current, summary) => ({
      totalRuns: current.totalRuns + summary.totalRuns,
      passed: current.passed + summary.passed,
      failed: current.failed + summary.failed,
      timedOut: current.timedOut + summary.timedOut,
      cancelled: current.cancelled + summary.cancelled,
      notExecuted: current.notExecuted + summary.notExecuted,
    }),
    { totalRuns: 0, passed: 0, failed: 0, timedOut: 0, cancelled: 0, notExecuted: 0 },
  );
  return {
    ...totals,
    passRate: totals.totalRuns === 0 ? 0 : Math.round((totals.passed / totals.totalRuns) * 100),
  };
}

export function summarizeRunBatchFinalResults(
  batch: Pick<RunBatch, "totalRuns">,
  runs: readonly ExecutionRun[],
  attempts: readonly RunAttempt[],
): RunBatchFinalSummary {
  const finalAttempts = finalRunAttemptByExecutionRun(attempts);
  let passed = 0;
  let failed = 0;
  let timedOut = 0;
  let cancelled = 0;
  let notExecuted = 0;
  for (const run of runs) {
    const attempt = finalAttempts.get(run.id);
    const outcome = attempt ? runAttemptOutcome(attempt) : undefined;
    if (outcome === "succeeded") passed += 1;
    else if (outcome === "failed") failed += 1;
    else if (outcome === "timed_out") timedOut += 1;
    else if (outcome === "cancelled") cancelled += 1;
    else notExecuted += 1;
  }
  return {
    totalRuns: batch.totalRuns,
    passed,
    failed,
    timedOut,
    cancelled,
    notExecuted,
    passRate: batch.totalRuns === 0 ? 0 : Math.round((passed / batch.totalRuns) * 100),
  };
}

/**
 * 每个用例的最终展示尝试：成功优先于后续异常，未成功时取轮次号最大的尝试。
 * 这同时供“总结”统计和 UI 行模型复用，避免两处最终口径漂移。
 */
export function finalRunAttemptByExecutionRun(
  attempts: readonly RunAttempt[],
): ReadonlyMap<string, RunAttempt> {
  const selected = new Map<string, RunAttempt>();
  for (const attempt of attempts) {
    const current = selected.get(attempt.executionRunId);
    if (!current) {
      selected.set(attempt.executionRunId, attempt);
      continue;
    }
    const currentSucceeded = runAttemptOutcome(current) === "succeeded";
    const attemptSucceeded = runAttemptOutcome(attempt) === "succeeded";
    if (
      (!currentSucceeded && attemptSucceeded) ||
      (currentSucceeded === attemptSucceeded && attempt.attemptNumber > current.attemptNumber)
    ) {
      selected.set(attempt.executionRunId, attempt);
    }
  }
  return selected;
}

// 终态 attempt 的不变量保证 outcome 与 status 一致；防御性回退到 status 以覆盖历史数据。
// 导出与轮次统计共用同一判定，避免两处对 outcome/status 的回退规则漂移。
export function runAttemptOutcome(attempt: RunAttempt): RunAttempt["outcome"] {
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

function roundStatus(
  batch: Pick<RunBatch, "currentRound" | "retryMode" | "status">,
  round: number,
  roundAttempts: readonly RunAttempt[],
  totalRuns: number,
  executed: number,
): RunBatchRoundStatus {
  const hasActive = roundAttempts.some(
    (attempt) => attempt.status === "assigned" || attempt.status === "running",
  );
  if (hasActive) return "running";
  if (isTerminalRoundBatchStatus(batch.status) || round < batch.currentRound) return "completed";
  if (batch.retryMode === "immediate") {
    if (roundAttempts.length === 0) return "waiting";
    return executed < totalRuns ? "running" : "completed";
  }
  if (round > batch.currentRound || roundAttempts.length === 0) return "waiting";
  return executed < totalRuns ? "running" : "completed";
}

function isTerminalRoundBatchStatus(status: RunBatchStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function countOutcome(
  roundAttempts: readonly RunAttempt[],
  outcome: NonNullable<RunAttempt["outcome"]>,
): number {
  return roundAttempts.filter((attempt) => runAttemptOutcome(attempt) === outcome).length;
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

export function summarizeRunBatchCounters(batch: RunBatch) {
  const terminal =
    batch.succeededRuns + batch.failedRuns + batch.timedOutRuns + batch.cancelledRuns;
  return {
    totalRuns: batch.totalRuns,
    passed: batch.succeededRuns,
    failed: batch.failedRuns,
    timedOut: batch.timedOutRuns,
    cancelled: batch.cancelledRuns,
    notExecuted: Math.max(0, batch.totalRuns - terminal),
    passRate: batch.totalRuns === 0 ? 0 : Math.round((batch.succeededRuns / batch.totalRuns) * 100),
  };
}
