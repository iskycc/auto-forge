import type { CreateRunBatchInput } from "@autoforge/contracts";
import {
  DomainError,
  scheduleExecutionRuns,
  type RunBatchDetails,
  type SchedulingThresholds,
} from "@autoforge/domain";

import type {
  CaseSuiteRepository,
  Clock,
  IdGenerator,
  RunBatchRepository,
  RunnerRepository,
} from "./ports";

const OFFLINE_AFTER_SECONDS = 45;

export class RunBatchSchedulingService {
  constructor(
    private readonly batches: RunBatchRepository,
    private readonly suites: CaseSuiteRepository,
    private readonly runners: RunnerRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly thresholds: SchedulingThresholds,
    private readonly metricsMaximumAgeSeconds: number,
  ) {}

  async create(input: CreateRunBatchInput): Promise<RunBatchDetails> {
    const suite = await this.suites.get(input.suiteId);
    if (!suite) throw new DomainError("CASE_SUITE_NOT_FOUND", "指定的用例任务不存在。");
    const enabledCases = suite.items.filter((item) => item.caseDefinition.enabled);
    if (enabledCases.length === 0) {
      throw new DomainError("RUN_BATCH_EMPTY", "用例任务中没有可执行的启用用例。");
    }
    await this.ensureRunnersExist(input.runnerIds);

    const createdAt = this.clock.now().toISOString();
    const batchId = this.ids.next();
    await this.batches.create({
      id: batchId,
      suiteId: suite.id,
      suiteName: suite.name,
      suiteVersion: suite.version,
      retryLimit: input.retryLimit,
      environmentVariables: [...input.environmentVariables].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
      runnerIds: [...input.runnerIds].sort(),
      runs: enabledCases.map((item) => ({
        id: this.ids.next(),
        caseDefinitionId: item.caseDefinition.id,
        caseVersion: item.caseDefinition.currentVersion,
        displayName: item.caseDefinition.displayName,
        className: item.caseDefinition.className,
      })),
      createdAt,
    });
    return this.schedule(batchId);
  }

  async list(limit = 100) {
    return this.batches.list(limit);
  }

  async get(batchId: string): Promise<RunBatchDetails> {
    const batch = await this.batches.get(batchId);
    if (!batch) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
    return batch;
  }

  async schedule(batchId: string): Promise<RunBatchDetails> {
    const now = this.clock.now();
    const snapshot = await this.batches.getSchedulingSnapshot(batchId, offlineBefore(now));
    if (!snapshot) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
    if (snapshot.queuedRuns.length > 0) {
      const plan = scheduleExecutionRuns({
        runs: snapshot.queuedRuns,
        candidates: snapshot.candidates,
        thresholds: this.thresholds,
        metricsFreshAfter: metricsFreshAfter(now, this.metricsMaximumAgeSeconds),
      });
      if (plan.decisions.length > 0) {
        await this.batches.reserveAssignments({
          batchId,
          decisions: plan.decisions.map((decision) => ({
            ...decision,
            attemptId: this.ids.next(),
          })),
          thresholds: this.thresholds,
          offlineBefore: offlineBefore(now),
          metricsFreshAfter: metricsFreshAfter(now, this.metricsMaximumAgeSeconds),
          scheduledAt: now.toISOString(),
        });
      }
    }
    return this.get(batchId);
  }

  async scheduleQueuedBatches(limit = 50): Promise<number> {
    const batchIds = await this.batches.listSchedulableBatchIds(limit);
    return this.scheduleBatchIds(batchIds);
  }

  async scheduleForRunner(runnerId: string, limit = 50): Promise<number> {
    const batchIds = await this.batches.listSchedulableBatchIdsForRunner(runnerId, limit);
    return this.scheduleBatchIds(batchIds);
  }

  private async scheduleBatchIds(batchIds: string[]): Promise<number> {
    let scheduled = 0;
    for (const batchId of batchIds) {
      const before = await this.batches.get(batchId);
      const after = await this.schedule(batchId);
      scheduled += Math.max(0, after.assignedRuns - (before?.assignedRuns ?? 0));
    }
    return scheduled;
  }

  policy(): SchedulingThresholds & { metricsMaximumAgeSeconds: number } {
    return { ...this.thresholds, metricsMaximumAgeSeconds: this.metricsMaximumAgeSeconds };
  }

  private async ensureRunnersExist(runnerIds: string[]): Promise<void> {
    const offlineCutoff = offlineBefore(this.clock.now());
    const resolved = await Promise.all(
      runnerIds.map((runnerId) => this.runners.get(runnerId, offlineCutoff)),
    );
    if (resolved.some((runner) => !runner)) {
      throw new DomainError("RUNNER_NOT_FOUND", "所选执行机中包含不存在的节点。");
    }
    if (resolved.some((runner) => runner?.state === "disabled")) {
      throw new DomainError("RUNNER_DISABLED", "已禁用的执行机不能加入执行批次。");
    }
  }
}

function offlineBefore(now: Date): string {
  return new Date(now.getTime() - OFFLINE_AFTER_SECONDS * 1_000).toISOString();
}

function metricsFreshAfter(now: Date, maximumAgeSeconds: number): string {
  return new Date(now.getTime() - maximumAgeSeconds * 1_000).toISOString();
}
