import { describe, expect, it } from "vitest";
import { defaultCaseSuiteExecutionPolicy, type RunBatchExecutionPolicy } from "@autoforge/domain";
import { serializeBatchPolicy } from "../src/run-batch-environment-addresses";
import {
  toFailureCaseSuiteSource,
  type FailureCaseSuiteSourceRow,
} from "../src/failure-case-suite-source";

function sourceRow(batchPolicy: Record<string, unknown>): FailureCaseSuiteSourceRow {
  return {
    suiteId: "suite-1",
    suiteName: "回归任务",
    projectId: "project-1",
    status: "failed",
    kind: "standard",
    description: null,
    suitePolicyJson: JSON.stringify({
      ...defaultCaseSuiteExecutionPolicy,
      projectVersionId: "version-1",
      adapter: {
        enabled: true,
        suiteName: "Suite",
        testName: "Test",
        environmentAddresses: ["10.0.0.11"],
      },
    }),
    batchPolicyJson: JSON.stringify({
      executor: "testng",
      concurrency: 40,
      projectVersionId: "version-1",
      runnerLabels: [],
      artifactPatterns: [],
      ...batchPolicy,
    }),
    priority: 0,
    retryLimit: 2,
    retryMode: "round",
    queueTimeoutMs: 60000,
    claimTimeoutMs: 300000,
    uploadTimeoutMs: 600000,
  };
}

