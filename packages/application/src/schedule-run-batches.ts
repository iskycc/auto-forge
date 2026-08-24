import {
  createRunBatchInputSchema,
  createSingleCaseRunInputSchema,
  type CreateRunBatchInput,
  type CreateSingleCaseRunInput,
  type RunBatchPreflightBlocker,
  type RunBatchPreflightResult,
} from "@autoforge/contracts";
import {
  assessRunnerCompatibility,
  COTEST_ADAPTER_CAPABILITY,
  DEFAULT_CASE_EXECUTION_TIMEOUT_SECONDS,
  DEFAULT_EXECUTION_RESOURCE_LIMITS,
  defaultCaseSuiteExecutionPolicy,
  DEFAULT_PROJECT_ID,
  DomainError,
  REQUIRED_EXECUTION_LABELS,
  retryConcurrencyDecisionForRound,
  scheduleExecutionRuns,
  type CaseSuiteDetails,
  type RunBatch,
  type RunBatchDetails,
  type RunnerCompatibilityIssue,
  type SchedulingDecision,
  type SchedulingEventType,
  type SchedulingPlan,
  type SchedulingThresholds,
} from "@autoforge/domain";

import type {
  CaseSuiteRepository,
  CaseCatalogRepository,
  Clock,
  IdGenerator,
  JarObjectStorePort,
  ProjectStructureRepository,
  RunBatchRepository,
  RunnerGroupRepository,
  RunnerRepository,
  SchedulingSnapshot,
} from "./ports";
import { CoalescedOperation } from "./coalesced-operation";

const OFFLINE_AFTER_SECONDS = 45;
const RUNNER_METRICS_THROTTLE_MS = 30_000;
const MAXIMUM_SCHEDULING_WINDOW = 4_096;

export class RunBatchSchedulingService {
  // runner_metrics 节流：记录每个 runner 最近一次写入资源快照事件的时间。
  private readonly lastRunnerMetricsAt = new Map<string, Date>();
  private readonly schedulingInFlight = new Map<
    string,
    CoalescedOperation<{ batch: RunBatch; reserved: number }>
  >();

  constructor(
    private readonly batches: RunBatchRepository,
    private readonly suites: CaseSuiteRepository,
    private readonly runners: RunnerRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly thresholds: SchedulingThresholds,
    private readonly metricsMaximumAgeSeconds: number,
    private readonly executionInputs?: {
      catalog: CaseCatalogRepository;
      objectStore: JarObjectStorePort;
    },
    private readonly projectMaximumConcurrency = 128,
    private readonly priorityAgingIntervalMinutes = 5,
    private readonly projectStructures?: ProjectStructureRepository,
    private readonly runnerGroups?: RunnerGroupRepository,
    private readonly caseExecutionTimeoutMs = DEFAULT_CASE_EXECUTION_TIMEOUT_SECONDS * 1_000,
    private readonly artifactCollectionEnabled = true,
  ) {}

