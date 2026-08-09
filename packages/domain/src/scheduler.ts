import type { ExecutionRun } from "./run-batch";
import type { Runner } from "./runner";

export type SchedulingThresholds = {
  maximumCpuUtilizationPercent: number;
  maximumMemoryUtilizationPercent: number;
  maximumLoadPerCpu: number;
};

export type SchedulingBlockReason =
  | "runner_not_online"
  | "metrics_unavailable"
  | "metrics_stale"
  | "capacity_exhausted"
  | "cpu_limit_exceeded"
  | "memory_limit_exceeded"
  | "load_limit_exceeded";

export type SchedulingCandidate = {
  runner: Runner;
  reservedSlots: number;
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
};

export function scheduleExecutionRuns(input: ScheduleExecutionRunsInput): SchedulingPlan {
  const candidates = input.candidates.map((candidate) => ({ ...candidate }));
  const evaluations = candidates.map((candidate) =>
    evaluateRunnerForScheduling(candidate, input.thresholds, input.metricsFreshAfter),
  );
  const decisions: SchedulingDecision[] = [];
  const unassignedRunIds: string[] = [];

  for (const run of input.runs) {
    const selected = bestCandidate(candidates, input.thresholds, input.metricsFreshAfter);
    if (!selected) {
      unassignedRunIds.push(run.id);
      continue;
    }
    decisions.push({ executionRunId: run.id, runnerId: selected.runner.id, score: selected.score });
    selected.candidate.reservedSlots += 1;
  }

  return { decisions, evaluations, unassignedRunIds };
}

export function evaluateRunnerForScheduling(
  candidate: SchedulingCandidate,
  thresholds: SchedulingThresholds,
  metricsFreshAfter: string,
): RunnerSchedulingEvaluation {
  const reasons: SchedulingBlockReason[] = [];
  const runner = candidate.runner;
  const occupiedSlots = Math.max(runner.busySlots, candidate.reservedSlots);
  const availableSlots = Math.max(0, runner.maxConcurrency - occupiedSlots);
  const metrics = runner.resourceSnapshot;

  if (runner.state !== "online") reasons.push("runner_not_online");
  if (availableSlots === 0) reasons.push("capacity_exhausted");
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
  const occupiedSlots = Math.max(candidate.runner.busySlots, candidate.reservedSlots);
  const capacityHeadroom =
    (candidate.runner.maxConcurrency - occupiedSlots) / candidate.runner.maxConcurrency;
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

function headroom(value: number, maximum: number): number {
  return Math.max(0, Math.min(1, (maximum - value) / maximum));
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
