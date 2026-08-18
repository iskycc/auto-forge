import type { RunBatchRepository } from "@autoforge/application";
import { DomainError, type RunBatchDetails } from "@autoforge/domain";
import { describe, expect, it } from "vitest";

import { buildRunBatchExportRows, RunBatchExportService } from "../src/export-run-batch-results";

// 导出行组装是纯函数，直接基于内存 details 验证轮次/最终/阻塞语义。
// 轮次语义：attemptNumber 即轮次号，1 为初始轮次。
// blocked 新口径：除 adapter 正常成功/失败外的任何非正常结束（超时强杀、
// 未拉起 adapter、adapter 异常、取消等）；从未执行的用例没有终止结果，不导出。

type DetailsRun = RunBatchDetails["runs"][number];
type DetailsAttempt = RunBatchDetails["attempts"][number];

function makeDetails(overrides: Partial<RunBatchDetails> = {}): RunBatchDetails {
  return {
    id: "batch-1",
    projectId: "project-1",
    suiteId: "suite-1",
    suiteName: "回归套件",
    suiteVersion: 1,
    status: "running",
    priority: 0,
    retryLimit: 3,
    retryMode: "round",
    currentRound: 2,
    queueTimeoutMs: 86_400_000,
    claimTimeoutMs: 300_000,
    executionTimeoutMs: 3_600_000,
    uploadTimeoutMs: 600_000,
    environmentVariables: [],
    secretBindings: [],
    selectedRunnerIds: ["runner-1"],
    totalRuns: 3,
    queuedRuns: 1,
    assignedRuns: 0,
    runningRuns: 0,
    succeededRuns: 1,
    failedRuns: 1,
    timedOutRuns: 0,
    cancelledRuns: 0,
    version: 1,
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:10:00.000Z",
    statusHistory: [],
    runs: [
      run("run-a", "succeeded", { heldRound: 0 }),
      run("run-b", "queued", { heldRound: 3 }),
      run("run-c", "queued", { heldRound: 2 }),
    ],
    attempts: [
      attempt("attempt-a1", "run-a", 1, "succeeded", { resultCode: "TESTNG_SUCCEEDED" }),
      attempt("attempt-c1", "run-c", 1, "failed", {
        resultCode: "TESTNG_ASSERTIONS_FAILED",
        resultSummary: "at com.example.Main(Main.java:10)",
      }),
      attempt("attempt-a2", "run-a", 2, "failed", { resultCode: "TESTNG_ASSERTIONS_FAILED" }),
      attempt("attempt-c2", "run-c", 2, "failed", { resultCode: "ADAPTER_CASE_TIMEOUT" }),
    ],
    ...overrides,
  };
}