  async create(input: CreateRunBatchInput): Promise<RunBatch> {
    const validated = createRunBatchInputSchema.parse(input);
    const suite = await this.suites.get(validated.suiteId);
    const preflight = await this.preflightValidated(validated, { suite });
    if (!preflight.ready) {
      throw new DomainError("RUN_BATCH_PREFLIGHT_FAILED", "执行配置预检未通过。", {
        details: preflight,
      });
    }
    if (!suite) throw new DomainError("CASE_SUITE_NOT_FOUND", "指定的用例任务不存在。");
    if (suite.status === "archived") {
      throw new DomainError("CASE_SUITE_ARCHIVED", "已归档的用例任务不能创建新批次。");
    }
    if (!suite.enabled) {
      throw new DomainError("CASE_SUITE_DISABLED", "已停用的用例任务不能创建新批次。");
    }
    const enabledCases = suite.items.filter((item) => item.caseDefinition.enabled);
    if (enabledCases.length === 0) {
      throw new DomainError("RUN_BATCH_EMPTY", "用例任务中没有可执行的启用用例。");
    }
    // 任务执行只读取任务的版本化策略快照。顶栏快捷执行不得制造一份易漂移的第二配置源。
    const suitePolicy = suite.policy;
    const roundRecoveryRules = suitePolicy.roundRecoveryRules ?? [];
    const roundRecoveryCredentials =
      roundRecoveryRules.length === 0
        ? {}
        : await this.suites.getRoundRecoveryCredentials(
            suite.id,
            roundRecoveryRules.map((rule) => rule.id),
          );
    const missingRecoveryCredential = roundRecoveryRules.find(
      (rule) => !roundRecoveryCredentials[rule.id],
    );
    if (missingRecoveryCredential) {
      throw new DomainError(
        "JENKINS_CREDENTIAL_REQUIRED",
        `第 ${missingRecoveryCredential.afterRound} 轮后的 Jenkins 环境恢复缺少 API 密钥。`,
      );
    }
    const runnerIds = await this.resolveRunnerSelection(suitePolicy);
    const projectId = suite.projectId;
    await this.ensureRunnersExist(runnerIds, [
      ...(usesTaskAdapter(suitePolicy.adapter) ? [COTEST_ADAPTER_CAPABILITY] : []),
      ...(suitePolicy.executor === "testng-container" ? ["executor:testng-container-v1"] : []),
    ]);
    const createdAt = this.clock.now().toISOString();
    const scheduledFor = delayedStart(createdAt, validated.delaySeconds);
    const batchId = this.ids.next();
    const dispatchJob = {
      schemaVersion: 1 as const,
      messageId: this.ids.next(),
      runId: batchId,
      attempt: 1,
      createdAt,
      priority: suitePolicy.priority,
      deduplicationKey: `dispatch-batch:${batchId}:1`,
      kind: "dispatch-run" as const,
      payload: { batchId },
    };
    await this.batches.create({
      id: batchId,
      projectId,
      eventId: this.ids.next(),
      suiteId: suite.id,
      suiteName: suite.name,
      suiteVersion: suite.version,
      retryLimit: suitePolicy.retryLimit,
      retryMode: suitePolicy.retryMode,
      priority: suitePolicy.priority,
      queueTimeoutMs: suitePolicy.queueTimeoutMs,
      claimTimeoutMs: suitePolicy.claimTimeoutMs,
      executionTimeoutMs: this.caseExecutionTimeoutMs,
      uploadTimeoutMs: suitePolicy.uploadTimeoutMs,
      environmentVariables: [],
      secretBindings: [],
      runnerIds,
      policy: {
        executor: suitePolicy.executor,
        concurrency: suitePolicy.concurrency,
        ...(suitePolicy.projectVersionId ? { projectVersionId: suitePolicy.projectVersionId } : {}),
        runnerLabels: [...suitePolicy.runnerLabels],
        artifactPatterns: this.artifactCollectionEnabled ? [...suitePolicy.artifactPatterns] : [],
        retryConcurrencyRules: (suitePolicy.retryConcurrencyRules ?? []).map((rule) => ({
          ...rule,
        })),
      },
      roundRecoveries: roundRecoveryRules.map((rule) => ({
        ruleId: rule.id,
        afterRound: rule.afterRound,
        jenkinsJobUrl: rule.jenkinsJobUrl,
        apiKeyCiphertext: roundRecoveryCredentials[rule.id]!,
        waitMinutes: rule.waitMinutes,
      })),
      adapter: {
        enabled: suitePolicy.adapter.enabled,
        suiteName: suitePolicy.adapter.suiteName,
        testName: suitePolicy.adapter.testName,
        environmentAddresses: [...suitePolicy.adapter.environmentAddresses],
      },
      runs: enabledCases.map((item) => ({
        id: this.ids.next(),
        caseDefinitionId: item.caseDefinition.id,
        caseVersion: item.caseDefinition.currentVersion,
        displayName: item.caseDefinition.displayName,
        className: item.caseDefinition.className,
        parameters: { ...item.caseDefinition.parameters },
      })),
      dispatchJob,
      scheduledFor,
      createdAt,
    });
    return this.schedule(batchId);
  }

