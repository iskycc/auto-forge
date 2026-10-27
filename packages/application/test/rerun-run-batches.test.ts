import { describe, expect, it, vi } from "vitest";

import { DomainError, type RunBatchDetails } from "@autoforge/domain";

import { RunBatchSchedulingService } from "../src/schedule-run-batches";
import type {
  CaseSuiteRepository,
  CreateRunBatchRecord,
  RunBatchRepository,
  RunBatchRerunSnapshot,
  RunnerRepository,
} from "../src/ports";

const now = "2026-08-26T02:00:00.000Z";

describe("derived run batches", () => {
  it.each([
    ["testng", "10.0.0.99"],
    ["ddt", "10.0.0.99"],
    ["testng", "10.0.0.13"],
    ["ddt", "10.0.0.13"],
  ] as const)(
    "uses IP %s / %s only for this log rerun and resets the next one",
    async (caseType, environmentIp) => {
      const snapshot = rerunSnapshot();
      snapshot.runs[1]!.caseType = caseType;
      const original = structuredClone(snapshot);
      const { batches, created } = rerunRepository(snapshot, {
        batchId: snapshot.batch.id,
        executionRunId: "run-failed",
        attemptStatus: "failed",
      });
      const service = schedulingService(batches);
      const initiator = { username: "operator", source: "local" as const };
      await service.rerunCaseFromAttempt("attempt-failed", initiator, {
        environmentIp,
      });
      expect(created[0]?.adapter?.environmentAddresses).toEqual([environmentIp]);
      expect(snapshot).toEqual(original);
      vi.spyOn(batches, "getMetadata").mockResolvedValue({
        ...snapshot.batch,
        id: "manual",
        kind: "case_log_rerun",
        parentBatchId: snapshot.batch.id,
        sourceExecutionRunId: "run-failed",
        totalRuns: 1,
      });
      await expect(service.getCaseLogRerunConfiguration("manual-attempt")).resolves.toEqual({
        adapterEnabled: true,
        environmentIp: "10.0.0.12",
      });
      await service.rerunCaseFromAttempt("manual-attempt", initiator);
      expect(created[1]?.adapter?.environmentAddresses).toEqual(["10.0.0.12"]);
      expect(snapshot).toEqual(original);
    },
  );

  it("validates an edited IP before reading or creating execution state", async () => {
    const { batches, created } = rerunRepository(rerunSnapshot(), {
      batchId: "batch-source",
      executionRunId: "run-failed",
      attemptStatus: "failed",
    });
    const service = schedulingService(batches);
    for (const environmentIp of ["", "invalid", "10.0.0.999", "10.0.0.1,10.0.0.2"]) {
      await expect(
        service.rerunCaseFromAttempt(
          "attempt-failed",
          { username: "operator", source: "local" },
          { environmentIp },
        ),
      ).rejects.toThrow();
    }
    expect(batches.resolveAttemptRerunSource).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it("reads the original environment without creating a batch or persisting changes", async () => {
    const { batches, created } = rerunRepository(rerunSnapshot(), {
      batchId: "batch-source",
      executionRunId: "run-failed",
      attemptStatus: "failed",
    });
    await expect(
      schedulingService(batches).getCaseLogRerunConfiguration("attempt-failed"),
    ).resolves.toEqual({ adapterEnabled: true, environmentIp: "10.0.0.12" });
    expect(created).toEqual([]);
  });

  it("accepts IPv6 for one manual execution", async () => {
    const { batches, created } = rerunRepository(rerunSnapshot(), {
      batchId: "batch-source",
      executionRunId: "run-failed",
      attemptStatus: "failed",
    });
    await schedulingService(batches).rerunCaseFromAttempt(
      "attempt-failed",
      { username: "operator", source: "local" },
      { environmentIp: "2001:db8::99" },
    );
    expect(created[0]?.adapter?.environmentAddresses).toEqual(["2001:db8::99"]);
  });

  it("keeps an execution without Adapter unchanged and rejects an IP override", async () => {
    const snapshot = rerunSnapshot();
    delete snapshot.adapterRuntime;
    const { batches, created } = rerunRepository(snapshot, {
      batchId: "batch-source",
      executionRunId: "run-failed",
      attemptStatus: "failed",
    });
    const service = schedulingService(batches);
    await expect(service.getCaseLogRerunConfiguration("attempt-failed")).resolves.toEqual({
      adapterEnabled: false,
      environmentIp: null,
    });
    await expect(
      service.rerunCaseFromAttempt(
        "attempt-failed",
        { username: "operator", source: "local" },
        { environmentIp: "10.0.0.99" },
      ),
    ).rejects.toMatchObject({ code: "RUN_RERUN_ENVIRONMENT_UNAVAILABLE" });
    expect(created).toEqual([]);
    await service.rerunCaseFromAttempt("attempt-failed", { username: "operator", source: "local" });
    expect(created[0]).not.toHaveProperty("adapter");
  });

  it("preserves a Chinese DDT CaseId and its execution class when creating a log rerun", async () => {
    const snapshot = rerunSnapshot();
    const run = snapshot.runs.find((item) => item.id === "run-failed")!;
    Object.assign(run, {
      caseType: "ddt",
      caseDefinitionId: "ddt-record",
      executionCaseDefinitionId: "testng-class",
      displayName: "订单支付_中文001",
      ddtSrNum: "支付需求",
    });
    const { batches, created } = rerunRepository(snapshot, {
      batchId: snapshot.batch.id,
      executionRunId: run.id,
      attemptStatus: "failed",
    });
    await schedulingService(batches).rerunCaseFromAttempt("attempt-failed", {
      username: "operator",
      source: "local",
    });
    expect(created[0]?.runs).toEqual([
      expect.objectContaining({
        caseType: "ddt",
        caseDefinitionId: "ddt-record",
        executionCaseDefinitionId: "testng-class",
        displayName: "订单支付_中文001",
        ddtSrNum: "支付需求",
      }),
    ]);
  });
  it.each([500, 501, 100_000])(
    "reruns a completed case from an active %i-case batch without reading full details",
    async (totalRuns) => {
      const snapshot = rerunSnapshot();
      snapshot.batch.totalRuns = totalRuns;
      snapshot.batch.status = "running";
      const { batches, created } = rerunRepository(snapshot, {
        batchId: snapshot.batch.id,
        executionRunId: "run-failed",
        attemptStatus: "failed",
      });
      const fullDetails = vi
        .spyOn(batches, "get")
        .mockRejectedValue(
          new DomainError("DETAIL_RESPONSE_TOO_LARGE", "请使用摘要及分页接口读取大批次。"),
        );

      await schedulingService(batches).rerunCaseFromAttempt("attempt-failed", {
        username: "operator",
        source: "local",
      });

      expect(fullDetails).not.toHaveBeenCalled();
      expect(batches.getMetadata).toHaveBeenCalledWith(snapshot.batch.id);
      expect(batches.getRerunSnapshot).toHaveBeenCalledWith(snapshot.batch.id, {
        executionRunId: "run-failed",
      });
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        kind: "case_log_rerun",
        parentBatchId: snapshot.batch.id,
        sourceExecutionRunId: "run-failed",
        runs: [expect.objectContaining({ caseDefinitionId: "case-failed" })],
      });
    },
  );

  it("keeps repeated manual executions anchored to the original large batch and case", async () => {
    const snapshot = rerunSnapshot();
    snapshot.batch.totalRuns = 100_000;
    const { batches, created } = rerunRepository(snapshot, {
      batchId: "previous-diagnostic-batch",
      executionRunId: "previous-diagnostic-run",
      attemptStatus: "failed",
    });
    vi.spyOn(batches, "getMetadata").mockResolvedValue({
      ...snapshot.batch,
      id: "previous-diagnostic-batch",
      kind: "case_log_rerun",
      parentBatchId: snapshot.batch.id,
      sourceExecutionRunId: "run-failed",
      totalRuns: 1,
    });
    const fullDetails = vi
      .spyOn(batches, "get")
      .mockRejectedValue(
        new DomainError("DETAIL_RESPONSE_TOO_LARGE", "请使用摘要及分页接口读取大批次。"),
      );

    await schedulingService(batches).rerunCaseFromAttempt("previous-diagnostic-attempt", {
      username: "operator",
      source: "local",
    });

    expect(fullDetails).not.toHaveBeenCalled();
    expect(batches.getRerunSnapshot).toHaveBeenCalledWith(snapshot.batch.id, {
      executionRunId: "run-failed",
    });
    expect(created[0]).toMatchObject({
      parentBatchId: snapshot.batch.id,
      sourceExecutionRunId: "run-failed",
      runs: [expect.objectContaining({ caseDefinitionId: "case-failed" })],
    });
  });

  it.each(["assigned", "running"] as const)(
    "rejects a %s attempt before reading its batch or creating a rerun",
    async (attemptStatus) => {
      const { batches, created } = rerunRepository(rerunSnapshot(), {
        batchId: "batch-source",
        executionRunId: "run-failed",
        attemptStatus,
      });
      await expect(
        schedulingService(batches).rerunCaseFromAttempt("attempt-live", {
          username: "operator",
          source: "local",
        }),
      ).rejects.toMatchObject({ code: "RUN_ATTEMPT_NOT_TERMINAL" });
      expect(batches.getMetadata).not.toHaveBeenCalled();
      expect(batches.get).not.toHaveBeenCalled();
      expect(created).toEqual([]);
    },
  );

  it("keeps the personal DDT API on both diagnostic and final-failure reruns", async () => {
    const snapshot = rerunSnapshot();
    const debug = {
      ownerUserId: "personal-owner",
      accessKey: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    };
    snapshot.adapterRuntime!.ddtDebug = debug;
    const { batches, created } = rerunRepository(snapshot, {
      batchId: snapshot.batch.id,
      executionRunId: "run-failed",
      attemptStatus: "failed",
    });
    const service = schedulingService(batches);
    await service.rerunCaseFromAttempt("attempt-failed", { username: "owner", source: "local" });
    expect(created[0]?.ddtDebug).toEqual(debug);
    await service.rerunFinalFailures(
      snapshot.batch.id,
      { concurrency: 1, enableRetryConcurrencyRules: false, enableRoundRecovery: false },
      { username: "owner", source: "local" },
    );
    expect(created[1]?.adapterRuntimeSnapshot?.ddtDebug).toEqual(debug);
  });

  it("reruns a terminal case with current project-version runtime assets", async () => {
    const snapshot = rerunSnapshot();
    const { batches, created } = rerunRepository(snapshot, {
      batchId: snapshot.batch.id,
      executionRunId: "run-failed",
      attemptStatus: "failed",
    });
    const service = schedulingService(batches);

    await service.rerunCaseFromAttempt("attempt-failed", {
      username: "c12345678",
      source: "ldap",
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      kind: "case_log_rerun",
      parentBatchId: "batch-source",
      sourceExecutionRunId: "run-failed",
      requestedBy: { username: "c12345678", source: "ldap" },
      retryLimit: 0,
      retryMode: "immediate",
      policy: { concurrency: 1, retryConcurrencyRules: [] },
      roundRecoveries: [],
      adapter: {
        enabled: true,
        suiteName: "adapter-suite",
        testName: "adapter-test",
        environmentAddresses: ["10.0.0.12"],
      },
      runs: [
        expect.objectContaining({
          caseDefinitionId: "case-failed",
          caseVersion: 7,
          parameters: { REGION: "west" },
        }),
      ],
    });
    expect(created[0]).not.toHaveProperty("adapterRuntimeSnapshot");
  });

  it("creates a visible batch from only the final failures and accepts one-off policy switches", async () => {
    const snapshot = rerunSnapshot();
    const { batches, created } = rerunRepository(snapshot);
    const service = schedulingService(batches);

    await service.rerunFinalFailures(
      snapshot.batch.id,
      {
        concurrency: 17,
        enableRetryConcurrencyRules: false,
        enableRoundRecovery: false,
      },
      { username: "admin", source: "local" },
    );

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      kind: "final_failure_rerun",
      parentBatchId: "batch-source",
      requestedBy: { username: "admin", source: "local" },
      retryLimit: 2,
      retryMode: "round",
      policy: { concurrency: 17, retryConcurrencyRules: [] },
      roundRecoveries: [],
    });
    expect(created[0]!.runs.map((run) => run.caseDefinitionId)).toEqual([
      "case-failed",
      "case-timeout",
    ]);
    expect(created[0]?.adapterRuntimeSnapshot?.environmentAddresses).toEqual([
      "10.0.0.11",
      "10.0.0.12",
      "10.0.0.13",
    ]);
    expect(created[0]?.adapterRuntimeSnapshot?.jarBundle?.id).toBe("bundle-snapshot");
  });

  it("exposes only the latest realtime log target for a hidden case rerun", async () => {
    const target = {
      projectId: "project-1",
      batchStatus: "running",
      attempt: { id: "manual-attempt-2", status: "running" },
    };
    const readTarget = vi.fn().mockResolvedValue(target);
    const fullDetails = vi.fn().mockRejectedValue(new Error("Log targets must not load details"));
    const service = schedulingService({
      getCaseLogRerunLogTarget: readTarget,
      get: fullDetails,
    } as unknown as RunBatchRepository);

    await expect(service.getCaseLogRerunLogTarget("diagnostic-batch")).resolves.toEqual(target);
    expect(readTarget).toHaveBeenCalledWith("diagnostic-batch");
    expect(fullDetails).not.toHaveBeenCalled();
  });

  it("does not expose standard batches through the diagnostic log target", async () => {
    const service = schedulingService({
      getCaseLogRerunLogTarget: vi.fn().mockResolvedValue(null),
    } as unknown as RunBatchRepository);

    await expect(service.getCaseLogRerunLogTarget("standard-batch")).rejects.toMatchObject({
      code: "RUN_BATCH_NOT_FOUND",
    });
  });

  it("rejects final-failure reruns before the source batch reaches a terminal state", async () => {
    const snapshot = rerunSnapshot();
    snapshot.batch.status = "running";
    const { batches } = rerunRepository(snapshot);
    const service = schedulingService(batches);

    await expect(
      service.rerunFinalFailures(
        snapshot.batch.id,
        {
          concurrency: 4,
          enableRetryConcurrencyRules: true,
          enableRoundRecovery: true,
        },
        { username: "admin", source: "local" },
      ),
    ).rejects.toMatchObject({ code: "RUN_BATCH_NOT_TERMINAL" });
  });
});

