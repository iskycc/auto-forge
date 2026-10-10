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
        executionRound: 1,
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
  wholeBatchReadCalls: string[];
  logReadCalls: Array<{ stream: string; afterSequence: number; limit: number }>;
};

function makeState(
  overrides: Partial<Pick<FakeState, "logChunks" | "knownAttemptIds">> = {},
): FakeState {
  return {
    records: [],
    logChunks: [],
    knownAttemptIds: new Set(["attempt-1"]),
    createManyCalls: [],
    wholeBatchReadCalls: [],
    logReadCalls: [],
    ...overrides,
  };
}

function makeService(
  state: FakeState,
  batch: RunBatchDetails = makeBatchDetails("failed"),
  diagnosticBatches: RunBatchDetails[] = [],
  dependencyPublishedAt: Record<string, string> = {},
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
    getMetadata: async () => batch,
    getAttemptLogSnapshot: async (batchId: string, executionRunId: string) => {
      const selectedBatch = [batch, ...diagnosticBatches].find(
        (candidate) => candidate.id === batchId,
      );
      const run = selectedBatch?.runs.find((candidate) => candidate.id === executionRunId);
      return selectedBatch && run
        ? {
            batchId,
            batchSequenceNumber: selectedBatch.sequenceNumber,
            executionRunId,
            className: run.className,
            displayName: run.displayName,
            caseType: run.caseType ?? "testng",
            dependencyUpdatedAt: dependencyPublishedAt[batchId] ?? null,
          }
        : null;
    },
    getSummary: async () => {
      state.wholeBatchReadCalls.push("summary");
      return batch;
    },
    getRerunSnapshot: async (batchId: string) => {
      state.wholeBatchReadCalls.push("rerun snapshot");
      return {
        batch: [batch, ...diagnosticBatches].find((candidate) => candidate.id === batchId),
        roundRecoveries: [],
        runs:
          [batch, ...diagnosticBatches].find((candidate) => candidate.id === batchId)?.runs ?? [],
        ...(dependencyPublishedAt[batchId]
          ? {
              adapterRuntime: {
                suiteName: "suite",
                testName: "test",
                environmentAddresses: [],
                jarBundle: {
                  id: `bundle-${batchId}`,
                  sourceType: "upload",
                  sha256: "a".repeat(64),
                  sizeBytes: 1,
                  archiveFormat: "zip",
                  createdAt: dependencyPublishedAt[batchId],
                },
              },
            }
          : {}),
      };
    },
    listAttemptsForExecutionRun: async (executionRunId: string) =>
      batch.attempts.filter((attempt) => attempt.executionRunId === executionRunId),
    listCaseLogRerunBatches: async () => diagnosticBatches,
  } as unknown as RunBatchRepository;
  const executions = {
    resolveAttemptSchedulingContext: async (attemptId: string) =>
      state.knownAttemptIds.has(attemptId)
        ? {
            batchId: "batch-1",
            executionRunId: attemptId === "attempt-1" ? "run-1" : `run-${attemptId}`,
            runnerId: "runner-1",
            attemptNumber: 1,
            displayName: attemptId === "attempt-1" ? "run-1#method" : `${attemptId}#method`,
          }
        : null,
    resolveAttemptSchedulingContexts: async (attemptIds: readonly string[]) =>
      attemptIds
        .filter((attemptId) => state.knownAttemptIds.has(attemptId))
        .map((attemptId) => ({
          attemptId,
          batchId: "batch-1",
          executionRunId: attemptId === "attempt-1" ? "run-1" : `run-${attemptId}`,
          runnerId: "runner-1",
          attemptNumber: 1,
          displayName: attemptId === "attempt-1" ? "run-1#method" : `${attemptId}#method`,
        })),
    countExistingAttemptIds: async (attemptIds: readonly string[]) =>
      attemptIds.filter((attemptId) => state.knownAttemptIds.has(attemptId)).length,
    resolveAttemptProjectId: async (attemptId: string) =>
      state.knownAttemptIds.has(attemptId) ? "project-1" : null,
    listLogChunks: async (input: {
      attemptId: string;
      stream: string;
      afterSequence: number;
      limit: number;
    }) => {
      state.logReadCalls.push(input);
      const matching = state.logChunks.filter(
        (chunk) =>
          (!chunk.attemptId || chunk.attemptId === input.attemptId) &&
          chunk.stream === input.stream &&
          chunk.sequence > input.afterSequence,
      );
      const items = matching.slice(0, input.limit);
      return {
        items,
        ...(matching.length > items.length ? { nextSequence: items.at(-1)!.sequence } : {}),
        acknowledgedSequence: input.afterSequence,
        truncated: false,
      };
    },
  } as unknown as ExecutionControlRepository;
  return new AttemptLogShareService(
    shares,
    batches,
    executions,
    {
      hash: (value) => `hashed-${value}`,
    },
    { now: () => new Date("2026-08-17T00:00:00.000Z") },
  );
}