  async createSingleCase(
    caseDefinitionId: string,
    input: CreateSingleCaseRunInput,
  ): Promise<RunBatch> {
    if (!this.executionInputs) {
      throw new DomainError("SINGLE_CASE_EXECUTION_UNAVAILABLE", "当前运行时未配置用例输入仓储。");
    }
    const validated = createSingleCaseRunInputSchema.parse(input);
    const projectId = validated.projectId ?? DEFAULT_PROJECT_ID;
    const definition = await this.executionInputs.catalog.getCaseDefinition(caseDefinitionId, [
      projectId,
    ]);
    if (!definition || definition.archived) {
      throw new DomainError(
        "CASE_DEFINITION_NOT_FOUND",
        "指定用例不存在、已归档或不属于当前项目。",
      );
    }
    if (!definition.enabled || !definition.methods.some((method) => method.enabled)) {
      throw new DomainError("CASE_DEFINITION_DISABLED", "已停用或没有启用方法的用例不能执行。");
    }
    const sourceRecord = await this.executionInputs.catalog.getSource(definition.sourceId);
    const source = sourceRecord?.source;
    if (sourceRecord?.inspection.executable === false) {
      throw new DomainError(
        "CASE_SOURCE_NOT_EXECUTABLE",
        "该用例来自 sources JAR，仅支持查看源码；请导入包含 .class 的测试 JAR 后执行。",
      );
    }
    if (
      !source ||
      source.projectId !== projectId ||
      source.status !== "ready" ||
      source.lifecycleStatus !== "active" ||
      !(await this.executionInputs.objectStore.exists(source.objectKey))
    ) {
      throw new DomainError("EXECUTION_INPUT_UNAVAILABLE", "用例的权威 JAR 输入不可用。");
    }
    if (!definition.projectVersionId) {
      throw new DomainError("CASE_VERSION_REQUIRED", "历史用例尚未关联项目版本，不能直接执行。");
    }
    if (this.projectStructures) {
      const structure = await this.projectStructures.list(projectId);
      const projectVersion = structure.versions.find(
        (version) => version.id === definition.projectVersionId,
      );
      if (!projectVersion || projectVersion.status !== "active") {
        throw new DomainError(
          "CASE_VERSION_UNAVAILABLE",
          "用例关联的项目版本不存在或已归档，不能执行。",
        );
      }
    }
    const runnerIds = await this.resolveRunnerSelection(validated);
    const adapterBlockers: RunBatchPreflightBlocker[] = [];
    if (usesTaskAdapter(validated.adapter)) {
      await this.inspectAdapterRuntime(projectId, adapterBlockers, definition.projectVersionId);
    }
    if (adapterBlockers.length > 0) {
      throw new DomainError("RUN_BATCH_PREFLIGHT_FAILED", "执行配置预检未通过。", {
        details: { ready: false, blockers: adapterBlockers },
      });
    }
    await this.ensureRunnersExist(runnerIds, [
      ...(usesTaskAdapter(validated.adapter) ? [COTEST_ADAPTER_CAPABILITY] : []),
    ]);
    const createdAt = this.clock.now().toISOString();
    const scheduledFor = delayedStart(createdAt, validated.delaySeconds);
    const batchId = this.ids.next();
    const priority = validated.priority ?? defaultCaseSuiteExecutionPolicy.priority;
    const dispatchJob = {
      schemaVersion: 1 as const,
      messageId: this.ids.next(),
      runId: batchId,
      attempt: 1,
      createdAt,
      priority,
      deduplicationKey: `dispatch-batch:${batchId}:1`,
      kind: "dispatch-run" as const,
      payload: { batchId },
    };
    await this.batches.create({
      id: batchId,
      projectId,
      eventId: this.ids.next(),
      suiteId: `single:${definition.id}`,
      suiteName: `单用例 · ${definition.displayName}`,
      suiteVersion: definition.currentVersion,
      retryLimit: validated.retryLimit ?? defaultCaseSuiteExecutionPolicy.retryLimit,
      retryMode: validated.retryMode ?? defaultCaseSuiteExecutionPolicy.retryMode,
      priority,
      queueTimeoutMs: validated.queueTimeoutMs ?? defaultCaseSuiteExecutionPolicy.queueTimeoutMs,
      claimTimeoutMs: validated.claimTimeoutMs,
      executionTimeoutMs: this.caseExecutionTimeoutMs,
      uploadTimeoutMs: validated.uploadTimeoutMs,
      environmentVariables: [],
      secretBindings: [],
      runnerIds,
      policy: {
        executor: "testng",
        concurrency: 1,
        ...(definition.projectVersionId ? { projectVersionId: definition.projectVersionId } : {}),
        runnerLabels: [],
        artifactPatterns: this.artifactCollectionEnabled
          ? validated.artifactPatterns.length > 0
            ? [...validated.artifactPatterns]
            : [...defaultCaseSuiteExecutionPolicy.artifactPatterns]
          : [],
        retryConcurrencyRules: [],
      },
      adapter: {
        enabled: validated.adapter.enabled,
        suiteName: validated.adapter.suiteName,
        testName: validated.adapter.testName,
        environmentAddresses: [...validated.adapter.environmentAddresses],
      },
      runs: [
        {
          id: this.ids.next(),
          caseDefinitionId: definition.id,
          caseVersion: definition.currentVersion,
          displayName: definition.displayName,
          className: definition.className,
          parameters: { ...definition.parameters },
        },
      ],
      dispatchJob,
      scheduledFor,
      createdAt,
    });
    return this.schedule(batchId);
  }

  async preflight(input: unknown): Promise<RunBatchPreflightResult> {
    const parsed = createRunBatchInputSchema.safeParse(input);
    if (!parsed.success) {
      const blockers = parsed.error.issues.map((issue) =>
        validationBlocker(
          issue.path.filter((segment): segment is string | number =>
            ["string", "number"].includes(typeof segment),
          ),
          issue.message,
        ),
      );
      return { ready: false, blockers };
    }
    return this.preflightValidated(parsed.data);
  }

  async list(limit = 100, projectIds?: readonly string[], projectVersionId?: string) {
    return this.batches.list(limit, projectIds, projectVersionId);
  }

  async listPage(input: import("./ports").RunBatchListQuery) {
    return this.batches.listPage(input);
  }

  async get(batchId: string, projectIds?: readonly string[]): Promise<RunBatchDetails> {
    const batch = await this.batches.get(batchId, projectIds);
    if (!batch) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
    return batch;
  }

  async getSummary(batchId: string, projectIds?: readonly string[]): Promise<RunBatch> {
    const batch = await this.batches.getSummary(batchId, projectIds);
    if (!batch) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
    return batch;
  }

  async schedule(batchId: string): Promise<RunBatch> {
    return (await this.scheduleWithCount(batchId)).batch;
  }