function run(
  id: string,
  status: DetailsRun["status"],
  overrides: Partial<DetailsRun> = {},
): DetailsRun {
  return {
    id,
    batchId: "batch-1",
    caseDefinitionId: `case-${id}`,
    caseVersion: 1,
    displayName: `${id}#method`,
    className: `com.example.${id}`,
    status,
    attemptCount: 0,
    version: 1,
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

function attempt(
  id: string,
  executionRunId: string,
  attemptNumber: number,
  outcome: NonNullable<DetailsAttempt["outcome"]>,
  result: { resultCode: string; resultSummary?: string } = { resultCode: "TESTNG_SUCCEEDED" },
): DetailsAttempt {
  return {
    id,
    executionRunId,
    runnerId: "runner-1",
    attemptNumber,
    status: outcome,
    schedulingScore: 1,
    version: 2,
    startedAt: "2026-08-17T00:01:00.000Z",
    finishedAt: "2026-08-17T00:02:00.000Z",
    outcome,
    resultCode: result.resultCode,
    ...(result.resultSummary ? { resultSummary: result.resultSummary } : {}),
    durationMs: 60_000,
    createdAt: "2026-08-17T00:00:30.000Z",
  };
}

describe("buildRunBatchExportRows", () => {
  it("exports round-scoped attempts of the requested round only", () => {
    const rows = buildRunBatchExportRows(makeDetails(), {
      scope: "round",
      round: 1,
      outcomes: ["succeeded", "failed", "blocked"],
    });
    expect(rows.map((row) => row.attemptId)).toEqual(["attempt-a1", "attempt-c1"]);
    expect(rows.map((row) => row.round)).toEqual([1, 1]);
  });

  it("exports nothing for a round without attempts because never-run cases have no terminal result", () => {
    // 第 3 轮尚无任何 attempt：heldRound=3 的 run-b 从未产生终止结果，不导出。
    const rows = buildRunBatchExportRows(makeDetails(), {
      scope: "round",
      round: 3,
      outcomes: ["succeeded", "failed", "blocked"],
    });
    expect(rows).toHaveLength(0);
  });

  it("classifies non-normal exits as blocked in round scope", () => {
    const rows = buildRunBatchExportRows(makeDetails(), {
      scope: "round",
      round: 2,
      outcomes: ["blocked"],
    });
    // run-c 第 2 轮 ADAPTER_CASE_TIMEOUT 属于非正常结束 → blocked。
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      attemptId: "attempt-c2",
      outcome: "blocked",
      resultCode: "ADAPTER_CASE_TIMEOUT",
      round: 2,
    });
  });

  it("exports final scope with the latest attempt per run and skips never-run cases", () => {
    const rows = buildRunBatchExportRows(makeDetails(), {
      scope: "final",
      outcomes: ["succeeded", "failed", "timed_out", "cancelled", "blocked"],
    });
    // run-a 取第 2 轮正常失败；run-c 取第 2 轮超时阻塞；run-b 从未执行不导出。
    expect(rows).toHaveLength(2);
    const finalRun = rows.find((row) => row.casePath === "com.example.run-a");
    expect(finalRun).toMatchObject({ attemptId: "attempt-a2", outcome: "failed", round: 2 });
    const blockedRun = rows.find((row) => row.casePath === "com.example.run-c");
    expect(blockedRun).toMatchObject({
      attemptId: "attempt-c2",
      outcome: "blocked",
      resultCode: "ADAPTER_CASE_TIMEOUT",
      round: 2,
    });
  });

  it("matches blocked attempts through the timed_out and cancelled filter aliases", () => {
    const details = makeDetails({
      attempts: [
        attempt("attempt-t1", "run-a", 1, "timed_out", { resultCode: "EXECUTION_TIMEOUT" }),
        attempt("attempt-x1", "run-c", 1, "cancelled", { resultCode: "EXECUTION_CANCELLED" }),
        attempt("attempt-b1", "run-b", 1, "failed", { resultCode: "ADAPTER_CASE_TIMEOUT" }),
      ],
    });
    // timed_out 别名同时覆盖 outcome=timed_out 与 adapter 用例超时（exit 3）。
    const timedOut = buildRunBatchExportRows(details, {
      scope: "final",
      outcomes: ["timed_out"],
    });
    expect(timedOut.map((row) => row.attemptId)).toEqual(["attempt-t1", "attempt-b1"]);
    expect(timedOut.every((row) => row.outcome === "blocked")).toBe(true);

    const cancelled = buildRunBatchExportRows(details, {
      scope: "final",
      outcomes: ["cancelled"],
    });
    expect(cancelled.map((row) => row.attemptId)).toEqual(["attempt-x1"]);
    expect(cancelled.every((row) => row.outcome === "blocked")).toBe(true);
  });

  it("rejects round scope without a positive integer round", () => {
    expect(() =>
      buildRunBatchExportRows(makeDetails(), { scope: "round", outcomes: ["failed"] }),
    ).toThrow(DomainError);
    expect(() =>
      buildRunBatchExportRows(makeDetails(), { scope: "round", round: 0, outcomes: ["failed"] }),
    ).toThrow("轮次");
  });

  it("rejects empty outcome filters", () => {
    expect(() => buildRunBatchExportRows(makeDetails(), { scope: "final", outcomes: [] })).toThrow(
      "至少选择",
    );
  });

  it("fills the result summary only for non-succeeded attempts", () => {
    const rows = buildRunBatchExportRows(makeDetails(), {
      scope: "round",
      round: 1,
      outcomes: ["succeeded", "failed", "blocked"],
    });
    const succeeded = rows.find((row) => row.outcome === "succeeded");
    const failed = rows.find((row) => row.outcome === "failed");
    expect(succeeded?.summary).toBeNull();
    expect(failed?.summary).toBe("at com.example.Main(Main.java:10)");
  });
});

describe("RunBatchExportService", () => {
  it("maps missing or inaccessible batches to BATCH_NOT_FOUND", async () => {
    const repository = {
      get: async () => null,
    } as unknown as RunBatchRepository;
    const service = new RunBatchExportService(repository);
    await expect(
      service.buildRows({ batchId: "missing", scope: "final", outcomes: ["failed"] }),
    ).rejects.toMatchObject({ code: "BATCH_NOT_FOUND" });
  });
});
