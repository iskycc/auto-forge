import type { ExecutionRun, RunAttempt } from "@autoforge/domain";
import { describe, expect, it } from "vitest";

import { buildRunnerFaultIncidents } from "./runner-fault-incidents";

describe("buildRunnerFaultIncidents", () => {
  it("groups retryable Runner failures and excludes ordinary assertion failures", () => {
    const attempts = [
      attempt("a-1", "run-1", "runner-a", "PROCESS_START_FAILED"),
      attempt("a-2", "run-2", "runner-a", "PROCESS_START_FAILED"),
      attempt("a-3", "run-2", "runner-b", "TESTNG_ASSERTIONS_FAILED"),
    ];

    const incidents = buildRunnerFaultIncidents({
      runs: [executionRun("run-1", "登录用例"), executionRun("run-2", "支付用例")],
      attempts,
    });

    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      runnerId: "runner-a",
      resultCode: "PROCESS_START_FAILED",
      count: 2,
      caseNames: ["登录用例", "支付用例"],
    });
  });
});

function executionRun(id: string, displayName: string): ExecutionRun {
  return {
    id,
    batchId: "batch-1",
    caseDefinitionId: `case-${id}`,
    caseVersion: 1,
    displayName,
    className: `example.${id}`,
    status: "failed",
    attemptCount: 1,
    terminalOutcome: "failed",
    version: 1,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:01:00.000Z",
  };
}

function attempt(
  id: string,
  executionRunId: string,
  runnerId: string,
  resultCode: string,
): RunAttempt {
  return {
    id,
    executionRunId,
    runnerId,
    attemptNumber: 1,
    status: "failed",
    outcome: "failed",
    resultCode,
    resultSummary: "prepare workspace failed",
    schedulingScore: 1,
    version: 1,
    createdAt: "2026-08-20T00:00:00.000Z",
  };
}
