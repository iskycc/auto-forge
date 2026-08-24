import type { CaseDefinitionWithMethods } from "./case-definition";

export type CaseSuite = {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  version: number;
  revision: number;
  status: "active" | "archived";
  enabled: boolean;
  policy: CaseSuiteExecutionPolicy;
  caseCount: number;
  createdBy?: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type CaseSuiteExecutionPolicy = {
  executor: "testng" | "testng-container";
  adapter: CaseSuiteAdapterConfiguration;
  priority: number;
  concurrency: number;
  retryLimit: number;
  retryMode: "immediate" | "round";
  queueTimeoutMs: number;
  claimTimeoutMs: number;
  uploadTimeoutMs: number;
  projectVersionId?: string;
  runnerIds: string[];
  runnerGroupId?: string;
  runnerLabels: string[];
  artifactPatterns: string[];
  retryConcurrencyRules: RetryConcurrencyRule[];
  roundRecoveryRules: RoundRecoveryRule[];
};

/**
 * 整轮重跑的动态并发规则。执行轮次从 1 开始，因此第一轮重跑是第 2 轮。
 * 规则只在 executionRound 指定的轮次内判断；命中后持续生效，直到后续规则命中。
 */
export type RetryConcurrencyRule = {
  id: string;
  executionRound: number;
  previousRoundPassRateMinimum?: number;
  previousRoundPassRateMaximum?: number;
  remainingRunsMinimum?: number;
  remainingRunsMaximum?: number;
  concurrency: number;
};

/** 在 afterRound 完成后参与同轮屏障的一次 Jenkins Rebuild。 */
export type RoundRecoveryRule = {
  id: string;
  afterRound: number;
  jenkinsJobUrl: string;
  waitMinutes: number;
  // 只表示服务端已保存密钥；密钥明文和密文都不得进入领域对象或 HTTP 输出。
  apiKeyConfigured: boolean;
};

export type RetryConcurrencyContext = {
  executionRound: number;
  previousRoundPassRate: number | null;
  remainingRuns: number;
};

/**
 * 批次已经激活的动态并发阶段。规则在批次快照内不可变，ruleIndex 因而可以作为
 * 单调游标：只有排在当前阶段之后的规则才能在后续轮次触发并覆盖它。
 */
export type RetryConcurrencyState = {
  ruleId: string;
  ruleIndex: number;
  concurrency: number;
  activatedRound: number;
};

export type RetryConcurrencyDecision = {
  concurrency: number;
  activeState?: RetryConcurrencyState;
  transition?: RetryConcurrencyState;
};

export function retryConcurrencyForRound(
  baseConcurrency: number,
  rules: readonly RetryConcurrencyRule[],
  context: RetryConcurrencyContext,
  activeState?: RetryConcurrencyState,
): number {
  return retryConcurrencyDecisionForRound(baseConcurrency, rules, context, activeState).concurrency;
}

/**
 * 动态并发是有状态的阶段规则：首次命中后持续生效；同一轮不会连续跨过多个阶段，
 * 后续轮次只有列表中位于当前规则之后的规则可以再次切换并发。
 */
export function retryConcurrencyDecisionForRound(
  baseConcurrency: number,
  rules: readonly RetryConcurrencyRule[],
  context: RetryConcurrencyContext,
  state?: RetryConcurrencyState,
): RetryConcurrencyDecision {
  const activeState = validRetryConcurrencyState(rules, context.executionRound, state);
  if (activeState && activeState.activatedRound === context.executionRound) {
    return { concurrency: activeState.concurrency, activeState };
  }

  const firstEligibleRuleIndex = activeState ? activeState.ruleIndex + 1 : 0;
  const matchedRuleIndex = rules.findIndex(
    (rule, index) => index >= firstEligibleRuleIndex && retryConcurrencyRuleMatches(rule, context),
  );
  const matchedRule = rules[matchedRuleIndex];
  if (matchedRule) {
    const transition: RetryConcurrencyState = {
      ruleId: matchedRule.id,
      ruleIndex: matchedRuleIndex,
      concurrency: matchedRule.concurrency,
      activatedRound: context.executionRound,
    };
    return { concurrency: transition.concurrency, activeState: transition, transition };
  }
  if (activeState) return { concurrency: activeState.concurrency, activeState };
  return { concurrency: baseConcurrency };
}

function validRetryConcurrencyState(
  rules: readonly RetryConcurrencyRule[],
  executionRound: number,
  state: RetryConcurrencyState | undefined,
): RetryConcurrencyState | undefined {
  if (
    !state ||
    state.activatedRound > executionRound ||
    state.ruleIndex < 0 ||
    !Number.isInteger(state.ruleIndex)
  ) {
    return undefined;
  }
  const activeRule = rules[state.ruleIndex];
  return activeRule?.id === state.ruleId && activeRule.concurrency === state.concurrency
    ? state
    : undefined;
}

function retryConcurrencyRuleMatches(
  rule: RetryConcurrencyRule,
  context: RetryConcurrencyContext,
): boolean {
  if (context.executionRound !== rule.executionRound) return false;
  if (
    rule.previousRoundPassRateMinimum !== undefined &&
    (context.previousRoundPassRate === null ||
      context.previousRoundPassRate < rule.previousRoundPassRateMinimum)
  ) {
    return false;
  }
  if (
    rule.previousRoundPassRateMaximum !== undefined &&
    (context.previousRoundPassRate === null ||
      context.previousRoundPassRate > rule.previousRoundPassRateMaximum)
  ) {
    return false;
  }
  if (
    rule.remainingRunsMinimum !== undefined &&
    context.remainingRuns < rule.remainingRunsMinimum
  ) {
    return false;
  }
  if (
    rule.remainingRunsMaximum !== undefined &&
    context.remainingRuns > rule.remainingRunsMaximum
  ) {
    return false;
  }
  return true;
}

export type CaseSuiteAdapterConfiguration = {
  enabled: boolean;
  suiteName: string;
  testName: string;
  environmentAddresses: string[];
};

// adapter 用例执行超时的平台默认值（秒）；后台配置缺失时回落该值，
// 与契约 executionSpecSchema.adapter.caseTimeoutSeconds 的默认值保持一致。
export const DEFAULT_CASE_EXECUTION_TIMEOUT_SECONDS = 600;

export const defaultCaseSuiteExecutionPolicy: CaseSuiteExecutionPolicy = {
  executor: "testng",
  adapter: {
    enabled: false,
    suiteName: "",
    testName: "",
    environmentAddresses: [],
  },
  priority: 0,
  concurrency: 4,
  retryLimit: 0,
  retryMode: "immediate",
  queueTimeoutMs: 86_400_000,
  claimTimeoutMs: 300_000,
  uploadTimeoutMs: 600_000,
  runnerIds: [],
  runnerLabels: [],
  artifactPatterns: ["reports/testng/**"],
  retryConcurrencyRules: [],
  roundRecoveryRules: [],
};

// 策略覆盖输入：与 Partial 的区别是显式允许 undefined 值，兼容 exactOptionalPropertyTypes
// 下 zod 推断出的可选字段。
export type CaseSuiteExecutionPolicyOverride = {
  [K in keyof CaseSuiteExecutionPolicy]?: CaseSuiteExecutionPolicy[K] | undefined;
};

// 策略按字段覆盖合并；数组与记录整体替换，不做逐元素合并，避免语义含糊。
export function mergeCaseSuiteExecutionPolicy(
  base: CaseSuiteExecutionPolicy,
  override: CaseSuiteExecutionPolicyOverride,
): CaseSuiteExecutionPolicy {
  return {
    executor: override.executor ?? base.executor,
    adapter: override.adapter
      ? {
          enabled: override.adapter.enabled,
          suiteName: override.adapter.suiteName,
          testName: override.adapter.testName,
          environmentAddresses: [...override.adapter.environmentAddresses],
        }
      : {
          enabled: base.adapter.enabled,
          suiteName: base.adapter.suiteName,
          testName: base.adapter.testName,
          environmentAddresses: [...base.adapter.environmentAddresses],
        },
    priority: override.priority ?? base.priority,
    concurrency: override.concurrency ?? base.concurrency,
    retryLimit: override.retryLimit ?? base.retryLimit,
    retryMode: override.retryMode ?? base.retryMode,
    queueTimeoutMs: override.queueTimeoutMs ?? base.queueTimeoutMs,
    claimTimeoutMs: override.claimTimeoutMs ?? base.claimTimeoutMs,
    uploadTimeoutMs: override.uploadTimeoutMs ?? base.uploadTimeoutMs,
    ...(override.projectVersionId !== undefined
      ? override.projectVersionId
        ? { projectVersionId: override.projectVersionId }
        : {}
      : base.projectVersionId
        ? { projectVersionId: base.projectVersionId }
        : {}),
    runnerIds: override.runnerIds ? [...override.runnerIds] : [...base.runnerIds],
    ...(override.runnerGroupId !== undefined
      ? override.runnerGroupId
        ? { runnerGroupId: override.runnerGroupId }
        : {}
      : base.runnerGroupId
        ? { runnerGroupId: base.runnerGroupId }
        : {}),
    runnerLabels: override.runnerLabels ? [...override.runnerLabels] : [...base.runnerLabels],
    artifactPatterns: override.artifactPatterns
      ? [...override.artifactPatterns]
      : [...base.artifactPatterns],
    retryConcurrencyRules: normalizeStoredRetryConcurrencyRules(
      override.retryConcurrencyRules ?? base.retryConcurrencyRules,
    ),
    roundRecoveryRules: (override.roundRecoveryRules ?? base.roundRecoveryRules).map((rule) => ({
      ...rule,
    })),
  };
}

/**
 * v1.1.8 及以前的草案数据使用起止轮次。升级后仅以开始轮次作为触发轮次，
 * 使历史配置符合新的单次触发语义，同时不会在读取旧任务时丢失规则。
 */
export function normalizeStoredRetryConcurrencyRules(value: unknown): RetryConcurrencyRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const rule = candidate as Record<string, unknown>;
    const executionRound = Number.isInteger(rule.executionRound)
      ? rule.executionRound
      : rule.executionRoundFrom;
    if (
      typeof rule.id !== "string" ||
      !Number.isInteger(executionRound) ||
      !Number.isInteger(rule.concurrency)
    ) {
      return [];
    }
    const previousRoundPassRateMinimum = optionalInteger(rule.previousRoundPassRateMinimum);
    const previousRoundPassRateMaximum = optionalInteger(rule.previousRoundPassRateMaximum);
    const remainingRunsMinimum = optionalInteger(rule.remainingRunsMinimum);
    const remainingRunsMaximum = optionalInteger(rule.remainingRunsMaximum);
    return [
      {
        id: rule.id,
        executionRound: executionRound as number,
        ...(previousRoundPassRateMinimum === undefined ? {} : { previousRoundPassRateMinimum }),
        ...(previousRoundPassRateMaximum === undefined ? {} : { previousRoundPassRateMaximum }),
        ...(remainingRunsMinimum === undefined ? {} : { remainingRunsMinimum }),
        ...(remainingRunsMaximum === undefined ? {} : { remainingRunsMaximum }),
        concurrency: rule.concurrency as number,
      },
    ];
  });
}