function schedulingService(batches: RunBatchRepository): RunBatchSchedulingService {
  let nextId = 0;
  return new RunBatchSchedulingService(
    batches,
    {} as CaseSuiteRepository,
    {} as RunnerRepository,
    { now: () => new Date(now) },
    { next: () => `derived-${++nextId}` },
    {
      maximumCpuUtilizationPercent: 85,
      maximumMemoryUtilizationPercent: 85,
      maximumLoadPerCpu: 1,
    },
    45,
  );
}

function rerunRepository(
  snapshot: RunBatchRerunSnapshot,
  attemptSource?: {
    batchId: string;
    executionRunId: string;
    attemptStatus: "failed" | "assigned" | "running";
  },
): { batches: RunBatchRepository; created: CreateRunBatchRecord[] } {
  const created: CreateRunBatchRecord[] = [];
  const derivedSummary = () => ({
    ...snapshot.batch,
    id: created.at(-1)?.id ?? "derived",
    kind: created.at(-1)?.kind,
    status: "queued" as const,
    scheduledFor: now,
    assignedRuns: 0,
  });
  const batches = {
    resolveAttemptRerunSource: vi.fn().mockResolvedValue(attemptSource ?? null),
    getMetadata: vi.fn(async (batchId: string) =>
      batchId === snapshot.batch.id ? snapshot.batch : derivedSummary(),
    ),
    getRerunSnapshot: vi.fn(
      async (
        _batchId: string,
        selection: { executionRunId?: string; finalFailuresOnly?: boolean },
      ) => {
        const selectedIndexes = snapshot.runs.flatMap((run, index) => {
          if (selection.executionRunId) return run.id === selection.executionRunId ? [index] : [];
          if (selection.finalFailuresOnly) return index > 0 ? [index] : [];
          return [index];
        });
        return {
          ...snapshot,
          runs: selectedIndexes.map((index) => snapshot.runs[index]!),
        };
      },
    ),
    get: vi.fn(async (batchId: string) =>
      batchId === snapshot.batch.id ? snapshot.batch : derivedSummary(),
    ),
    create: vi.fn(async (record: CreateRunBatchRecord) => {
      created.push(record);
      return derivedSummary();
    }),
    getSchedulingSnapshot: vi.fn(async () => ({
      batch: derivedSummary(),
      queuedRuns: [],
      candidates: [],
      projectActiveRuns: 0,
      runnerFailureIdsByRun: {},
    })),
    hasSchedulableRuns: vi.fn().mockResolvedValue(false),
    getSummary: vi.fn(async () => derivedSummary()),
  } as unknown as RunBatchRepository;
  return { batches, created };
}

