import type { ExecutionRun } from "./run-batch";
import type { Runner } from "./runner";
import {
  assessRunnerCompatibility,
  DEFAULT_EXECUTION_RESOURCE_LIMITS,
} from "./runner-compatibility";

export type SchedulingThresholds = {
  maximumCpuUtilizationPercent: number;
  maximumMemoryUtilizationPercent: number;
  maximumLoadPerCpu: number;
};

export type SchedulingBlockReason =
  | "runner_not_online"
  | "runner_incompatible"
  | "metrics_unavailable"
  | "metrics_stale"
  | "capacity_exhausted"
  | "cpu_limit_exceeded"
  | "memory_limit_exceeded"
  | "memory_reservation_exhausted"
  | "load_limit_exceeded";

export type SchedulingCandidate = {
  runner: Runner;
  reservedSlots: number;
  /**
   * 最近一次已认证 claim 上报的本机实时空闲槽位。心跳中的 busySlots 最长会
   * 落后一个心跳周期；claim 提示只覆盖容量计算，资源指标仍以心跳为准。
   */
  liveAvailableSlots?: number;
};

export type RunnerSchedulingEvaluation = {
  runnerId: string;
  eligible: boolean;
  blockReasons: SchedulingBlockReason[];
  availableSlots: number;
  loadPerCpu?: number;
  score?: number;
};

export type SchedulingDecision = {
  executionRunId: string;
  runnerId: string;
  score: number;
};

export type SchedulingPlan = {
  decisions: SchedulingDecision[];
  evaluations: RunnerSchedulingEvaluation[];
  unassignedRunIds: string[];
};

type ScheduleExecutionRunsInput = {
  runs: ExecutionRun[];
  candidates: SchedulingCandidate[];
  thresholds: SchedulingThresholds;
  metricsFreshAfter: string;
  // Runner 基础设施异常后的重调度优先避开曾使该 run 异常的节点；若没有其他
  // 合格节点则允许回退，避免单 Runner 部署永久卡住。
  excludedRunnerIdsByRun?: ReadonlyMap<string, ReadonlySet<string>>;
  // 每个 run 的历史 Runner 按 attempt 顺序排列。健康和共享占用优先；
  // 占用相同时，重试从上一次 Runner 的下一个节点开始确定性轮询。
  runnerHistoryByRun?: ReadonlyMap<string, readonly string[]>;
  // 批次策略的并发上限换算成本轮最多新增的 assignment 数；缺省表示不限制。
  maxAssignments?: number;
};

export function scheduleExecutionRuns(input: ScheduleExecutionRunsInput): SchedulingPlan {
  const candidates = input.candidates.map((candidate) => ({ ...candidate }));
  const evaluations = candidates.map((candidate) =>
    evaluateRunnerForScheduling(candidate, input.thresholds, input.metricsFreshAfter),
  );
  const decisions: SchedulingDecision[] = [];
  const unassignedRunIds: string[] = [];
  const maxAssignments = input.maxAssignments ?? Number.POSITIVE_INFINITY;

  for (const run of input.runs) {
    if (decisions.length >= maxAssignments) {
      unassignedRunIds.push(run.id);
      continue;
    }
    const excludedRunnerIds = input.excludedRunnerIdsByRun?.get(run.id);
    const runnerHistory = input.runnerHistoryByRun?.get(run.id) ?? [];
    const selected =
      runnerHistory.length > 0
        ? roundRobinRetryCandidate(
            candidates,
            runnerHistory.at(-1)!,
            excludedRunnerIds,
            input.thresholds,
            input.metricsFreshAfter,
          )
        : bestCandidateWithFallback(
            candidates,
            excludedRunnerIds,
            input.thresholds,
            input.metricsFreshAfter,
          );
    if (!selected) {
      unassignedRunIds.push(run.id);
      continue;
    }
    decisions.push({ executionRunId: run.id, runnerId: selected.runner.id, score: selected.score });
    selected.candidate.reservedSlots = occupiedRunnerSlots(selected.candidate) + 1;
  }

  return { decisions, evaluations, unassignedRunIds };
}

function bestCandidateWithFallback(
  candidates: SchedulingCandidate[],
  excludedRunnerIds: ReadonlySet<string> | undefined,
  thresholds: SchedulingThresholds,
  metricsFreshAfter: string,
): ReturnType<typeof bestCandidate> {
  const preferredCandidates = excludedRunnerIds
    ? candidates.filter((candidate) => !excludedRunnerIds.has(candidate.runner.id))
    : candidates;
  return (
    bestCandidate(preferredCandidates, thresholds, metricsFreshAfter) ??
    bestCandidate(candidates, thresholds, metricsFreshAfter)
  );
}