describe("failure task execution snapshot compatibility", () => {
  it("accepts every current batch policy field written by the repositories", () => {
    // Keep this exhaustive: adding persisted policy fields must also audit task copying.
    const batchPolicy: Required<RunBatchExecutionPolicy> = {
      unlimitedRetries: true,
      retryStopRules: [
        { id: "finish", afterRound: 10, metric: "remainingRuns", operator: "gt", value: 1000 },
      ],
      retryCompletion: { round: 10, ruleId: "finish", reason: "condition met" },
      aiAnalysisAfterCompletion: true,
      aiAnalysisExecutionId: "original-batch",
      executor: "testng-container",
      concurrency: 40,
      projectVersionId: "version-1",
      runnerLabels: ["java"],
      artifactPatterns: ["reports/**"],
      retryConcurrencyRules: [{ id: "rule-1", executionRound: 2, concurrency: 20 }],
    };
    const row = sourceRow({});
    row.batchPolicyJson = serializeBatchPolicy(batchPolicy, ["10.20.0.21"]);
    const copied = toFailureCaseSuiteSource(row, []).policy;
    expect(copied).toMatchObject({
      executor: "testng-container",
      aiAnalysisAfterCompletion: true,
      runnerLabels: ["java"],
      artifactPatterns: ["reports/**"],
      retryConcurrencyRules: [{ id: "rule-1", executionRound: 2, concurrency: 20 }],
      adapter: { environmentAddresses: ["10.20.0.21"] },
    });
    expect(copied).not.toHaveProperty("aiAnalysisExecutionId");
    expect(copied).not.toHaveProperty("environmentAddresses");
  });
  it.each([true, false])(
    "copies AI configuration (%s) without carrying the original batch analysis identity",
    (aiAnalysisAfterCompletion) => {
      const row = sourceRow({
        aiAnalysisAfterCompletion,
        aiAnalysisExecutionId: "original-batch",
      });
      const policy = toFailureCaseSuiteSource(row, []).policy;
      expect(policy).toMatchObject({ aiAnalysisAfterCompletion, concurrency: 40 });
      expect(policy).not.toHaveProperty("aiAnalysisExecutionId");
      expect(row.batchPolicyJson).toContain('"aiAnalysisExecutionId":"original-batch"');
    },
  );
  it("rejects an invalid batch analysis identity at its exact field", () => {
    expect(() => toFailureCaseSuiteSource(sourceRow({ aiAnalysisExecutionId: 42 }), [])).toThrow(
      expect.objectContaining({
        code: "CASE_SUITE_EXECUTION_SNAPSHOT_INVALID",
        details: {
          source: "batch_snapshot",
          issues: [expect.objectContaining({ field: "aiAnalysisExecutionId" })],
        },
      }),
    );
  });
  it("keeps batch-only AI metadata out of the task configuration schema", () => {
    const row = sourceRow({});
    row.suitePolicyJson = JSON.stringify({
      ...JSON.parse(row.suitePolicyJson!),
      aiAnalysisExecutionId: "original-batch",
    });
    expect(() => toFailureCaseSuiteSource(row, [])).toThrow(
      expect.objectContaining({
        code: "CASE_SUITE_EXECUTION_SNAPSHOT_INVALID",
        details: {
          source: "task_snapshot",
          issues: [expect.objectContaining({ field: "aiAnalysisExecutionId" })],
        },
      }),
    );
  });
  it("accepts the address projection written since v1.20.24 and copies the executed environment", () => {
    const row = sourceRow({ environmentAddresses: ["10.20.0.21", "2001:db8::21"] });
    expect(toFailureCaseSuiteSource(row, []).policy).toMatchObject({
      concurrency: 40,
      adapter: { enabled: true, environmentAddresses: ["10.20.0.21", "2001:db8::21"] },
    });
    expect(toFailureCaseSuiteSource(row, []).policy).not.toHaveProperty("environmentAddresses");
  });
  it("preserves the original task environment for older execution snapshots", () => {
    expect(
      toFailureCaseSuiteSource(sourceRow({}), []).policy?.adapter.environmentAddresses,
    ).toEqual(["10.0.0.11"]);
  });
  it("accepts the empty address projection on tasks with Adapter disabled", () => {
    const row = sourceRow({ environmentAddresses: [] });
    row.suitePolicyJson = JSON.stringify({
      ...defaultCaseSuiteExecutionPolicy,
      projectVersionId: "version-1",
    });
    expect(toFailureCaseSuiteSource(row, []).policy?.adapter).toMatchObject({
      enabled: false,
      environmentAddresses: [],
    });
  });
  it("reports the corrupt batch field without exposing snapshot values or secrets", () => {
    const row = sourceRow({ concurrency: 0 });
    try {
      toFailureCaseSuiteSource(row, []);
      throw new Error("Expected snapshot validation failure");
    } catch (error) {
      expect(error).toMatchObject({
        code: "CASE_SUITE_EXECUTION_SNAPSHOT_INVALID",
        details: {
          source: "batch_snapshot",
          issues: [expect.objectContaining({ field: "concurrency", message: expect.any(String) })],
        },
      });
      expect(JSON.stringify(error)).not.toContain(row.suitePolicyJson!);
    }
  });
  it("distinguishes malformed stored JSON from invalid HTTP input", () => {
    const row = sourceRow({});
    row.suitePolicyJson = '{"apiKey":"secret"';
    expect(() => toFailureCaseSuiteSource(row, [])).toThrow(
      expect.objectContaining({
        code: "CASE_SUITE_EXECUTION_SNAPSHOT_INVALID",
        details: {
          source: "task_snapshot",
          issues: [expect.objectContaining({ field: "configuration" })],
        },
      }),
    );
  });
  it("keeps unknown task fields rejected without disclosing their values", () => {
    const row = sourceRow({ unsupported: "private-value" });
    try {
      toFailureCaseSuiteSource(row, []);
      throw new Error("Expected snapshot validation failure");
    } catch (error) {
      expect(error).toMatchObject({
        code: "CASE_SUITE_EXECUTION_SNAPSHOT_INVALID",
        details: {
          source: "batch_snapshot",
          issues: [
            {
              field: "unsupported",
              message: "包含当前版本不支持的配置字段。",
            },
          ],
        },
      });
      expect(JSON.stringify(error)).not.toContain("private-value");
    }
  });
  it("identifies nested unsupported fields and bounds the returned diagnostics", () => {
    const row = sourceRow({
      retryConcurrencyRules: [
        { id: "rule-1", executionRound: 2, concurrency: 10, unsupported: "private-value" },
      ],
      ...Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`unknown${index}`, true])),
    });
    try {
      toFailureCaseSuiteSource(row, []);
      throw new Error("Expected snapshot validation failure");
    } catch (error) {
      expect(error).toMatchObject({
        details: {
          issues: expect.arrayContaining([
            expect.objectContaining({ field: "retryConcurrencyRules.0.unsupported" }),
          ]),
        },
      });
      expect((error as { details: { issues: unknown[] } }).details.issues).toHaveLength(10);
      expect(JSON.stringify(error)).not.toContain("private-value");
    }
  });
});

it("copies repeated recovery boundaries with their original credential binding", () => {
  const row = sourceRow({
    unlimitedRetries: true,
    retryStopRules: [],
    executor: "testng",
    concurrency: 4,
    runnerLabels: [],
    artifactPatterns: [],
  });
  const source = toFailureCaseSuiteSource(
    row,
    [7, 10, 13].map((round) => ({
      ruleId: `occurrence-${round}`,
      credentialRuleId: "original",
      afterRound: round,
      jenkinsJobUrl: "https://jenkins.internal/job/reset/",
      waitMinutes: 0,
      apiKeyCiphertext: "encrypted-original",
    })),
  );
  expect(source.policy?.roundRecoveryRules).toEqual([
    {
      id: "original",
      afterRound: 7,
      afterRounds: [7, 10, 13],
      jenkinsJobUrl: "https://jenkins.internal/job/reset/",
      waitMinutes: 0,
      apiKeyConfigured: true,
    },
  ]);
  expect(source.roundRecoveryCredentials).toEqual({ original: "encrypted-original" });
});
