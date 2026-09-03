import type { RunBatch, Runner } from "@autoforge/domain";

type QualitySnapshot = {
  sampleCount: number;
  successRate: number;
};

export function calculateQualityDelta(
  current: QualitySnapshot | null,
  previous: QualitySnapshot | null,
): number | null {
  if (!current || !previous || current.sampleCount === 0 || previous.sampleCount === 0) return null;
  return (current.successRate - previous.successRate) * 100;
}

export type ActiveRunSummary = {
  batchCount: number;
  totalRuns: number;
  runningRuns: number;
  succeededRuns: number;
  failedRuns: number;
  pendingRuns: number;
};

export function summarizeActiveRuns(
  batches: readonly Pick<
    RunBatch,
    | "totalRuns"
    | "runningRuns"
    | "succeededRuns"
    | "failedRuns"
    | "timedOutRuns"
    | "queuedRuns"
    | "assignedRuns"
  >[],
): ActiveRunSummary {
  return batches.reduce<ActiveRunSummary>(
    (summary, batch) => ({
      batchCount: summary.batchCount + 1,
      totalRuns: summary.totalRuns + batch.totalRuns,
      runningRuns: summary.runningRuns + batch.runningRuns,
      succeededRuns: summary.succeededRuns + batch.succeededRuns,
      failedRuns: summary.failedRuns + batch.failedRuns + batch.timedOutRuns,
      pendingRuns: summary.pendingRuns + batch.queuedRuns + batch.assignedRuns,
    }),
    {
      batchCount: 0,
      totalRuns: 0,
      runningRuns: 0,
      succeededRuns: 0,
      failedRuns: 0,
      pendingRuns: 0,
    },
  );
}

export type RunnerCapacitySummary = {
  runnerCount: number;
  onlineRunnerCount: number;
  unavailableRunnerCount: number;
  onlineSlots: number;
  busySlots: number;
  availableSlots: number;
  utilizationPercent: number;
  averageCpuPercent?: number;
  averageMemoryPercent?: number;
};

export function summarizeRunnerCapacity(
  runners: readonly Pick<Runner, "state" | "maxConcurrency" | "busySlots" | "resourceSnapshot">[],
): RunnerCapacitySummary {
  const onlineRunners = runners.filter((runner) => runner.state === "online");
  const onlineSlots = onlineRunners.reduce((sum, runner) => sum + runner.maxConcurrency, 0);
  const busySlots = onlineRunners.reduce(
    (sum, runner) => sum + Math.min(runner.maxConcurrency, Math.max(0, runner.busySlots)),
    0,
  );
  const resourceSnapshots = onlineRunners.flatMap((runner) =>
    runner.resourceSnapshot ? [runner.resourceSnapshot] : [],
  );
  const averages =
    resourceSnapshots.length === 0
      ? {}
      : {
          averageCpuPercent: average(
            resourceSnapshots.map((snapshot) => snapshot.cpuUtilizationPercent),
          ),
          averageMemoryPercent: average(
            resourceSnapshots.map((snapshot) => snapshot.memoryUtilizationPercent),
          ),
        };
  return {
    runnerCount: runners.length,
    onlineRunnerCount: onlineRunners.length,
    unavailableRunnerCount: runners.length - onlineRunners.length,
    onlineSlots,
    busySlots,
    availableSlots: Math.max(0, onlineSlots - busySlots),
    utilizationPercent: onlineSlots === 0 ? 0 : Math.round((busySlots / onlineSlots) * 100),
    ...averages,
  };
}

export type DashboardFocus = {
  title: string;
  detail: string;
  href: string;
  tone: "info" | "success" | "warning" | "danger";
};

export function selectDashboardFocus(input: {
  activeBatch?: Pick<RunBatch, "id" | "suiteName" | "runningRuns" | "queuedRuns">;
  failedMethods: number;
  unavailableRunners: number;
  enabledMethods: number;
  canReadRuns: boolean;
  canReadRunners: boolean;
  canReadCases: boolean;
}): DashboardFocus {
  if (input.canReadRuns && input.activeBatch) {
    return {
      title: `正在执行 · ${input.activeBatch.suiteName}`,
      detail: `${input.activeBatch.runningRuns} 个运行中，${input.activeBatch.queuedRuns} 个等待资源`,
      href: `/run-batches/${input.activeBatch.id}`,
      tone: "info",
    };
  }
  if (input.canReadRuns && input.failedMethods > 0) {
    return {
      title: `${input.failedMethods} 个失败方法需要关注`,
      detail: "查看本周失败聚类，进入用例分析完成归因。",
      href: "/case-analysis",
      tone: "danger",
    };
  }
  if (input.canReadRunners && input.unavailableRunners > 0) {
    return {
      title: `${input.unavailableRunners} 台执行机当前不可用`,
      detail: "检查离线、排空或禁用节点，避免影响后续调度。",
      href: "/runners",
      tone: "warning",
    };
  }
  if (input.canReadCases && input.enabledMethods === 0) {
    return {
      title: "导入第一批可执行用例",
      detail: "从 TestNG JAR 建立用例资产，然后创建任务发起执行。",
      href: "/cases/import",
      tone: "info",
    };
  }
  if (input.canReadRuns) {
    return {
      title: "当前质量状态稳定",
      detail: "暂无活动执行和待关注失败，可查看完整质量趋势。",
      href: "/insights",
      tone: "success",
    };
  }
  return {
    title: "工作台已就绪",
    detail: "当前权限范围内暂无需要立即处理的事项。",
    href: "/account/security",
    tone: "success",
  };
}

function average(values: readonly number[]): number {
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}