function roundRobinRetryCandidate(
  candidates: SchedulingCandidate[],
  previousRunnerId: string,
  excludedRunnerIds: ReadonlySet<string> | undefined,
  thresholds: SchedulingThresholds,
  metricsFreshAfter: string,
): ReturnType<typeof bestCandidate> {
  const eligible = candidates
    .map((candidate) => ({
      candidate,
      runner: candidate.runner,
      evaluation: evaluateRunnerForScheduling(candidate, thresholds, metricsFreshAfter),
    }))
    .filter(
      (
        entry,
      ): entry is typeof entry & { evaluation: RunnerSchedulingEvaluation & { score: number } } =>
        entry.evaluation.eligible && entry.evaluation.score !== undefined,
    );
  if (eligible.length === 0) return undefined;

  const preferred = excludedRunnerIds
    ? eligible.filter((entry) => !excludedRunnerIds.has(entry.runner.id))
    : eligible;
  const pool = preferred.length > 0 ? preferred : eligible;
  const stableRunnerIds = [...new Set(candidates.map(({ runner }) => runner.id))].sort(
    (left, right) => left.localeCompare(right),
  );
  const previousIndex = stableRunnerIds.indexOf(previousRunnerId);
  const startIndex = previousIndex < 0 ? 0 : (previousIndex + 1) % stableRunnerIds.length;
  const cyclicDistance = (runnerId: string): number => {
    const index = stableRunnerIds.indexOf(runnerId);
    return index >= startIndex ? index - startIndex : stableRunnerIds.length - startIndex + index;
  };
  const selected = pool.sort(
    (left, right) =>
      occupiedRunnerSlots(left.candidate) - occupiedRunnerSlots(right.candidate) ||
      cyclicDistance(left.runner.id) - cyclicDistance(right.runner.id) ||
      left.runner.id.localeCompare(right.runner.id),
  )[0]!;
  return {
    candidate: selected.candidate,
    runner: selected.runner,
    score: selected.evaluation.score,
  };
}

export function evaluateRunnerForScheduling(
  candidate: SchedulingCandidate,
  thresholds: SchedulingThresholds,
  metricsFreshAfter: string,
): RunnerSchedulingEvaluation {
  const reasons: SchedulingBlockReason[] = [];
  const runner = candidate.runner;
  const occupiedSlots = occupiedRunnerSlots(candidate);
  const concurrencySlots = Math.max(0, runner.maxConcurrency - occupiedSlots);
  const memorySlots = availableMemorySlots(candidate, thresholds);
  const availableSlots = Math.min(concurrencySlots, memorySlots);
  const metrics = runner.resourceSnapshot;

  if (runner.state !== "online") reasons.push("runner_not_online");
  if (!assessRunnerCompatibility(runner).compatible) reasons.push("runner_incompatible");
  if (concurrencySlots === 0) reasons.push("capacity_exhausted");
  if (memorySlots === 0) reasons.push("memory_reservation_exhausted");
  if (!metrics) {
    reasons.push("metrics_unavailable");
    return { runnerId: runner.id, eligible: false, blockReasons: reasons, availableSlots };
  }
  if (metrics.observedAt < metricsFreshAfter) reasons.push("metrics_stale");
  if (metrics.cpuUtilizationPercent > thresholds.maximumCpuUtilizationPercent) {
    reasons.push("cpu_limit_exceeded");
  }
  if (metrics.memoryUtilizationPercent > thresholds.maximumMemoryUtilizationPercent) {
    reasons.push("memory_limit_exceeded");
  }
  const loadPerCpu = metrics.loadAverage1m / metrics.logicalCpuCount;
  if (loadPerCpu > thresholds.maximumLoadPerCpu) reasons.push("load_limit_exceeded");

  if (reasons.length > 0) {
    return {
      runnerId: runner.id,
      eligible: false,
      blockReasons: reasons,
      availableSlots,
      loadPerCpu: rounded(loadPerCpu),
    };
  }

  return {
    runnerId: runner.id,
    eligible: true,
    blockReasons: [],
    availableSlots,
    loadPerCpu: rounded(loadPerCpu),
    score: schedulingScore(candidate, thresholds, loadPerCpu),
  };
}

function bestCandidate(
  candidates: SchedulingCandidate[],
  thresholds: SchedulingThresholds,
  metricsFreshAfter: string,
): { candidate: SchedulingCandidate; runner: Runner; score: number } | undefined {
  return candidates
    .map((candidate) => ({
      candidate,
      runner: candidate.runner,
      evaluation: evaluateRunnerForScheduling(candidate, thresholds, metricsFreshAfter),
    }))
    .filter(
      (
        entry,
      ): entry is typeof entry & { evaluation: RunnerSchedulingEvaluation & { score: number } } =>
        entry.evaluation.eligible && entry.evaluation.score !== undefined,
    )
    .sort(
      (left, right) =>
        occupiedRunnerSlots(left.candidate) - occupiedRunnerSlots(right.candidate) ||
        right.evaluation.score - left.evaluation.score ||
        left.runner.id.localeCompare(right.runner.id),
    )
    .map((entry) => ({
      candidate: entry.candidate,
      runner: entry.runner,
      score: entry.evaluation.score,
    }))[0];
}