function optionalInteger(value: unknown): number | undefined {
  return Number.isInteger(value) ? (value as number) : undefined;
}

export type CaseSuiteVersionSnapshot = {
  name: string;
  description?: string;
  status: "active" | "archived";
  enabled: boolean;
  policy: CaseSuiteExecutionPolicy;
  caseDefinitionIds: string[];
};

// 快照记录变更完成后的状态，版本号与 case_suites.version 同步递增。
export function buildCaseSuiteVersionSnapshot(
  suite: CaseSuite,
  caseDefinitionIds: readonly string[],
): CaseSuiteVersionSnapshot {
  return {
    name: suite.name,
    ...(suite.description ? { description: suite.description } : {}),
    status: suite.status,
    enabled: suite.enabled,
    policy: mergeCaseSuiteExecutionPolicy(suite.policy, {}),
    caseDefinitionIds: [...caseDefinitionIds].sort(),
  };
}

export type CaseSuiteSchedule = {
  id: string;
  suiteId: string;
  projectId: string;
  cronExpression: string;
  timeZone: string;
  missedRunPolicy: "skip" | "run-once";
  enabled: boolean;
  nextTriggerAt: string;
  lastTriggerAt?: string;
  lastTriggerStatus?: "created" | "skipped" | "failed";
  lastBatchId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type CaseSuiteItem = {
  id: string;
  suiteId: string;
  caseDefinition: CaseDefinitionWithMethods;
  addedAt: string;
};

export type CaseSuiteDetails = CaseSuite & {
  items: CaseSuiteItem[];
};