function rerunSnapshot(): RunBatchRerunSnapshot {
  const batch: RunBatchDetails = {
    id: "batch-source",
    sequenceNumber: 88,
    projectId: "project-1",
    suiteId: "suite-1",
    suiteName: "Full regression",
    suiteVersion: 9,
    kind: "standard",
    status: "failed",
    priority: 3,
    retryLimit: 2,
    retryMode: "round",
    currentRound: 3,
    queueTimeoutMs: 86_400_000,
    claimTimeoutMs: 300_000,
    executionTimeoutMs: 600_000,
    uploadTimeoutMs: 600_000,
    environmentVariables: [],
    secretBindings: [],
    selectedRunnerIds: ["runner-1", "runner-2"],
    policy: {
      executor: "testng",
      concurrency: 80,
      projectVersionId: "version-1",
      runnerLabels: ["java"],
      artifactPatterns: ["reports/**"],
      retryConcurrencyRules: [{ id: "rule-1", executionRound: 2, concurrency: 40 }],
    },
    totalRuns: 3,
    queuedRuns: 0,
    assignedRuns: 0,
    runningRuns: 0,
    succeededRuns: 1,
    failedRuns: 1,
    timedOutRuns: 1,
    cancelledRuns: 0,
    version: 4,
    scheduledFor: "2026-08-26T00:00:00.000Z",
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T01:00:00.000Z",
    runs: [
      executionRun("run-passed", "case-passed", "succeeded"),
      executionRun("run-failed", "case-failed", "failed"),
      executionRun("run-timeout", "case-timeout", "timed_out"),
    ],
    attempts: [
      attempt("attempt-passed", "run-passed", "succeeded"),
      attempt("attempt-failed", "run-failed", "failed"),
      attempt("attempt-timeout", "run-timeout", "timed_out"),
    ],
    roundConcurrencies: [],
    roundRecoveries: [],
    statusHistory: [],
  };
  return {
    batch,
    adapterRuntime: {
      suiteName: "adapter-suite",
      testName: "adapter-test",
      environmentAddresses: ["10.0.0.11", "10.0.0.12", "10.0.0.13"],
      jarBundle: {
        id: "bundle-snapshot",
        sourceType: "upload",
        sha256: "a".repeat(64),
        sizeBytes: 1024,
        archiveFormat: "zip",
      },
    },
    sourceAdapterEnvironmentAddress: "10.0.0.12",
    roundRecoveries: [
      {
        ruleId: "recover-1",
        afterRound: 1,
        jenkinsJobUrl: "https://jenkins.example/job/reset/",
        apiKeyCiphertext: "encrypted",
        waitMinutes: 5,
      },
    ],
    runs: [
      runSnapshot("run-passed", "case-passed", "east"),
      runSnapshot("run-failed", "case-failed", "west"),
      runSnapshot("run-timeout", "case-timeout", "north"),
    ],
  };
}

function runSnapshot(id: string, caseDefinitionId: string, region: string) {
  return {
    id,
    caseDefinitionId,
    caseVersion: 7,
    displayName: caseDefinitionId,
    className: `example.${caseDefinitionId}`,
    parameters: { REGION: region },
  };
}

function executionRun(
  id: string,
  caseDefinitionId: string,
  outcome: "succeeded" | "failed" | "timed_out",
) {
  return {
    ...runSnapshot(id, caseDefinitionId, "unused"),
    batchId: "batch-source",
    status: outcome === "timed_out" ? ("failed" as const) : outcome,
    attemptCount: 1,
    terminalOutcome: outcome,
    version: 2,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T01:00:00.000Z",
  };
}

function attempt(
  id: string,
  executionRunId: string,
  outcome: "succeeded" | "failed" | "timed_out",
) {
  return {
    id,
    executionRunId,
    runnerId: "runner-1",
    attemptNumber: 3,
    status: outcome,
    outcome,
    schedulingScore: 1,
    version: 2,
    createdAt: "2026-08-26T00:30:00.000Z",
  };
}