  private async scheduleWithCount(batchId: string): Promise<{ batch: RunBatch; reserved: number }> {
    const existing = this.schedulingInFlight.get(batchId);
    if (existing) return existing.requestAnotherPass();
    const scheduling = new CoalescedOperation(() => this.scheduleBatch(batchId));
    this.schedulingInFlight.set(batchId, scheduling);
    try {
      return await scheduling.result;
    } finally {
      if (this.schedulingInFlight.get(batchId) === scheduling) {
        this.schedulingInFlight.delete(batchId);
      }
    }
  }

  private async scheduleBatch(batchId: string): Promise<{ batch: RunBatch; reserved: number }> {
    const now = this.clock.now();
    let reserved = 0;
    const snapshot = await this.batches.getSchedulingSnapshot(
      batchId,
      offlineBefore(now),
      Math.min(MAXIMUM_SCHEDULING_WINDOW, this.projectMaximumConcurrency),
    );
    if (!snapshot) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
    // 队列/outbox 的 availableAt 是第一道门；此处是权威防线，避免恢复、Runner
    // 生命周期或直接 API 调度绕过延时。
    if (Date.parse(snapshot.batch.scheduledFor) > now.getTime()) {
      return { batch: snapshot.batch, reserved: 0 };
    }
    if (snapshot.queuedRuns.length > 0) {
      // 批次策略的并发上限按在途（assigned+running）run 数扣减；assignedRuns 已包含 running。
      let effectiveBatchConcurrency = snapshot.batch.policy?.concurrency;
      if (snapshot.batch.policy) {
        const retryContext = snapshot.retryContext ?? {
          executionRound: snapshot.batch.currentRound,
          previousRoundPassRate: null,
          remainingRuns: snapshot.batch.queuedRuns + snapshot.batch.assignedRuns,
        };
        const decision = retryConcurrencyDecisionForRound(
          snapshot.batch.policy.concurrency,
          snapshot.batch.policy.retryConcurrencyRules ?? [],
          retryContext,
          snapshot.retryConcurrencyState,
        );
        if (decision.transition) {
          const activated = await this.batches.activateRetryConcurrency({
            batchId,
            executionRound: retryContext.executionRound,
            expectedRuleId: snapshot.retryConcurrencyState?.ruleId ?? null,
            state: decision.transition,
            updatedAt: now.toISOString(),
          });
          // 轮次已被其他完成/恢复事务推进时丢弃旧快照，等待下一次调度读取新上下文。
          if (!activated) {
            const batch = await this.batches.getSummary(batchId);
            if (!batch) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
            return { batch, reserved: 0 };
          }
          effectiveBatchConcurrency = activated.concurrency;
        } else {
          effectiveBatchConcurrency = decision.concurrency;
        }
      }
      const suiteMaximumAssignments =
        effectiveBatchConcurrency === undefined
          ? undefined
          : Math.max(0, effectiveBatchConcurrency - snapshot.batch.assignedRuns);
      const projectMaximumAssignments = Math.max(
        0,
        this.projectMaximumConcurrency - snapshot.projectActiveRuns,
      );
      const maxAssignments =
        suiteMaximumAssignments === undefined
          ? projectMaximumAssignments
          : Math.min(suiteMaximumAssignments, projectMaximumAssignments);
      const plan = scheduleExecutionRuns({
        runs: snapshot.queuedRuns,
        candidates: snapshot.candidates.filter(
          ({ runner }) =>
            snapshot.batch.policy?.executor !== "testng-container" ||
            runner.capabilities.includes("executor:testng-container-v1"),
        ),
        thresholds: this.thresholds,
        metricsFreshAfter: metricsFreshAfter(now, this.metricsMaximumAgeSeconds),
        excludedRunnerIdsByRun: new Map(
          Object.entries(snapshot.runnerFailureIdsByRun ?? {}).map(([runId, runnerIds]) => [
            runId,
            new Set(runnerIds),
          ]),
        ),
        maxAssignments,
      });
      if (plan.decisions.length > 0) {
        const decisions = plan.decisions.map((decision) => ({
          ...decision,
          attemptId: this.ids.next(),
          assignmentId: this.ids.next(),
        }));
        reserved = await this.batches.reserveAssignments({
          batchId,
          eventId: this.ids.next(),
          projectMaximumConcurrency: this.projectMaximumConcurrency,
          decisions,
          thresholds: this.thresholds,
          offlineBefore: offlineBefore(now),
          metricsFreshAfter: metricsFreshAfter(now, this.metricsMaximumAgeSeconds),
          scheduledAt: now.toISOString(),
        });
        await this.appendSchedulingRoundEvents(batchId, snapshot, plan, decisions, reserved, now);
      }
    }
    const batch = await this.batches.getSummary(batchId);
    if (!batch) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
    return { batch, reserved };
  }

  async listSchedulingEvents(
    batchId: string,
    input: { runnerId?: string; afterId?: string; limit: number },
  ) {
    await this.get(batchId);
    return this.batches.listSchedulingEvents({ batchId, ...input });
  }

