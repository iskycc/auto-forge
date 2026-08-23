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
 * 多条规则按数组顺序匹配，首条命中的规则生效，未命中时回退任务基础并发数。
 */
export type RetryConcurrencyRule = {
  id: string;
  executionRoundFrom: number;
  executionRoundTo: number;
  previousRoundPassRateMinimum?: number;
  previousRoundPassRateMaximum?: number;
  remainingRunsMinimum?: number;
  remainingRunsMaximum?: number;
  concurrency: number;
};

/** 在 afterRound 完成后、释放下一轮前执行一次 Jenkins Rebuild。 */
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

export function retryConcurrencyForRound(
  baseConcurrency: number,
  rules: readonly RetryConcurrencyRule[],
  context: RetryConcurrencyContext,
): number {
  const matched = rules.find((rule) => retryConcurrencyRuleMatches(rule, context));
  return matched?.concurrency ?? baseConcurrency;
}

function retryConcurrencyRuleMatches(
  rule: RetryConcurrencyRule,
  context: RetryConcurrencyContext,
): boolean {
  if (
    context.executionRound < rule.executionRoundFrom ||
    context.executionRound > rule.executionRoundTo
  ) {
    return false;
  }
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
    retryConcurrencyRules: (override.retryConcurrencyRules ?? base.retryConcurrencyRules).map(
      (rule) => ({ ...rule }),
    ),
    roundRecoveryRules: (override.roundRecoveryRules ?? base.roundRecoveryRules).map((rule) => ({
      ...rule,
    })),
  };
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
