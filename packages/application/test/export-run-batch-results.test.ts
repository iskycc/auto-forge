import type { RunBatchRepository } from "@autoforge/application";
import { DomainError, type RunBatchDetails } from "@autoforge/domain";
import { describe, expect, it } from "vitest";

import { buildRunBatchExportRows, RunBatchExportService } from "../src/export-run-batch-results";

// 导出行组装是纯函数，直接基于内存 details 验证轮次/最终/阻塞语义。
// 轮次语义：attemptNumber 即轮次号，1 为初始轮次；blocked 只出现在未完成的轮次。

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
      attempt("attempt-a1", "run-a", 1, "succeeded"),
      attempt("attempt-c1", "run-c", 1, "failed"),
      attempt("attempt-a2", "run-a", 2, "failed"),
      attempt("attempt-c2", "run-c", 2, "failed"),
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
    ...(outcome === "failed"
      ? { resultCode: "TEST_FAILED", resultSummary: "at com.example.Main(Main.java:10)" }
      : {}),
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

  it("counts blocked runs only for rounds that have not started", () => {
    // 第 3 轮尚无任何 attempt（waiting）：heldRound=3 的 run-b 计入阻塞。
    const rows = buildRunBatchExportRows(makeDetails(), {
      scope: "round",
      round: 3,
      outcomes: ["succeeded", "failed", "blocked"],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      attemptId: null,
      casePath: "com.example.run-b",
      outcome: "blocked",
      startedAt: null,
      durationMs: null,
      round: 3,
    });

    // 已完成轮次不产生阻塞行。
    const completed = buildRunBatchExportRows(makeDetails(), {
      scope: "round",
      round: 1,
      outcomes: ["blocked"],
    });
    expect(completed).toHaveLength(0);
  });

  it("exports final scope with the latest attempt per run and blocked runs without attempts", () => {
    const details = makeDetails({
      attempts: [
        attempt("attempt-a1", "run-a", 1, "succeeded"),
        attempt("attempt-a2", "run-a", 2, "failed"),
      ],
    });
    const rows = buildRunBatchExportRows(details, {
      scope: "final",
      outcomes: ["succeeded", "failed", "timed_out", "cancelled", "blocked"],
    });
    // run-a 取第 2 轮失败；run-b/run-c 无 attempt 记为阻塞。
    expect(rows).toHaveLength(3);
    const finalRun = rows.find((row) => row.casePath === "com.example.run-a");
    expect(finalRun).toMatchObject({ attemptId: "attempt-a2", outcome: "failed", round: 2 });
    const blockedRows = rows.filter((row) => row.outcome === "blocked");
    expect(blockedRows.map((row) => row.casePath)).toEqual([
      "com.example.run-b",
      "com.example.run-c",
    ]);
    expect(blockedRows.every((row) => row.attemptId === null && row.durationMs === null)).toBe(
      true,
    );
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

  it("only fills the failure summary for non-succeeded attempts", () => {
    const rows = buildRunBatchExportRows(makeDetails(), {
      scope: "round",
      round: 1,
      outcomes: ["succeeded", "failed"],
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
