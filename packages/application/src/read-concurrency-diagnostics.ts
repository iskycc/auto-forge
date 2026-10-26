import { concurrencyDiagnosticsSchema, type ConcurrencyDiagnostics } from "@autoforge/contracts";
import {
  DomainError,
  evaluateRunnerForScheduling,
  explainRunnerSchedulingCapacity,
  REQUIRED_EXECUTION_LABELS,
  type SchedulingThresholds,
} from "@autoforge/domain";
import type { Clock, RunBatchRepository } from "./ports";
import type { ConcurrencySnapshot } from "./concurrency-snapshot";

type Reason = ConcurrencyDiagnostics["reasons"][number];
type Configuration = {
  thresholds: SchedulingThresholds;
  metricsMaximumAgeSeconds: number;
  projectMaximumConcurrency: number;
};

const blockMessages: Record<string, string> = {
  runner_not_online: "节点离线、已禁用或排空中",
  runner_incompatible: "Agent 协议、平台或运行能力不兼容",
  metrics_unavailable: "节点尚未上报完整资源指标",
  metrics_stale: "节点资源指标已过期，等待新的心跳",
  capacity_exhausted: "节点并发槽位已占满",
  cpu_limit_exceeded: "CPU 使用率超过调度阈值",
  memory_limit_exceeded: "内存使用率超过调度阈值",
  memory_reservation_exhausted: "内存增长预留预算不足",
  load_limit_exceeded: "每 CPU 负载超过调度阈值",
};

export class ConcurrencyDiagnosticsService {
  constructor(
    private readonly batches: Pick<RunBatchRepository, "readConcurrencySnapshot">,
    private readonly clock: Clock,
    private readonly configuration: () => Configuration,
  ) {}

  async read(batchId: string, projectIds?: readonly string[]): Promise<ConcurrencyDiagnostics> {
    const now = this.clock.now();
    const snapshot = await this.batches.readConcurrencySnapshot(
      batchId,
      new Date(now.getTime() - 45_000).toISOString(),
      projectIds,
    );
    if (!snapshot)
      throw new DomainError("RUN_BATCH_NOT_FOUND", "执行批次不存在或当前身份无权访问。");
    const configuration = this.configuration();
    const freshAfter = new Date(
      now.getTime() - configuration.metricsMaximumAgeSeconds * 1000,
    ).toISOString();
    const nodes = snapshot.nodes.map(({ runner, reservedSlots, batchReservedSlots }) => {
      const candidate = { runner, reservedSlots };
      const evaluation = evaluateRunnerForScheduling(
        candidate,
        configuration.thresholds,
        freshAfter,
      );
      const reasons: Reason[] = evaluation.blockReasons.map((code) => ({
        code,
        message: blockMessages[code]!,
      }));
      const missingCapabilities = snapshot.requiredCapabilities.filter(
        (capability) => !runner.capabilities.includes(capability),
      );
      if (
        snapshot.batch.policy?.executor === "testng-container" &&
        !runner.capabilities.includes("executor:testng-container-v1")
      )
        missingCapabilities.push("executor:testng-container-v1");
      if (missingCapabilities.length)
        reasons.push({
          code: "capability_missing",
          message: `缺少执行能力：${formatRequirements(missingCapabilities)}`,
        });
      const missingLabels = [
        ...new Set([...REQUIRED_EXECUTION_LABELS, ...(snapshot.batch.policy?.runnerLabels ?? [])]),
      ].filter((label) => !runner.labels.includes(label));
      if (missingLabels.length)
        reasons.push({
          code: "labels_missing",
          message: `领取要求的标签不满足：${formatRequirements(missingLabels)}`,
        });
      if (runner.credentialRevokedAt || runner.deregisteredAt || runner.purgedAt)
        reasons.push({ code: "runner_identity_invalid", message: "节点凭据已撤销或节点已注销" });
      const metrics = runner.resourceSnapshot;
      return {
        id: runner.id,
        name: runner.name,
        maxConcurrency: runner.maxConcurrency,
        reportedBusySlots: runner.busySlots,
        reservedSlots,
        batchReservedSlots,
        otherReservedSlots: Math.max(0, reservedSlots - batchReservedSlots),
        availableSlots: reasons.length ? 0 : evaluation.availableSlots,
        ...explainRunnerSchedulingCapacity(candidate, configuration.thresholds),
        metrics: metrics
          ? {
              cpuUtilizationPercent: metrics.cpuUtilizationPercent,
              memoryUtilizationPercent: metrics.memoryUtilizationPercent,
              ...(metrics.memoryTotalBytes === undefined
                ? {}
                : { memoryTotalBytes: metrics.memoryTotalBytes }),
              ...(metrics.memoryAvailableBytes === undefined
                ? {}
                : { memoryAvailableBytes: metrics.memoryAvailableBytes }),
              observedAt: metrics.observedAt,
            }
          : null,
        reasons,
      };
    });
    const availableNodeSlots = nodes.reduce((sum, node) => sum + node.availableSlots, 0);
    return concurrencyDiagnosticsSchema.parse({
      batchId,
      sampledAt: now.toISOString(),
      targetConcurrency: snapshot.targetConcurrency,
      runningRuns: snapshot.runningRuns,
      assignedRuns: snapshot.assignedRuns,
      readyRuns: snapshot.readyRuns,
      heldRuns: snapshot.heldRuns,
      projectActiveRuns: snapshot.projectActiveRuns,
      projectMaximumConcurrency: configuration.projectMaximumConcurrency,
      availableNodeSlots,
      omittedNodes: snapshot.omittedNodes,
      nodes,
      thresholds: {
        ...configuration.thresholds,
        memoryAdmissionMode: configuration.thresholds.memoryAdmissionMode ?? "reserved",
      },
      metricsMaximumAgeSeconds: configuration.metricsMaximumAgeSeconds,
      reasons: summarizeReasons(
        snapshot,
        nodes,
        availableNodeSlots,
        configuration.projectMaximumConcurrency,
        now,
      ),
    });
  }
}

