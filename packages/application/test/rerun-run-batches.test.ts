import { describe, expect, it, vi } from "vitest";

import type { RunBatchDetails } from "@autoforge/domain";

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
  it("reruns a terminal case as a hidden diagnostic batch from the immutable snapshot", async () => {
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
      adapterRuntimeSnapshot: {
        environmentAddresses: ["10.0.0.11", "10.0.0.12", "10.0.0.13"],
        jarBundle: { id: "bundle-snapshot" },
      },
      runs: [
        expect.objectContaining({
          caseDefinitionId: "case-failed",
          caseVersion: 7,
          parameters: { REGION: "west" },
        }),
      ],
    });
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
  });

  it("exposes only the latest realtime log target for a hidden case rerun", async () => {
    const details = rerunSnapshot().batch as RunBatchDetails;
    details.id = "diagnostic-batch";
    details.kind = "case_log_rerun";
    details.status = "running";
    details.attempts = [
      {
        ...attempt("manual-attempt-1", "manual-run", "failed"),
        createdAt: "2026-08-26T02:00:01.000Z",
      },
      {
        id: "manual-attempt-2",
        executionRunId: "manual-run",
        runnerId: "runner-1",
        attemptNumber: 1,
        status: "running",
        schedulingScore: 1,
        version: 1,
        createdAt: "2026-08-26T02:00:02.000Z",
      },
    ];
    const service = schedulingService({
      get: vi.fn().mockResolvedValue(details),
    } as unknown as RunBatchRepository);

    await expect(service.getCaseLogRerunLogTarget(details.id)).resolves.toEqual({
      projectId: "project-1",
      batchStatus: "running",
      attempt: { id: "manual-attempt-2", status: "running" },
    });
  });

  it("does not expose standard batches through the diagnostic log target", async () => {
    const details = rerunSnapshot().batch as RunBatchDetails;
    const service = schedulingService({
      get: vi.fn().mockResolvedValue(details),
    } as unknown as RunBatchRepository);

    await expect(service.getCaseLogRerunLogTarget(details.id)).rejects.toMatchObject({
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
    attemptStatus: "failed";
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