  // 记录一轮调度产生的事件。事件写入不捕获异常：应用层没有日志端口，
  // 失败由调用方（HTTP 入口/工作器）按错误处理，避免静默丢失审计数据。
  private async appendSchedulingRoundEvents(
    batchId: string,
    snapshot: SchedulingSnapshot,
    plan: SchedulingPlan,
    decisions: Array<SchedulingDecision & { attemptId: string; assignmentId: string }>,
    reserved: number,
    now: Date,
  ): Promise<void> {
    const recordedAt = now.toISOString();
    const displayNameByRunId = new Map(snapshot.queuedRuns.map((run) => [run.id, run.displayName]));
    const events: Array<{
      id: string;
      batchId: string;
      runnerId?: string;
      executionRunId?: string;
      attemptId?: string;
      eventType: SchedulingEventType;
      message: string;
      payload?: Record<string, unknown>;
      recordedAt: string;
    }> = [];
    for (const decision of decisions) {
      const displayName =
        displayNameByRunId.get(decision.executionRunId) ?? decision.executionRunId;
      events.push({
        id: this.ids.next(),
        batchId,
        runnerId: decision.runnerId,
        executionRunId: decision.executionRunId,
        attemptId: decision.attemptId,
        eventType: "run_assigned",
        message: `调度器将用例「${displayName}」分配给执行机 ${decision.runnerId}（得分 ${decision.score.toFixed(2)}）`,
        recordedAt,
      });
    }
    const queueRemaining = Math.max(0, snapshot.queuedRuns.length - reserved);
    events.push({
      id: this.ids.next(),
      batchId,
      eventType: "batch_scheduled",
      message: `本轮调度分配 ${reserved} 个用例，队列剩余 ${queueRemaining} 个`,
      payload: { assignedCount: reserved, queueRemaining, decisions: reserved },
      recordedAt,
    });
    // runner_metrics 按 runner 节流：同一执行机 30 秒内只记录一条资源快照。
    const seenRunners = new Set<string>();
    for (const decision of decisions) {
      if (seenRunners.has(decision.runnerId)) continue;
      seenRunners.add(decision.runnerId);
      const lastAt = this.lastRunnerMetricsAt.get(decision.runnerId);
      if (lastAt !== undefined && now.getTime() - lastAt.getTime() < RUNNER_METRICS_THROTTLE_MS) {
        continue;
      }
      const evaluation = plan.evaluations.find(
        (candidate) => candidate.runnerId === decision.runnerId,
      );
      const availableSlots = evaluation?.availableSlots ?? 0;
      events.push({
        id: this.ids.next(),
        batchId,
        runnerId: decision.runnerId,
        eventType: "runner_metrics",
        message: `执行机 ${decision.runnerId} 资源快照：可用槽位 ${availableSlots}`,
        payload: {
          availableSlots,
          ...(evaluation?.score !== undefined ? { score: evaluation.score } : {}),
          blockReasons: evaluation?.blockReasons ?? [],
        },
        recordedAt,
      });
      this.lastRunnerMetricsAt.set(decision.runnerId, now);
    }
    await this.batches.appendSchedulingEvents(events);
  }

  async scheduleQueuedBatches(limit = 50): Promise<number> {
    const batchIds = await this.batches.listSchedulableBatchIds(
      limit,
      this.clock.now().toISOString(),
      this.priorityAgingIntervalMinutes,
    );
    return this.scheduleBatchIds(batchIds);
  }

  async scheduleForRunner(runnerId: string, limit = 8): Promise<number> {
    const batchIds = await this.batches.listSchedulableBatchIdsForRunner(
      runnerId,
      limit,
      this.clock.now().toISOString(),
      this.priorityAgingIntervalMinutes,
    );
    return this.scheduleBatchIds(batchIds);
  }

  private async scheduleBatchIds(batchIds: string[]): Promise<number> {
    let scheduled = 0;
    for (const batchId of batchIds) {
      scheduled += (await this.scheduleWithCount(batchId)).reserved;
    }
    return scheduled;
  }

  private async preflightValidated(
    input: ReturnType<typeof createRunBatchInputSchema.parse>,
    loaded?: { suite: Awaited<ReturnType<CaseSuiteRepository["get"]>> },
  ): Promise<RunBatchPreflightResult> {
    const blockers: RunBatchPreflightBlocker[] = [];
    const suite = loaded ? loaded.suite : await this.suites.get(input.suiteId);
    if (!suite) {
      blockers.push(
        blocker("CASE_SUITE_NOT_FOUND", "parameter", "指定的用例任务不存在。", {
          path: ["suiteId"],
        }),
      );
    } else if (suite.status === "archived") {
      blockers.push(
        blocker("CASE_SUITE_ARCHIVED", "parameter", "已归档的用例任务不能创建新批次。", {
          path: ["suiteId"],
        }),
      );
    } else if (!suite.enabled) {
      blockers.push(
        blocker("CASE_SUITE_DISABLED", "parameter", "已停用的用例任务不能创建新批次。", {
          path: ["suiteId"],
        }),
      );
    } else {
      const enabledCases = suite.items.filter((item) => item.caseDefinition.enabled);
      await this.inspectSuiteVersion(suite, enabledCases, blockers);
      if (enabledCases.length === 0) {
        blockers.push(
          blocker("RUN_BATCH_EMPTY", "parameter", "用例任务中没有可执行的启用用例。", {
            path: ["suiteId"],
          }),
        );
      } else {
        await this.inspectExecutionInputs(enabledCases, blockers);
      }
      if (usesTaskAdapter(suite.policy.adapter)) {
        await this.inspectAdapterRuntime(suite.projectId, blockers, suite.policy.projectVersionId);
      }
    }
    const runnerIds = await this.resolveRunnerSelectionForPreflight(suite?.policy, blockers);
    await this.inspectRunners(
      runnerIds,
      blockers,
      suite?.policy.runnerLabels ?? [],
      suite?.policy.executor ?? "testng",
      suite ? usesTaskAdapter(suite.policy.adapter) : false,
    );
    return { ready: blockers.length === 0, blockers };
  }

