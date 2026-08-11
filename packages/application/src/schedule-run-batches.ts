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
  DEFAULT_EXECUTION_RESOURCE_LIMITS,
  defaultCaseSuiteExecutionPolicy,
  DEFAULT_PROJECT_ID,
  DomainError,
  ON_DEMAND_SECRET_CAPABILITY,
  REQUIRED_EXECUTION_LABELS,
  scheduleExecutionRuns,
  type RunBatchDetails,
  type RunnerCompatibilityIssue,
  type SchedulingThresholds,
} from "@autoforge/domain";

import type {
  CaseSuiteRepository,
  CaseCatalogRepository,
  Clock,
  ExecutionEnvironmentRepository,
  IdGenerator,
  JarObjectStorePort,
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
    private readonly environments?: ExecutionEnvironmentRepository,
    private readonly executionInputs?: {
      catalog: CaseCatalogRepository;
      objectStore: JarObjectStorePort;
    },
    private readonly projectMaximumConcurrency = 128,
    private readonly priorityAgingIntervalMinutes = 5,
  ) {}

  async create(input: CreateRunBatchInput): Promise<RunBatchDetails> {
    const validated = createRunBatchInputSchema.parse(input);
    const preflight = await this.preflightValidated(validated);
    if (!preflight.ready) {
      throw new DomainError("RUN_BATCH_PREFLIGHT_FAILED", "执行配置预检未通过。", {
        details: preflight,
      });
    }
    const suite = await this.suites.get(validated.suiteId);
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
    // 执行配置按“输入 ?? 任务策略（已含系统默认）”合并，随后固化到批次。
    const suitePolicy = suite.policy;
    const retryLimit = validated.retryLimit ?? suitePolicy.retryLimit;
    const priority = validated.priority ?? suitePolicy.priority;
    const queueTimeoutMs = validated.queueTimeoutMs ?? suitePolicy.queueTimeoutMs;
    const executionTimeoutMs = validated.executionTimeoutMs ?? suitePolicy.executionTimeoutMs;
    const projectId = validated.projectId ?? DEFAULT_PROJECT_ID;
    const environment = await this.resolveEnvironmentSnapshot(
      projectId,
      validated.environmentVersionId,
      validated.environmentVariables,
    );
    await this.ensureRunnersExist(validated.runnerIds, [
      ...(environment.secretBindings.length > 0 ? [ON_DEMAND_SECRET_CAPABILITY] : []),
      ...(suitePolicy.executor === "testng-container" ? ["executor:testng-container-v1"] : []),
    ]);
    const createdAt = this.clock.now().toISOString();
    const batchId = this.ids.next();
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
      ...(environment.environmentId ? { environmentId: environment.environmentId } : {}),
      ...(environment.environmentVersionId
        ? { environmentVersionId: environment.environmentVersionId }
        : {}),
      eventId: this.ids.next(),
      suiteId: suite.id,
      suiteName: suite.name,
      suiteVersion: suite.version,
      retryLimit,
      priority,
      queueTimeoutMs,
      claimTimeoutMs: validated.claimTimeoutMs,
      executionTimeoutMs,
      uploadTimeoutMs: validated.uploadTimeoutMs,
      environmentVariables: environment.variables,
      secretBindings: environment.secretBindings,
      runnerIds: [...validated.runnerIds].sort(),
      policy: {
        executor: suitePolicy.executor,
        concurrency: suitePolicy.concurrency,
        runnerLabels: [...suitePolicy.runnerLabels],
        artifactPatterns: [...suitePolicy.artifactPatterns],
      },
      runs: enabledCases.map((item) => ({
        id: this.ids.next(),
        caseDefinitionId: item.caseDefinition.id,
        caseVersion: item.caseDefinition.currentVersion,
        displayName: item.caseDefinition.displayName,
        className: item.caseDefinition.className,
        parameters: { ...suitePolicy.parameters, ...item.caseDefinition.parameters },
      })),
      dispatchJob,
      createdAt,
    });
    return this.schedule(batchId);
  }

  async createSingleCase(
    caseDefinitionId: string,
    input: CreateSingleCaseRunInput,
  ): Promise<RunBatchDetails> {
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
    if (
      !source ||
      source.projectId !== projectId ||
      source.status !== "ready" ||
      source.lifecycleStatus !== "active" ||
      !(await this.executionInputs.objectStore.exists(source.objectKey))
    ) {
      throw new DomainError("EXECUTION_INPUT_UNAVAILABLE", "用例的权威 JAR 输入不可用。");
    }
    const environment = await this.resolveEnvironmentSnapshot(
      projectId,
      validated.environmentVersionId,
      validated.environmentVariables,
    );
    await this.ensureRunnersExist(
      validated.runnerIds,
      environment.secretBindings.length > 0 ? [ON_DEMAND_SECRET_CAPABILITY] : [],
    );
    const createdAt = this.clock.now().toISOString();
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
      ...(environment.environmentId ? { environmentId: environment.environmentId } : {}),
      ...(environment.environmentVersionId
        ? { environmentVersionId: environment.environmentVersionId }
        : {}),
      eventId: this.ids.next(),
      suiteId: `single:${definition.id}`,
      suiteName: `单用例 · ${definition.displayName}`,
      suiteVersion: definition.currentVersion,
      retryLimit: validated.retryLimit ?? defaultCaseSuiteExecutionPolicy.retryLimit,
      priority,
      queueTimeoutMs: validated.queueTimeoutMs ?? defaultCaseSuiteExecutionPolicy.queueTimeoutMs,
      claimTimeoutMs: validated.claimTimeoutMs,
      executionTimeoutMs:
        validated.executionTimeoutMs ?? defaultCaseSuiteExecutionPolicy.executionTimeoutMs,
      uploadTimeoutMs: validated.uploadTimeoutMs,
      environmentVariables: environment.variables,
      secretBindings: environment.secretBindings,
      runnerIds: [...validated.runnerIds].sort(),
      policy: {
        executor: "testng",
        concurrency: 1,
        runnerLabels: [],
        artifactPatterns:
          validated.artifactPatterns.length > 0
            ? [...validated.artifactPatterns]
            : [...defaultCaseSuiteExecutionPolicy.artifactPatterns],
      },
      runs: [
        {
          id: this.ids.next(),
          caseDefinitionId: definition.id,
          caseVersion: definition.currentVersion,
          displayName: definition.displayName,
          className: definition.className,
          parameters: { ...definition.parameters, ...validated.parameters },
        },
      ],
      dispatchJob,
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

  async list(limit = 100, projectIds?: readonly string[]) {
    return this.batches.list(limit, projectIds);
  }

  async listPage(input: import("./ports").RunBatchListQuery) {
    return this.batches.listPage(input);
  }

  async get(batchId: string, projectIds?: readonly string[]): Promise<RunBatchDetails> {
    const batch = await this.batches.get(batchId, projectIds);
    if (!batch) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
    return batch;
  }

  async schedule(batchId: string): Promise<RunBatchDetails> {
    const now = this.clock.now();
    const snapshot = await this.batches.getSchedulingSnapshot(batchId, offlineBefore(now));
    if (!snapshot) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
    if (snapshot.queuedRuns.length > 0) {
      // 批次策略的并发上限按在途（assigned+running）run 数扣减；assignedRuns 已包含 running。
      const suiteMaximumAssignments = snapshot.batch.policy
        ? Math.max(0, snapshot.batch.policy.concurrency - snapshot.batch.assignedRuns)
        : undefined;
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
            (snapshot.batch.secretBindings.length === 0 ||
              runner.capabilities.includes(ON_DEMAND_SECRET_CAPABILITY)) &&
            (snapshot.batch.policy?.executor !== "testng-container" ||
              runner.capabilities.includes("executor:testng-container-v1")),
        ),
        thresholds: this.thresholds,
        metricsFreshAfter: metricsFreshAfter(now, this.metricsMaximumAgeSeconds),
        maxAssignments,
      });
      if (plan.decisions.length > 0) {
        await this.batches.reserveAssignments({
          batchId,
          eventId: this.ids.next(),
          projectMaximumConcurrency: this.projectMaximumConcurrency,
          decisions: plan.decisions.map((decision) => ({
            ...decision,
            attemptId: this.ids.next(),
            assignmentId: this.ids.next(),
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
    const batchIds = await this.batches.listSchedulableBatchIds(
      limit,
      this.clock.now().toISOString(),
      this.priorityAgingIntervalMinutes,
    );
    return this.scheduleBatchIds(batchIds);
  }

  async scheduleForRunner(runnerId: string, limit = 50): Promise<number> {
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
      const before = await this.batches.get(batchId);
      const after = await this.schedule(batchId);
      scheduled += Math.max(0, after.assignedRuns - (before?.assignedRuns ?? 0));
    }
    return scheduled;
  }

  private async preflightValidated(
    input: ReturnType<typeof createRunBatchInputSchema.parse>,
  ): Promise<RunBatchPreflightResult> {
    const blockers: RunBatchPreflightBlocker[] = [];
    const projectId = input.projectId ?? DEFAULT_PROJECT_ID;
    const suite = await this.suites.get(input.suiteId);
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
      if (enabledCases.length === 0) {
        blockers.push(
          blocker("RUN_BATCH_EMPTY", "parameter", "用例任务中没有可执行的启用用例。", {
            path: ["suiteId"],
          }),
        );
      } else {
        await this.inspectExecutionInputs(enabledCases, blockers);
      }
    }
    const secretBindings = await this.inspectEnvironment(projectId, input, blockers);
    await this.inspectRunners(
      input.runnerIds,
      secretBindings.length > 0,
      blockers,
      suite?.policy.runnerLabels ?? [],
      suite?.policy.executor ?? "testng",
    );
    return { ready: blockers.length === 0, blockers };
  }

  private async inspectEnvironment(
    projectId: string,
    input: ReturnType<typeof createRunBatchInputSchema.parse>,
    blockers: RunBatchPreflightBlocker[],
  ) {
    if (!input.environmentVersionId) return [];
    if (!this.environments) {
      blockers.push(
        blocker(
          "EXECUTION_ENVIRONMENT_UNAVAILABLE",
          "environment",
          "当前运行时未配置执行环境仓储。",
          { path: ["environmentVersionId"] },
        ),
      );
      return [];
    }
    const resolved = await this.environments.getVersion(input.environmentVersionId, projectId);
    if (!resolved) {
      blockers.push(
        blocker(
          "EXECUTION_ENVIRONMENT_VERSION_NOT_FOUND",
          "environment",
          "指定的执行环境版本不存在或不属于当前项目。",
          { path: ["environmentVersionId"] },
        ),
      );
      return [];
    }
    if (resolved.environment.status !== "active") {
      blockers.push(
        blocker(
          "EXECUTION_ENVIRONMENT_DISABLED",
          "environment",
          "已停用的执行环境不能创建新批次。",
          { path: ["environmentVersionId"] },
        ),
      );
    }
    const unavailable = await this.environments.findUnavailableSecretsForExecution(
      projectId,
      resolved.version.secretBindings,
    );
    for (const secret of unavailable) {
      blockers.push(
        blocker(
          "EXECUTION_SECRET_UNAVAILABLE",
          "environment",
          `变量 ${secret.name} 引用的执行密文不可用、已停用或不属于当前项目。`,
          { path: ["environmentVersionId"] },
        ),
      );
    }
    return resolved.version.secretBindings;
  }

  private async inspectRunners(
    runnerIds: readonly string[],
    requiresSecrets: boolean,
    blockers: RunBatchPreflightBlocker[],
    policyLabels: readonly string[] = [],
    executor: "testng" | "testng-container" = "testng",
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
      if (requiresSecrets && !runner.capabilities.includes(ON_DEMAND_SECRET_CAPABILITY)) {
        blockers.push(
          blocker(
            "RUNNER_SECRET_CAPABILITY_MISSING",
            "runner",
            "执行机不支持按有效 lease 领取执行密文。",
            { runnerId },
          ),
        );
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
      throw new DomainError("RUNNER_INCOMPATIBLE", "所选执行机不支持按租约领取执行密文。");
    }
  }

  private async resolveEnvironmentSnapshot(
    projectId: string,
    environmentVersionId: string | undefined,
    inlineVariables: Array<{ name: string; value: string }>,
  ): Promise<{
    environmentId?: string;
    environmentVersionId?: string;
    variables: Array<{ name: string; value: string }>;
    secretBindings: Array<{ name: string; secretId: string; secretVersionId: string }>;
  }> {
    if (!environmentVersionId) {
      return {
        variables: [...inlineVariables].sort((left, right) => left.name.localeCompare(right.name)),
        secretBindings: [],
      };
    }
    if (!this.environments) {
      throw new DomainError("EXECUTION_ENVIRONMENT_UNAVAILABLE", "当前运行时未配置执行环境仓储。");
    }
    const resolved = await this.environments.getVersion(environmentVersionId, projectId);
    if (!resolved) {
      throw new DomainError(
        "EXECUTION_ENVIRONMENT_VERSION_NOT_FOUND",
        "指定的执行环境版本不存在。",
      );
    }
    if (resolved.environment.status !== "active") {
      throw new DomainError("EXECUTION_ENVIRONMENT_DISABLED", "已停用的执行环境不能创建新批次。");
    }
    await this.environments.assertSecretsAvailableForExecution(
      projectId,
      resolved.version.secretBindings,
    );
    return {
      environmentId: resolved.environment.id,
      environmentVersionId: resolved.version.id,
      variables: [...resolved.version.variables],
      secretBindings: [...resolved.version.secretBindings],
    };
  }
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
  if (root === "environmentVariables" || root === "environmentVersionId") {
    return blocker("EXECUTION_ENVIRONMENT_PARAMETER_INVALID", "environment", message, { path });
  }
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
    resource_isolation_missing: "Runner 缺少 cgroup v2 资源隔离 capability。",
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