function formatRequirements(values: readonly string[]): string {
  const preview = values.slice(0, 8).join("、");
  const bounded = preview.length > 1200 ? `${preview.slice(0, 1200)}…` : preview;
  return values.length > 8 ? `${bounded}等（共 ${values.length} 项）` : bounded;
}

function summarizeReasons(
  snapshot: ConcurrencySnapshot,
  nodes: ConcurrencyDiagnostics["nodes"],
  availableSlots: number,
  projectLimit: number,
  now: Date,
): Reason[] {
  const reason = (code: string, message: string): Reason[] => [{ code, message }];
  if (["succeeded", "failed", "cancelled"].includes(snapshot.batch.status))
    return reason("batch_terminal", "任务已结束，不再补充并发。");
  if (snapshot.batch.terminationRequestedAt)
    return reason("termination_requested", "任务正在终止，已停止分配新的用例。");
  if (Date.parse(snapshot.batch.scheduledFor) > now.getTime())
    return reason("scheduled_start", "尚未到计划开始时间。");
  const reasons: Reason[] = [];
  if (snapshot.assignedRuns > 0)
    reasons.push({
      code: "waiting_claim",
      message: `${snapshot.assignedRuns} 个用例已分配、等待 Agent 领取；已分配用例也占用并发名额。`,
    });
  if (!snapshot.readyRuns) {
    reasons.push({
      code: snapshot.recoveryPending
        ? "round_recovery"
        : snapshot.heldRuns
          ? "round_barrier"
          : "no_queued_work",
      message: snapshot.recoveryPending
        ? "等待轮次间环境恢复完成，后续轮次尚未释放。"
        : snapshot.heldRuns
          ? "等待本轮用例结束后释放下一轮用例。"
          : "没有可立即调度的排队用例，可能处于收尾阶段。",
    });
    return reasons;
  }
  const inFlight = snapshot.runningRuns + snapshot.assignedRuns;
  if (snapshot.targetConcurrency !== null && inFlight >= snapshot.targetConcurrency)
    return [
      ...reasons,
      {
        code: "batch_limit",
        message: `在途用例已达到当前生效的任务并发上限 ${snapshot.targetConcurrency}。`,
      },
    ];
  if (snapshot.projectActiveRuns >= projectLimit)
    reasons.push({
      code: "project_limit",
      message: `项目在途执行数已达到 ${snapshot.projectActiveRuns}/${projectLimit}，其他任务也共用该额度。`,
    });
  if (!nodes.length)
    reasons.push({
      code: "no_runners",
      message: "没有可读取的已选执行节点，请检查节点是否已删除或任务快照是否包含节点。",
    });
  const blocked = new Map<string, { message: string; count: number }>();
  for (const node of nodes)
    for (const item of node.reasons) {
      const previous = blocked.get(item.code);
      blocked.set(item.code, {
        message:
          blockMessages[item.code] ??
          (item.code === "capability_missing"
            ? "节点执行能力不满足"
            : item.code === "labels_missing"
              ? "节点领取标签不满足"
              : "节点身份不可用"),
        count: (previous?.count ?? 0) + 1,
      });
    }
  for (const [code, item] of blocked)
    reasons.push({ code, message: `${item.count} 个节点：${item.message}，详见下表。` });
  if (availableSlots > 0 && snapshot.projectActiveRuns < projectLimit)
    reasons.push({
      code: "awaiting_refill",
      message: `本次采样仍有 ${availableSlots} 个节点可增槽位，等待调度与其他任务共同补位；若长时间不变，请结合调度日志继续定位。`,
    });
  if (snapshot.readyRuns + inFlight < (snapshot.targetConcurrency ?? 0))
    reasons.push({
      code: "remaining_work",
      message: `当前可调度及在途用例共 ${snapshot.readyRuns + inFlight} 个，少于任务并发上限。`,
    });
  return reasons;
}