describe("AttemptLogShareService", () => {
  it("opens a completed case in an active batch without computing batch counters or preparing a rerun", async () => {
    const state = makeState();
    const batch = {
      ...makeBatchDetails("succeeded"),
      status: "running" as const,
      totalRuns: 100_000,
    };
    const service = makeService(state, batch);
    seedLegacyShare(state);

    expect(await service.getSharedAttemptLog("token-1")).toMatchObject({
      attemptId: "attempt-1",
      outcome: "succeeded",
      displayName: "run-1#method",
    });
    expect(state.wholeBatchReadCalls).toEqual([]);
  });

  it("reads a fragmented completed log in bounded windows without a database round trip for every 16 chunks", async () => {
    const state = makeState({
      logChunks: Array.from({ length: 512 }, (_, sequence) => ({
        stream: "stdout",
        sequence,
        content: `INFO fragmented line ${sequence}\n`,
        recordedAt: "2026-08-17T00:01:00.000Z",
      })),
    });
    const service = makeService(state);
    seedLegacyShare(state);
    const view = await service.getSharedAttemptLog("token-1");
    expect(view?.logText).toBe(state.logChunks.map((chunk) => chunk.content).join(""));
    expect(state.logReadCalls.filter((call) => call.stream === "stdout")).toHaveLength(4);
    expect(state.logReadCalls.every((call) => call.limit <= 128)).toBe(true);
  });
  it("reads an existing legacy link and merges stdout/stderr into one ordered log", async () => {
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
    seedLegacyShare(state);

    const view = await service.getSharedAttemptLog("token-1");
    expect(view).toMatchObject({
      attemptId: "attempt-1",
      casePath: "com.example.RunOne",
      outcome: "failed",
      summary: "at com.example.Main(Main.java:10)",
    });
    expect(view?.logText).toBe("start\nboom\nend\n");
  });

  it("bounds public log payloads before returning them to the page", async () => {
    const state = makeState({
      logChunks: [
        {
          stream: "stdout",
          sequence: 0,
          content: "你".repeat(200_000),
          recordedAt: "2026-08-17T00:01:01.000Z",
        },
      ],
    });
    const service = makeService(state);
    seedLegacyShare(state);

    const view = await service.getSharedAttemptLog("token-1");

    expect(view?.logTruncated).toBe(true);
    expect(new TextEncoder().encode(view?.logText ?? "").byteLength).toBeLessThanOrEqual(
      512 * 1024,
    );
    expect(view?.logText.endsWith("�")).toBe(false);
  });

  it("returns null for unknown or expired tokens without distinguishing the reason", async () => {
    const state = makeState();
    const service = makeService(state);
    seedLegacyShare(state);
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
    seedLegacyShare(state);

    const view = await service.getSharedAttemptLog("token-1", "attempt-3");

    expect(view).toMatchObject({
      attemptId: "attempt-3",
      attemptNumber: 3,
      executionRound: 2,
      logText: "round three\n",
      rounds: [
        {
          attemptId: "attempt-1",
          attemptNumber: 1,
          executionRound: 1,
          outcome: "failed",
        },
        {
          attemptId: "attempt-2",
          attemptNumber: 2,
          executionRound: 1,
          outcome: "timed_out",
        },
        {
          attemptId: "attempt-3",
          attemptNumber: 3,
          executionRound: 2,
          outcome: "failed",
        },
      ],
    });
    expect(await service.getSharedAttemptLog("token-1", "other-attempt")).toBeNull();
  });

  it("lets a permanent batch share read only the anchored case log family", async () => {
    const state = makeState({
      logChunks: [
        {
          attemptId: "attempt-3",
          stream: "stdout",
          sequence: 0,
          content: "shared from batch\n",
          recordedAt: "2026-08-17T00:05:01.000Z",
        },
      ],
    });
    const service = makeService(state, makeMultiRoundBatchDetails());

    const view = await service.getSharedAttemptLogForBatch("batch-1", "attempt-1", "attempt-3");

    expect(view).toMatchObject({
      batchId: "batch-1",
      attemptId: "attempt-3",
      logText: "shared from batch\n",
    });
    expect(await service.getSharedAttemptLogForBatch("another-batch", "attempt-1")).toBeNull();
    expect(
      await service.getSharedAttemptLogForBatch("batch-1", "attempt-1", "other-attempt"),
    ).toBeNull();
  });

  it("keeps DDT CaseID separate from the selected execution class in public logs", async () => {
    const source = makeBatchDetails("failed");
    source.runs[0] = {
      ...source.runs[0]!,
      caseType: "ddt",
      displayName: "WALLET-001",
      className: "example.WalletTest",
    };
    const diagnostic = makeBatchDetails("succeeded");
    diagnostic.id = "ddt-diagnostic";
    diagnostic.kind = "case_log_rerun";
    diagnostic.parentBatchId = source.id;
    diagnostic.sourceExecutionRunId = "run-1";
    diagnostic.runs[0] = {
      ...source.runs[0]!,
      id: "ddt-rerun",
      batchId: diagnostic.id,
      className: "example.SelectedExecutionTest",
    };
    diagnostic.attempts[0] = {
      ...diagnostic.attempts[0]!,
      id: "ddt-attempt",
      executionRunId: "ddt-rerun",
    };
    const state = makeState();
    const service = makeService(state, source, [diagnostic]);
    seedLegacyShare(state);
    expect(await service.getSharedAttemptLog("token-1")).toMatchObject({
      displayName: "WALLET-001",
      casePath: "example.WalletTest",
      caseType: "ddt",
    });
    expect(await service.getSharedAttemptLog("token-1", "ddt-attempt")).toMatchObject({
      displayName: "WALLET-001",
      casePath: "example.SelectedExecutionTest",
      caseType: "ddt",
    });
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
    const sourcePublication = "2026-08-16T00:00:00.000Z";
    const diagnosticPublication = "2026-08-17T00:06:00.000Z";
    const service = makeService(state, source, [diagnostic], {
      [source.id]: sourcePublication,
      [diagnostic.id]: diagnosticPublication,
    });
    seedLegacyShare(state);
    expect((await service.getSharedAttemptLog("token-1"))?.dependencyUpdatedAt).toBe(
      sourcePublication,
    );
    expect(
      (await service.getSharedAttemptLog("token-1", diagnostic.attempts[0]!.id))
        ?.dependencyUpdatedAt,
    ).toBe(diagnosticPublication);

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

  it("includes an in-progress diagnostic rerun so its realtime log can be opened", async () => {
    const state = makeState({
      logChunks: [
        {
          attemptId: "manual-running-attempt",
          stream: "stdout",
          sequence: 0,
          content: "manual rerun is still running\n",
          recordedAt: "2026-08-17T00:08:00.000Z",
        },
      ],
    });
    const source = makeBatchDetails("failed");
    const diagnostic = makeBatchDetails("succeeded");
    diagnostic.id = "diagnostic-running-batch";
    diagnostic.kind = "case_log_rerun";
    diagnostic.parentBatchId = source.id;
    diagnostic.sourceExecutionRunId = "run-1";
    diagnostic.status = "running";
    diagnostic.requestedBy = { username: "c12345678", source: "ldap" };
    diagnostic.runs[0] = {
      ...diagnostic.runs[0]!,
      id: "manual-running-run",
      batchId: diagnostic.id,
      status: "running",
    };
    diagnostic.attempts[0] = {
      id: "manual-running-attempt",
      executionRunId: "manual-running-run",
      runnerId: "runner-1",
      attemptNumber: 1,
      status: "running",
      schedulingScore: 1,
      version: 1,
      startedAt: "2026-08-17T00:07:45.000Z",
      createdAt: "2026-08-17T00:07:30.000Z",
    };
    const service = makeService(state, source, [diagnostic]);
    seedLegacyShare(state);

    const view = await service.getSharedAttemptLog("token-1", "manual-running-attempt");

    expect(view).toMatchObject({
      attemptId: "manual-running-attempt",
      outcome: "running",
      kind: "manual_rerun",
      logText: "manual rerun is still running\n",
      rounds: [
        expect.objectContaining({ attemptId: "attempt-1", outcome: "failed" }),
        expect.objectContaining({
          attemptId: "manual-running-attempt",
          outcome: "running",
          kind: "manual_rerun",
        }),
      ],
    });
  });

  it("preserves expiry checks on historical log URLs", async () => {
    const state = makeState();
    seedLegacyShare(state, "2026-08-16T00:00:00.000Z");
    expect(await makeService(state).getSharedAttemptLog("token-1")).toBeNull();
  });
});

function seedLegacyShare(state: FakeState, expiresAt = PERMANENT_LOG_ACCESS_EXPIRY): void {
  state.records.push({
    id: "legacy-share",
    tokenHash: "hashed-token-1",
    attemptId: "attempt-1",
    batchId: "batch-1",
    createdBy: "historical-reader",
    createdAt: "2026-08-01T00:00:00.000Z",
    expiresAt,
  });
}

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
      executionRound: 2,
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
      executionRound: 1,
      status: "timed_out",
      outcome: "timed_out",
      startedAt: "2026-08-17T00:03:00.000Z",
      finishedAt: "2026-08-17T00:04:00.000Z",
      createdAt: "2026-08-17T00:02:30.000Z",
    },
  ];
  return batch;
}
