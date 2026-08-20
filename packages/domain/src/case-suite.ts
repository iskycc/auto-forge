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
  parameters: Record<string, string>;
  artifactPatterns: string[];
};

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
  parameters: {},
  artifactPatterns: ["reports/testng/**"],
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
    parameters: override.parameters ? { ...override.parameters } : { ...base.parameters },
    artifactPatterns: override.artifactPatterns
      ? [...override.artifactPatterns]
      : [...base.artifactPatterns],
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
