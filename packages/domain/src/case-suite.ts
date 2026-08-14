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
  queueTimeoutMs: number;
  executionTimeoutMs: number;
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
  queueTimeoutMs: 86_400_000,
  executionTimeoutMs: 3_600_000,
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
    queueTimeoutMs: override.queueTimeoutMs ?? base.queueTimeoutMs,
    executionTimeoutMs: override.executionTimeoutMs ?? base.executionTimeoutMs,
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