  private async inspectSuiteVersion(
    suite: CaseSuiteDetails,
    enabledCases: CaseSuiteDetails["items"],
    blockers: RunBatchPreflightBlocker[],
  ): Promise<void> {
    const projectVersionId = suite.policy.projectVersionId;
    if (!projectVersionId) {
      blockers.push(
        blocker(
          "CASE_SUITE_VERSION_REQUIRED",
          "parameter",
          "历史任务尚未关联项目版本，请先在任务设置中选择版本。",
          { path: ["suiteId"] },
        ),
      );
      return;
    }
    if (enabledCases.some((item) => item.caseDefinition.projectVersionId !== projectVersionId)) {
      blockers.push(
        blocker(
          "CASE_SUITE_VERSION_MISMATCH",
          "input",
          "任务中包含其他项目版本的用例，请重新整理任务成员。",
          { path: ["suiteId"] },
        ),
      );
    }
    if (!this.projectStructures) return;
    const structure = await this.projectStructures.list(suite.projectId);
    const version = structure.versions.find((entry) => entry.id === projectVersionId);
    if (!version || version.status !== "active") {
      blockers.push(
        blocker(
          "CASE_SUITE_VERSION_UNAVAILABLE",
          "input",
          "任务关联的项目版本不存在或已归档，不能执行。",
          { path: ["suiteId"] },
        ),
      );
    }
  }

  private async inspectAdapterRuntime(
    projectId: string,
    blockers: RunBatchPreflightBlocker[],
    projectVersionId?: string,
  ): Promise<void> {
    if (!this.projectStructures) {
      blockers.push(
        blocker(
          "ADAPTER_RUNTIME_PREFLIGHT_UNAVAILABLE",
          "input",
          "当前运行时未配置 Adapter 依赖资源预检端口。",
        ),
      );
      return;
    }
    const configuration = await this.projectStructures.getAdapterConfiguration(
      projectId,
      projectVersionId,
    );
    const bundle = configuration.jarBundleAsset;
    if (!bundle) {
      blockers.push(
        blocker(
          "ADAPTER_DEPENDENCY_ARCHIVE_MISSING",
          "input",
          "任务已启用 CoTest Adapter，但项目尚未配置完整依赖 JAR 压缩包。",
        ),
      );
      return;
    }
    if (bundle.sourceType !== "upload" || !bundle.objectKey || !this.executionInputs) return;
    try {
      if (!(await this.executionInputs.objectStore.exists(bundle.objectKey))) {
        blockers.push(
          blocker(
            "ADAPTER_DEPENDENCY_ARCHIVE_OBJECT_MISSING",
            "input",
            "项目配置的依赖 JAR 压缩包对象不存在，请重新上传。",
          ),
        );
      }
    } catch {
      blockers.push(
        blocker(
          "ADAPTER_DEPENDENCY_ARCHIVE_CHECK_FAILED",
          "input",
          "暂时无法核验依赖 JAR 压缩包，请稍后重试。",
        ),
      );
    }
  }

  private async inspectRunners(
    runnerIds: readonly string[],
    blockers: RunBatchPreflightBlocker[],
    policyLabels: readonly string[] = [],
    executor: "testng" | "testng-container" = "testng",
    requiresAdapter = false,
  ): Promise<void> {
    const offlineCutoff = offlineBefore(this.clock.now());
    for (const runnerId of runnerIds) {
      const runner = await this.runners.get(runnerId, offlineCutoff);
      if (!runner) {
        blockers.push(blocker("RUNNER_NOT_FOUND", "runner", "指定的执行机不存在。", { runnerId }));
        continue;
      }
      if (runner.state === "disabled") {
        blockers.push(
          blocker("RUNNER_DISABLED", "runner", "已禁用的执行机不能加入执行批次。", {
            runnerId,
          }),
        );
      }
      const compatibility = assessRunnerCompatibility(runner);
      for (const issue of compatibility.issues) {
        const mapped = compatibilityBlocker(issue, runnerId);
        if (mapped) blockers.push(mapped);
      }
      for (const label of [...REQUIRED_EXECUTION_LABELS, ...policyLabels]) {
        if (!runner.labels.includes(label)) {
          blockers.push(
            blocker("RUNNER_REQUIRED_LABEL_MISSING", "runner", `执行机缺少必需标签 ${label}。`, {
              runnerId,
            }),
          );
        }
      }
      if (
        executor === "testng-container" &&
        !runner.capabilities.includes("executor:testng-container-v1")
      ) {
        blockers.push(
          blocker(
            "RUNNER_CONTAINER_CAPABILITY_MISSING",
            "runner",
            "执行机未配置离线 container 执行器。",
            { runnerId },
          ),
        );
      }
      if (requiresAdapter && !runner.capabilities.includes(COTEST_ADAPTER_CAPABILITY)) {
        blockers.push(
          blocker(
            "RUNNER_ADAPTER_CAPABILITY_MISSING",
            "toolchain",
            "执行机未安装任务所需的 CoTest Adapter；请重新下发 Runner。",
            { runnerId },
          ),
        );
      }
    }
  }

