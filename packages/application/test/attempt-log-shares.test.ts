import type { AttemptLogShareRecord } from "@autoforge/application";
import type { RunBatchDetails } from "@autoforge/domain";
import { describe, expect, it } from "vitest";

import { AttemptLogShareService } from "../src/attempt-log-shares";
import type {
  AttemptLogShareRepository,
  ExecutionControlRepository,
  RunBatchRepository,
} from "../src/ports";

// 分享服务只依赖查询端口，用内存 fake 验证 token 生命周期与日志合并规则。

function makeBatchDetails(attemptOutcome: "succeeded" | "failed"): RunBatchDetails {
  return {
    id: "batch-1",
    projectId: "project-1",
    suiteId: "suite-1",
    suiteName: "回归套件",
    suiteVersion: 1,
    status: "succeeded",
    priority: 0,
    retryLimit: 0,
    retryMode: "immediate",
    currentRound: 1,
    queueTimeoutMs: 86_400_000,
    claimTimeoutMs: 300_000,
    executionTimeoutMs: 3_600_000,
    uploadTimeoutMs: 600_000,
    environmentVariables: [],
    secretBindings: [],
    selectedRunnerIds: ["runner-1"],
    totalRuns: 1,
    queuedRuns: 0,
    assignedRuns: 0,
    runningRuns: 0,
    succeededRuns: attemptOutcome === "succeeded" ? 1 : 0,
    failedRuns: attemptOutcome === "failed" ? 1 : 0,
    timedOutRuns: 0,
    cancelledRuns: 0,
    version: 1,
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:05:00.000Z",
    statusHistory: [],
    runs: [
      {
        id: "run-1",
        batchId: "batch-1",
        caseDefinitionId: "case-1",
        caseVersion: 1,
        displayName: "run-1#method",
        className: "com.example.RunOne",
        status: attemptOutcome,
        attemptCount: 1,
        version: 1,
        createdAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:05:00.000Z",
      },
    ],
    attempts: [
      {
        id: "attempt-1",
        executionRunId: "run-1",
        runnerId: "runner-1",
        attemptNumber: 1,
        status: attemptOutcome,
        schedulingScore: 1,
        version: 2,
        startedAt: "2026-08-17T00:01:00.000Z",
        finishedAt: "2026-08-17T00:02:00.000Z",
        outcome: attemptOutcome,
        ...(attemptOutcome === "failed"
          ? { resultSummary: "at com.example.Main(Main.java:10)" }
          : {}),
        durationMs: 60_000,
        createdAt: "2026-08-17T00:00:30.000Z",
      },
    ],
  };
}

type FakeState = {
  records: AttemptLogShareRecord[];
  logChunks: Array<{ stream: string; sequence: number; content: string; recordedAt: string }>;
};

function makeService(state: FakeState) {
  const shares: AttemptLogShareRepository = {
    create: async (record) => {
      state.records.push(record);
    },
    findActiveByAttemptId: async (attemptId, now) =>
      [...state.records]
        .filter((record) => record.attemptId === attemptId && record.expiresAt > now)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .at(0) ?? null,
    findActiveByTokenHash: async (tokenHash, now) =>
      state.records.find((record) => record.tokenHash === tokenHash && record.expiresAt > now) ??
      null,
  };
  const batches = {
    get: async () => makeBatchDetails("failed"),
  } as unknown as RunBatchRepository;
  const executions = {
    resolveAttemptSchedulingContext: async (attemptId: string) =>
      attemptId === "attempt-1"
        ? {
            batchId: "batch-1",
            executionRunId: "run-1",
            runnerId: "runner-1",
            attemptNumber: 1,
            displayName: "run-1#method",
          }
        : null,
    listLogChunks: async (input: { attemptId: string; stream: string; afterSequence: number }) => ({
      items: state.logChunks.filter(
        (chunk) => chunk.stream === input.stream && chunk.sequence > input.afterSequence,
      ),
      acknowledgedSequence: input.afterSequence,
      truncated: false,
    }),
  } as unknown as ExecutionControlRepository;
  let tokenCounter = 0;
  return new AttemptLogShareService(
    shares,
    batches,
    executions,
    {
      issue: () => `token-${++tokenCounter}`,
      hash: (value) => `hashed-${value}`,
    },
    { now: () => new Date("2026-08-17T00:00:00.000Z") },
    { next: () => `share-id-${state.records.length + 1}` },
  );
}

describe("AttemptLogShareService", () => {
  it("issues a new share per attempt and merges stdout/stderr into one ordered log", async () => {
    const state: FakeState = {
      records: [],
      logChunks: [
        {
          stream: "stdout",
          sequence: 0,
          content: "start\n",
          recordedAt: "2026-08-17T00:01:01.000Z",
        },
        {
          stream: "stderr",
          sequence: 0,
          content: "boom\n",
          recordedAt: "2026-08-17T00:01:02.000Z",
        },
        { stream: "stdout", sequence: 1, content: "end\n", recordedAt: "2026-08-17T00:01:03.000Z" },
      ],
    };
    const service = makeService(state);
    const tokens = await service.ensureSharesForAttempts(["attempt-1", "attempt-1"], "user-1");
    // 重复 attemptId 复用同一条分享，只落库一次。
    expect(state.records).toHaveLength(1);
    expect(tokens.get("attempt-1")).toBe("token-1");

    const view = await service.getSharedAttemptLog("token-1");
    expect(view).toMatchObject({
      attemptId: "attempt-1",
      casePath: "com.example.RunOne",
      outcome: "failed",
      summary: "at com.example.Main(Main.java:10)",
    });
    expect(view?.logText).toBe("start\nboom\nend\n");
  });

  it("returns null for unknown or expired tokens without distinguishing the reason", async () => {
    const state: FakeState = { records: [], logChunks: [] };
    const service = makeService(state);
    await service.ensureSharesForAttempts(["attempt-1"], "user-1");
    expect(await service.getSharedAttemptLog("token-missing")).toBeNull();

    state.records[0]!.expiresAt = "2026-08-16T00:00:00.000Z";
    expect(await service.getSharedAttemptLog("token-1")).toBeNull();
  });

  it("reuses an existing active share's expiry instead of extending the window", async () => {
    const state: FakeState = { records: [], logChunks: [] };
    const service = makeService(state);
    await service.ensureSharesForAttempts(["attempt-1"], "user-1");
    const originalExpiry = state.records[0]!.expiresAt;

    const secondTokens = await service.ensureSharesForAttempts(["attempt-1"], "user-2");
    expect(state.records).toHaveLength(2);
    // 新分享沿用旧过期时间，反复导出不延长暴露窗口。
    expect(state.records[1]!.expiresAt).toBe(originalExpiry);
    expect(secondTokens.get("attempt-1")).toBe("token-2");
  });

  it("rejects unknown attempts with RUN_ATTEMPT_NOT_FOUND", async () => {
    const state: FakeState = { records: [], logChunks: [] };
    const service = makeService(state);
    await expect(service.ensureSharesForAttempts(["missing"], "user-1")).rejects.toMatchObject({
      code: "RUN_ATTEMPT_NOT_FOUND",
    });
  });
});
