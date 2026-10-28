import { describe, expect, it } from "vitest";
import { defaultCaseSuiteExecutionPolicy } from "@autoforge/domain";
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
      expect(error).toMatchObject({ code: "CASE_SUITE_EXECUTION_SNAPSHOT_INVALID" });
      expect(JSON.stringify(error)).not.toContain("private-value");
    }
  });
});