  private async inspectExecutionInputs(
    items: Array<{ caseDefinition: { id: string; sourceId: string } }>,
    blockers: RunBatchPreflightBlocker[],
  ): Promise<void> {
    if (!this.executionInputs) {
      blockers.push(
        blocker(
          "EXECUTION_INPUT_PREFLIGHT_UNAVAILABLE",
          "input",
          "当前运行时未配置权威 JAR 预检端口。",
        ),
      );
      return;
    }
    const casesBySource = new Map<string, string[]>();
    for (const item of items) {
      const caseIds = casesBySource.get(item.caseDefinition.sourceId) ?? [];
      caseIds.push(item.caseDefinition.id);
      casesBySource.set(item.caseDefinition.sourceId, caseIds);
    }
    for (const [sourceId, caseDefinitionIds] of casesBySource) {
      const resolved = await this.executionInputs.catalog.getSource(sourceId);
      const caseDefinitionId = caseDefinitionIds[0];
      if (!resolved) {
        blockers.push(
          blocker("CASE_SOURCE_NOT_FOUND", "input", "用例引用的 JAR 来源不存在。", {
            sourceId,
            ...(caseDefinitionId ? { caseDefinitionId } : {}),
          }),
        );
        continue;
      }
      const source = resolved.source;
      if (resolved.inspection.executable === false) {
        blockers.push(
          blocker(
            "CASE_SOURCE_NOT_EXECUTABLE",
            "input",
            "用例来自 sources JAR，仅支持查看源码，不能作为 Agent 的执行输入。",
            {
              sourceId,
              ...(caseDefinitionId ? { caseDefinitionId } : {}),
            },
          ),
        );
      }
      if (source.status !== "ready") {
        blockers.push(
          blocker("CASE_SOURCE_NOT_READY", "input", "用例来源 JAR 尚未准备完成。", {
            sourceId,
            ...(caseDefinitionId ? { caseDefinitionId } : {}),
          }),
        );
      }
      if (!/^[a-f0-9]{64}$/.test(source.sha256) || source.sizeBytes <= 0) {
        blockers.push(
          blocker("CASE_SOURCE_METADATA_INVALID", "input", "用例来源 JAR 元数据无效。", {
            sourceId,
            ...(caseDefinitionId ? { caseDefinitionId } : {}),
          }),
        );
      }
      if (source.sizeBytes > DEFAULT_EXECUTION_RESOURCE_LIMITS.diskBytes) {
        blockers.push(
          blocker(
            "EXECUTION_INPUT_DISK_LIMIT_EXCEEDED",
            "resource",
            "用例来源 JAR 大小超过 attempt 磁盘限制。",
            {
              sourceId,
              ...(caseDefinitionId ? { caseDefinitionId } : {}),
            },
          ),
        );
      }
      try {
        if (!(await this.executionInputs.objectStore.exists(source.objectKey))) {
          blockers.push(
            blocker("CASE_SOURCE_OBJECT_MISSING", "input", "用例来源 JAR 对象不存在。", {
              sourceId,
              ...(caseDefinitionId ? { caseDefinitionId } : {}),
            }),
          );
        }
      } catch {
        blockers.push(
          blocker("CASE_SOURCE_OBJECT_UNAVAILABLE", "input", "无法确认用例来源 JAR 对象。", {
            sourceId,
            ...(caseDefinitionId ? { caseDefinitionId } : {}),
          }),
        );
      }
    }
  }

  policy(): SchedulingThresholds & { metricsMaximumAgeSeconds: number } {
    return { ...this.thresholds, metricsMaximumAgeSeconds: this.metricsMaximumAgeSeconds };
  }

  private async ensureRunnersExist(
    runnerIds: string[],
    additionalCapabilities: readonly string[],
  ): Promise<void> {
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
    if (resolved.some((runner) => runner && !assessRunnerCompatibility(runner).compatible)) {
      throw new DomainError(
        "RUNNER_INCOMPATIBLE",
        "所选执行机中包含协议、平台或执行能力不兼容的节点。",
      );
    }
    if (
      resolved.some((runner) =>
        additionalCapabilities.some(
          (capability) => runner && !runner.capabilities.includes(capability),
        ),
      )
    ) {
      throw new DomainError("RUNNER_INCOMPATIBLE", "所选执行机缺少本次执行要求的能力。");
    }
  }