function schedulingScore(
  candidate: SchedulingCandidate,
  thresholds: SchedulingThresholds,
  loadPerCpu: number,
): number {
  const metrics = candidate.runner.resourceSnapshot;
  if (!metrics) return 0;
  const occupiedSlots = occupiedRunnerSlots(candidate);
  const capacityHeadroom =
    Math.min(
      candidate.runner.maxConcurrency - occupiedSlots,
      availableMemorySlots(candidate, thresholds),
    ) / candidate.runner.maxConcurrency;
  const cpuHeadroom = headroom(
    metrics.cpuUtilizationPercent,
    thresholds.maximumCpuUtilizationPercent,
  );
  const memoryHeadroom = headroom(
    metrics.memoryUtilizationPercent,
    thresholds.maximumMemoryUtilizationPercent,
  );
  const loadHeadroom = headroom(loadPerCpu, thresholds.maximumLoadPerCpu);
  return rounded(
    100 *
      (0.4 * capacityHeadroom + 0.25 * cpuHeadroom + 0.2 * memoryHeadroom + 0.15 * loadHeadroom),
  );
}

/** Commit every occupied JVM's full limit, discounting only execution memory already
 * included in the same resource sample. Missing telemetry keeps the conservative budget.
 */
function availableMemorySlots(
  candidate: SchedulingCandidate,
  thresholds: SchedulingThresholds,
): number {
  const budget = runnerMemoryBudget(candidate, thresholds);
  if (!budget) return Number.POSITIVE_INFINITY;
  return Math.max(
    0,
    Math.floor(budget.availableForNewBytes / DEFAULT_EXECUTION_RESOURCE_LIMITS.memoryBytes),
  );
}

function runnerMemoryBudget(candidate: SchedulingCandidate, thresholds: SchedulingThresholds) {
  const metrics = candidate.runner.resourceSnapshot;
  if (metrics?.memoryTotalBytes === undefined && metrics?.memoryAvailableBytes === undefined)
    return null;
  const total = metrics?.memoryTotalBytes;
  const available = metrics?.memoryAvailableBytes;
  const committedBytes =
    occupiedRunnerSlots(candidate) * DEFAULT_EXECUTION_RESOURCE_LIMITS.memoryBytes;
  const reportedCredit = metrics?.memoryExecutionCreditBytes ?? 0;
  const valid =
    total !== undefined &&
    available !== undefined &&
    Number.isSafeInteger(total) &&
    total > 0 &&
    Number.isSafeInteger(available) &&
    available >= 0 &&
    available <= total &&
    Number.isSafeInteger(reportedCredit) &&
    reportedCredit >= 0 &&
    reportedCredit <= total - available;
  if (!valid)
    return {
      systemReserveBytes: 0,
      executionCreditBytes: 0,
      reservedGrowthBytes: committedBytes,
      availableForNewBytes: 0,
    };
  const systemReserveBytes = Math.ceil(
    total * (1 - thresholds.maximumMemoryUtilizationPercent / 100),
  );
  // A late heartbeat may still include already completed processes; never credit more
  // than the entire current commitment, nor treat the credit as extra physical RAM.
  const executionCreditBytes = Math.min(
    reportedCredit,
    committedBytes,
    liveOccupiedRunnerSlots(candidate) * DEFAULT_EXECUTION_RESOURCE_LIMITS.memoryBytes,
  );
  const reservedGrowthBytes = committedBytes - executionCreditBytes;
  return {
    systemReserveBytes,
    executionCreditBytes,
    reservedGrowthBytes,
    availableForNewBytes: Math.max(0, available - systemReserveBytes - reservedGrowthBytes),
  };
}

function occupiedRunnerSlots(candidate: SchedulingCandidate): number {
  // Persisted assignments include work not yet started by the Agent.
  return Math.max(liveOccupiedRunnerSlots(candidate), candidate.reservedSlots);
}

function liveOccupiedRunnerSlots(candidate: SchedulingCandidate): number {
  const runner = candidate.runner;
  return candidate.liveAvailableSlots === undefined
    ? runner.busySlots
    : runner.maxConcurrency -
        Math.min(runner.maxConcurrency, Math.max(0, candidate.liveAvailableSlots));
}

/** Read-only explanation of the same admission budget used by the scheduler. */
export function explainRunnerSchedulingCapacity(
  candidate: SchedulingCandidate,
  thresholds: SchedulingThresholds,
) {
  const occupiedSlots = occupiedRunnerSlots(candidate);
  const memorySlots = availableMemorySlots(candidate, thresholds);
  const budget = runnerMemoryBudget(candidate, thresholds);
  return {
    concurrencyAvailableSlots: Math.max(0, candidate.runner.maxConcurrency - occupiedSlots),
    memoryAvailableSlots: Number.isFinite(memorySlots) ? memorySlots : null,
    memoryPerAttemptBytes: DEFAULT_EXECUTION_RESOURCE_LIMITS.memoryBytes,
    systemMemoryReserveBytes: budget?.systemReserveBytes ?? null,
    memoryExecutionCreditBytes: budget?.executionCreditBytes ?? null,
    memoryReservedGrowthBytes: budget?.reservedGrowthBytes ?? null,
  };
}

function headroom(value: number, maximum: number): number {
  return Math.max(0, Math.min(1, (maximum - value) / maximum));
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
