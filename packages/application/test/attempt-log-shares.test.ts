import type { AttemptLogShareRecord } from "@autoforge/application";
import type { RunBatchDetails } from "@autoforge/domain";
import { describe, expect, it } from "vitest";

import { PERMANENT_LOG_ACCESS_EXPIRY, AttemptLogShareService } from "../src/attempt-log-shares";
import type {
  AttemptLogShareRepository,
  ExecutionControlRepository,
  RunBatchRepository,
} from "../src/ports";

// 日志公开访问服务只依赖查询端口，用内存 fake 验证 token 生命周期与日志合并规则。

function makeBatchDetails(attemptOutcome: "succeeded" | "failed"): RunBatchDetails {
  return {
    id: "batch-1",
    sequenceNumber: 1,
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
    scheduledFor: "2026-08-17T00:00:00.000Z",
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:05:00.000Z",
    statusHistory: [],
    roundRecoveries: [],
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
  logChunks: Array<{
    attemptId?: string;
    stream: string;
    sequence: number;
    content: string;
    recordedAt: string;
  }>;
  /** 批量存在性校验能找到的 attempt 集合，缺省只包含 attempt-1。 */
  knownAttemptIds: Set<string>;
  /** 记录每次 createMany 的批量大小，验证批量写入是单次调用而非逐条。 */
  createManyCalls: number[];
};

function makeState(
  overrides: Partial<Pick<FakeState, "logChunks" | "knownAttemptIds">> = {},
): FakeState {
  return {
    records: [],
    logChunks: [],
    knownAttemptIds: new Set(["attempt-1"]),
    createManyCalls: [],
    ...overrides,
  };
}

function makeService(
  state: FakeState,
  batch: RunBatchDetails = makeBatchDetails("failed"),
  diagnosticBatches: RunBatchDetails[] = [],
) {
  const shares: AttemptLogShareRepository = {
    create: async (record) => {
      state.records.push(record);
    },
    createMany: async (records) => {
      state.records.push(...records);
      state.createManyCalls.push(records.length);
    },
    findActiveByAttemptId: async (attemptId, now) =>
      [...state.records]
        .filter((record) => record.attemptId === attemptId && record.expiresAt > now)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .at(0) ?? null,
    findActiveByAttemptIds: async (attemptIds, now) => {
      const wanted = new Set(attemptIds);
      const latestByAttempt = new Map<string, AttemptLogShareRecord>();
      for (const record of state.records) {
        if (!wanted.has(record.attemptId) || record.expiresAt <= now) continue;
        const current = latestByAttempt.get(record.attemptId);
        if (!current || record.createdAt > current.createdAt) {
          latestByAttempt.set(record.attemptId, record);
        }
      }
      return [...latestByAttempt.values()];
    },
    findActiveByTokenHash: async (tokenHash, now) =>
      state.records.find((record) => record.tokenHash === tokenHash && record.expiresAt > now) ??
      null,
  };
  const batches = {
    get: async () => batch,
    listCaseLogRerunBatches: async () => diagnosticBatches,
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
    countExistingAttemptIds: async (attemptIds: readonly string[]) =>
      attemptIds.filter((attemptId) => state.knownAttemptIds.has(attemptId)).length,
    resolveAttemptProjectId: async (attemptId: string) =>
      state.knownAttemptIds.has(attemptId) ? "project-1" : null,
    listLogChunks: async (input: { attemptId: string; stream: string; afterSequence: number }) => ({
      items: state.logChunks.filter(
        (chunk) =>
          (!chunk.attemptId || chunk.attemptId === input.attemptId) &&
          chunk.stream === input.stream &&
          chunk.sequence > input.afterSequence,
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
    const state = makeState({
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
    });
    const service = makeService(state);
    const tokens = await service.ensureSharesForAttempts(["attempt-1", "attempt-1"], "user-1");
    // 重复 attemptId 复用同一条记录，只落库一次。
    expect(state.records).toHaveLength(1);
    // 新链接永久有效：expiresAt 固定为哨兵值而不是有限 TTL。
    expect(state.records[0]!.expiresAt).toBe(PERMANENT_LOG_ACCESS_EXPIRY);
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
    const state = makeState();
    const service = makeService(state);
    await service.ensureSharesForAttempts(["attempt-1"], "user-1");
    expect(await service.getSharedAttemptLog("token-missing")).toBeNull();

    state.records[0]!.expiresAt = "2026-08-16T00:00:00.000Z";
    expect(await service.getSharedAttemptLog("token-1")).toBeNull();
  });

  it("navigates terminal rounds of the shared case without authorizing another case", async () => {
    const state = makeState({
      logChunks: [
        {
          attemptId: "attempt-1",
          stream: "stdout",
          sequence: 0,
          content: "round one\n",
          recordedAt: "2026-08-17T00:01:01.000Z",
        },
        {
          attemptId: "attempt-3",
          stream: "stdout",
          sequence: 0,
          content: "round three\n",
          recordedAt: "2026-08-17T00:05:01.000Z",
        },
      ],
    });
    const service = makeService(state, makeMultiRoundBatchDetails());
    await service.ensureSharesForAttempts(["attempt-1"], "user-1");

    const view = await service.getSharedAttemptLog("token-1", "attempt-3");

    expect(view).toMatchObject({
      attemptId: "attempt-3",
      attemptNumber: 3,
      logText: "round three\n",
      rounds: [
        { attemptId: "attempt-1", attemptNumber: 1, outcome: "failed" },
        { attemptId: "attempt-2", attemptNumber: 2, outcome: "timed_out" },
        { attemptId: "attempt-3", attemptNumber: 3, outcome: "failed" },
      ],
    });
    expect(await service.getSharedAttemptLog("token-1", "other-attempt")).toBeNull();
  });

  it("includes diagnostic reruns with the requesting LDAP username in the same log history", async () => {
    const state = makeState({
      logChunks: [
        {
          attemptId: "manual-attempt",
          stream: "stdout",
          sequence: 0,
          content: "manual rerun\n",
          recordedAt: "2026-08-17T00:08:00.000Z",
        },
      ],
    });
    const source = makeBatchDetails("failed");
    const diagnostic = makeBatchDetails("succeeded");
    diagnostic.id = "diagnostic-batch";
    diagnostic.kind = "case_log_rerun";
    diagnostic.parentBatchId = source.id;
    diagnostic.sourceExecutionRunId = "run-1";
    diagnostic.requestedBy = { username: "c12345678", source: "ldap" };
    diagnostic.runs[0] = {
      ...diagnostic.runs[0]!,
      id: "manual-run",
      batchId: diagnostic.id,
    };
    diagnostic.attempts[0] = {
      ...diagnostic.attempts[0]!,
      id: "manual-attempt",
      executionRunId: "manual-run",
      createdAt: "2026-08-17T00:07:30.000Z",
    };
    const service = makeService(state, source, [diagnostic]);
    await service.ensureSharesForAttempts(["attempt-1"], "user-1");

    const view = await service.getSharedAttemptLog("token-1", "manual-attempt");

    expect(view).toMatchObject({
      attemptId: "manual-attempt",
      kind: "manual_rerun",
      requestedBy: { username: "c12345678", source: "ldap" },
      logText: "manual rerun\n",
      rounds: [
        expect.objectContaining({ attemptId: "attempt-1", kind: "round" }),
        expect.objectContaining({
          attemptId: "manual-attempt",
          kind: "manual_rerun",
          requestedBy: { username: "c12345678", source: "ldap" },
        }),
      ],
    });
  });

  it("reuses an existing active record's expiry instead of recomputing it", async () => {
    const state = makeState();
    const service = makeService(state);
    await service.ensureSharesForAttempts(["attempt-1"], "user-1");
    const originalExpiry = state.records[0]!.expiresAt;

    const secondTokens = await service.ensureSharesForAttempts(["attempt-1"], "user-2");
    expect(state.records).toHaveLength(2);
    // 新链接沿用现有记录的过期时间（当前均为永久哨兵），同一 attempt 的有效期保持一致。
    expect(state.records[1]!.expiresAt).toBe(originalExpiry);
    expect(secondTokens.get("attempt-1")).toBe("token-2");
  });

  it("rejects unknown attempts with RUN_ATTEMPT_NOT_FOUND", async () => {
    const state = makeState();
    const service = makeService(state);
    await expect(service.ensureSharesForAttempts(["missing"], "user-1")).rejects.toMatchObject({
      code: "RUN_ATTEMPT_NOT_FOUND",
    });
  });

  describe("ensureSharesForAttemptsInBatch", () => {
    it("issues one share per attempt in a single createMany call", async () => {
      const state = makeState({
        knownAttemptIds: new Set(["attempt-1", "attempt-2"]),
      });
      const service = makeService(state);
      // 重复 attemptId 先经 Set 去重，只落库一次。
      const tokens = await service.ensureSharesForAttemptsInBatch(
        ["attempt-1", "attempt-2", "attempt-1"],
        "batch-1",
        "user-1",
      );
      expect(tokens).toHaveLength(2);
      expect(state.records).toHaveLength(2);
      // 批量写入是一次 createMany 调用，而不是逐条 create。
      expect(state.createManyCalls).toEqual([2]);
      expect(state.records.map((record) => record.batchId)).toEqual(["batch-1", "batch-1"]);
      // 批量路径同样签发永久链接。
      expect(
        state.records.every((record) => record.expiresAt === PERMANENT_LOG_ACCESS_EXPIRY),
      ).toBe(true);
      expect(new Set(tokens.values()).size).toBe(2);
    });

    it("reuses an existing active record's expiry and ignores stale records", async () => {
      const state = makeState();
      const service = makeService(state);
      await service.ensureSharesForAttemptsInBatch(["attempt-1"], "batch-1", "user-1");
      const originalExpiry = state.records[0]!.expiresAt;
      // 手工插入一条更早的已失效记录（有限过期时间，覆盖旧版数据）：不应被沿用。
      state.records.push({
        ...state.records[0]!,
        id: "share-stale",
        tokenHash: "hashed-stale",
        createdAt: "2026-08-01T00:00:00.000Z",
        expiresAt: "2026-08-02T00:00:00.000Z",
      });

      const secondTokens = await service.ensureSharesForAttemptsInBatch(
        ["attempt-1"],
        "batch-1",
        "user-2",
      );
      expect(state.createManyCalls).toEqual([1, 1]);
      const latest = state.records.find((record) => record.tokenHash === "hashed-token-2");
      expect(latest?.expiresAt).toBe(originalExpiry);
      expect(secondTokens.get("attempt-1")).toBe("token-2");
    });

    it("rejects the whole batch when any attempt is missing", async () => {
      const state = makeState({
        knownAttemptIds: new Set(["attempt-1"]),
      });
      const service = makeService(state);
      await expect(
        service.ensureSharesForAttemptsInBatch(["attempt-1", "missing"], "batch-1", "user-1"),
      ).rejects.toMatchObject({ code: "RUN_ATTEMPT_NOT_FOUND" });
      // 校验失败时不写入任何公开访问记录。
      expect(state.records).toHaveLength(0);
    });

    it("returns an empty map for an empty attempt list", async () => {
      const state = makeState();
      const service = makeService(state);
      await expect(
        service.ensureSharesForAttemptsInBatch([], "batch-1", "user-1"),
      ).resolves.toEqual(new Map());
      expect(state.createManyCalls).toEqual([]);
    });
  });

  describe("ensureShareForAttempt", () => {
    it("issues a share token for an attempt inside the caller's project scope", async () => {
      const state = makeState();
      const service = makeService(state);
      const token = await service.ensureShareForAttempt("attempt-1", "user-1", ["project-1"]);
      expect(token).toBe("token-1");
      expect(state.records).toHaveLength(1);
    });

    it("skips the scope check when the caller has access to every project", async () => {
      const state = makeState();
      const service = makeService(state);
      await expect(service.ensureShareForAttempt("attempt-1", "user-1")).resolves.toBe("token-1");
    });

    it("reports attempts outside the caller's project scope as not found", async () => {
      const state = makeState();
      const service = makeService(state);
      await expect(
        service.ensureShareForAttempt("attempt-1", "user-1", ["other-project"]),
      ).rejects.toMatchObject({ code: "RUN_ATTEMPT_NOT_FOUND" });
      expect(state.records).toHaveLength(0);
    });

    it("rejects unknown attempts before issuing a token", async () => {
      const state = makeState();
      const service = makeService(state);
      await expect(
        service.ensureShareForAttempt("missing", "user-1", ["project-1"]),
      ).rejects.toMatchObject({ code: "RUN_ATTEMPT_NOT_FOUND" });
    });
  });
});

function makeMultiRoundBatchDetails(): RunBatchDetails {
  const batch = makeBatchDetails("failed");
  const firstAttempt = batch.attempts[0]!;
  batch.retryLimit = 2;
  batch.currentRound = 3;
  batch.runs[0] = { ...batch.runs[0]!, attemptCount: 3 };
  batch.runs.push({
    ...batch.runs[0]!,
    id: "other-run",
    caseDefinitionId: "other-case",
    displayName: "other#method",
    className: "com.example.Other",
    attemptCount: 1,
  });
  batch.attempts = [
    {
      ...firstAttempt,
      id: "attempt-3",
      attemptNumber: 3,
      startedAt: "2026-08-17T00:05:00.000Z",
      finishedAt: "2026-08-17T00:06:00.000Z",
      createdAt: "2026-08-17T00:04:30.000Z",
    },
    firstAttempt,
    {
      ...firstAttempt,
      id: "other-attempt",
      executionRunId: "other-run",
    },
    {
      ...firstAttempt,
      id: "attempt-2",
      attemptNumber: 2,
      status: "timed_out",
      outcome: "timed_out",
      startedAt: "2026-08-17T00:03:00.000Z",
      finishedAt: "2026-08-17T00:04:00.000Z",
      createdAt: "2026-08-17T00:02:30.000Z",
    },
  ];
  return batch;
}