  private async resolveRunnerSelection(input: {
    runnerIds: readonly string[];
    runnerGroupId?: string | undefined;
  }): Promise<string[]> {
    const hasDirectSelection = input.runnerIds.length > 0;
    const hasGroupSelection = Boolean(input.runnerGroupId);
    if (hasDirectSelection === hasGroupSelection) {
      throw new DomainError(
        hasDirectSelection ? "RUNNER_SELECTION_CONFLICT" : "RUNNER_SELECTION_REQUIRED",
        hasDirectSelection
          ? "用例任务只能选择执行机或执行机组中的一种。"
          : "用例任务尚未配置执行机或执行机组。",
      );
    }
    if (!input.runnerGroupId) return [...input.runnerIds].sort();
    if (!this.runnerGroups) {
      throw new DomainError("RUNNER_GROUP_UNAVAILABLE", "当前运行时未配置执行机组仓储。");
    }
    const group = await this.runnerGroups.get(input.runnerGroupId);
    if (!group) throw new DomainError("RUNNER_GROUP_NOT_FOUND", "指定的执行机组不存在。");
    if (group.runnerIds.length === 0) {
      throw new DomainError("RUNNER_GROUP_EMPTY", "指定的执行机组没有可用成员。");
    }
    return [...group.runnerIds].sort();
  }

  private async resolveRunnerSelectionForPreflight(
    input: { runnerIds: readonly string[]; runnerGroupId?: string | undefined } | undefined,
    blockers: RunBatchPreflightBlocker[],
  ): Promise<string[]> {
    if (!input) return [];
    try {
      return await this.resolveRunnerSelection(input);
    } catch (error) {
      const code = error instanceof DomainError ? error.code : "RUNNER_GROUP_UNAVAILABLE";
      const message = error instanceof Error ? error.message : "无法读取执行机组。";
      blockers.push(blocker(code, "runner", message, { path: ["runnerGroupId"] }));
      return [];
    }
  }
}

function delayedStart(createdAt: string, delaySeconds: number): string {
  return new Date(Date.parse(createdAt) + delaySeconds * 1_000).toISOString();
}
function usesTaskAdapter(
  adapter:
    | {
        enabled: boolean;
        suiteName: string;
        testName: string;
        environmentAddresses: readonly string[];
      }
    | undefined,
): boolean {
  return adapter?.enabled === true;
}

function blocker(
  code: string,
  category: RunBatchPreflightBlocker["category"],
  message: string,
  details: Omit<RunBatchPreflightBlocker, "code" | "category" | "message"> = {},
): RunBatchPreflightBlocker {
  return { code, category, message, ...details };
}

function validationBlocker(
  path: Array<string | number>,
  message: string,
): RunBatchPreflightBlocker {
  const root = path[0];
  if (root === "runnerIds") {
    return blocker("RUNNER_SELECTION_INVALID", "runner", message, { path });
  }
  if (typeof root === "string" && root.endsWith("TimeoutMs")) {
    return blocker("EXECUTION_RESOURCE_PARAMETER_INVALID", "resource", message, { path });
  }
  return blocker("EXECUTION_PARAMETER_INVALID", "parameter", message, { path });
}

function compatibilityBlocker(
  issue: RunnerCompatibilityIssue,
  runnerId: string,
): RunBatchPreflightBlocker | undefined {
  const messages: Partial<Record<RunnerCompatibilityIssue, string>> = {
    protocol_unsupported: "Runner Protocol 版本不受支持。",
    platform_unsupported: "Runner 操作系统或架构不受支持。",
    testng_executor_missing: "Runner 缺少 TestNG 执行 capability。",
    // resource_isolation_missing 刻意不映射为 blocker：cgroup v2 缺失时 Agent 回退到
    // rlimit + 进程组清理的降级隔离（见 docs/architecture/runner-agent.md），执行不阻断。
    java_version_unknown: "Runner 未上报 Java 工具链版本。",
    java_version_unsupported: "Runner Java 版本低于执行基线。",
    testng_version_unknown: "Runner 未上报 TestNG 工具链版本。",
    testng_version_unsupported: "Runner TestNG 版本与执行基线不一致。",
  };
  const message = messages[issue];
  if (!message) return undefined;
  const category =
    issue.startsWith("java_") || issue.startsWith("testng_version_") ? "toolchain" : "runner";
  return blocker(`RUNNER_${issue.toUpperCase()}`, category, message, { runnerId });
}

function offlineBefore(now: Date): string {
  return new Date(now.getTime() - OFFLINE_AFTER_SECONDS * 1_000).toISOString();
}

function metricsFreshAfter(now: Date, maximumAgeSeconds: number): string {
  return new Date(now.getTime() - maximumAgeSeconds * 1_000).toISOString();
}
