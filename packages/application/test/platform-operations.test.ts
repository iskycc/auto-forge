import type { AuthenticatedIdentity, RunBatchDetails } from "@autoforge/domain";
import { describe, expect, it, vi } from "vitest";

import { PlatformOperationsService } from "../src/platform-operations";
import type { PlatformOperationsRepository, RunBatchRepository } from "../src/ports";

const timestamp = "2026-08-09T00:00:00.000Z";

describe("PlatformOperationsService analytics", () => {
  it("accepts project-scoped read permissions for schedules and global search", async () => {
    const repository = {
      listSchedules: vi.fn(async () => []),
      globalSearch: vi.fn(async () => ({ items: [] })),
    } as unknown as PlatformOperationsRepository;
    const service = new PlatformOperationsService(
      repository,
      { now: () => new Date(timestamp) },
      { next: () => "id" },
      { issue: () => "token", hash: (value) => value },
    );
    const reader: AuthenticatedIdentity = {
      ...projectIdentity,
      projectPermissions: {
        "project-1": ["case.read", "case_suite.read", "run.read"],
      },
    };

    await expect(service.listSchedules(reader)).resolves.toEqual([]);
    await expect(service.globalSearch(reader, "smoke", 10)).resolves.toEqual({ items: [] });
    expect(repository.listSchedules).toHaveBeenCalledWith(["project-1"]);
    expect(repository.globalSearch).toHaveBeenCalledWith({
      query: "smoke",
      limit: 10,
      projectIds: ["project-1"],
    });
  });

  it("compares only the common case scope and reports version/result/duration changes", async () => {
    const batches = {
      get: vi.fn(async (batchId: string) =>
        batchId === "left"
          ? batch(
              "left",
              [run("run-a-left", "case-a", 1), run("run-b", "case-b", 1)],
              [attempt("attempt-a-left", "run-a-left", "succeeded", 100)],
            )
          : batch(
              "right",
              [run("run-a-right", "case-a", 2), run("run-c", "case-c", 1)],
              [attempt("attempt-a-right", "run-a-right", "failed", 160)],
            ),
      ),
    } as unknown as RunBatchRepository;
    const service = new PlatformOperationsService(
      {} as PlatformOperationsRepository,
      { now: () => new Date(timestamp) },
      { next: () => "id" },
      { issue: () => "token", hash: (value) => value },
      undefined,
      batches,
    );

    const comparison = await service.compareBatches(identity, "left", "right");

    expect(comparison).toMatchObject({
      commonCaseCount: 1,
      onlyLeftCaseCount: 1,
      onlyRightCaseCount: 1,
      comparableScope: false,
      cases: expect.arrayContaining([
        expect.objectContaining({
          caseDefinitionId: "case-a",
          leftVersion: 1,
          rightVersion: 2,
          leftOutcome: "succeeded",
          rightOutcome: "failed",
          durationDeltaMs: 60,
        }),
      ]),
    });
  });

  it("persists a scoped export request and generates a bounded object in the worker", async () => {
    let dispatchJob:
      | Parameters<PlatformOperationsRepository["createAnalyticsExportJob"]>[0]["dispatchJob"]
      | undefined;
    let storedJob:
      Awaited<ReturnType<PlatformOperationsRepository["createAnalyticsExportJob"]>> | undefined;
    const repository = {
      createAnalyticsExportJob: vi.fn(async (record) => {
        dispatchJob = record.dispatchJob;
        storedJob = record.job;
        expect(record.projectIds).toEqual(["project-1"]);
        return record.job;
      }),
      claimAnalyticsExportJob: vi.fn(async () =>
        storedJob
          ? { job: { ...storedJob, status: "running" as const }, projectIds: ["project-1"] }
          : null,
      ),
      exportAnalytics: vi.fn(async () => [
        { project_id: "project-1", result: "=unsafe", duration_ms: 12 },
      ]),
      getAnalyticsExportJob: vi.fn(async () =>
        storedJob ? { ...storedJob, status: "running" as const } : null,
      ),
      updateAnalyticsExportJob: vi.fn(async (input) => ({
        ...storedJob!,
        ...input,
        requestedBy: storedJob!.requestedBy,
        filter: storedJob!.filter,
        format: storedJob!.format,
        createdAt: storedJob!.createdAt,
      })),
    } as unknown as PlatformOperationsRepository;
    let objectContent = "";
    const objectStore = {
      delete: vi.fn(async () => undefined),
      putObject: vi.fn(async (input) => {
        for await (const chunk of input.content) objectContent += new TextDecoder().decode(chunk);
        return { objectKey: input.objectKey, created: true };
      }),
      read: vi.fn(),
    };
    let nextId = 0;
    const service = new PlatformOperationsService(
      repository,
      { now: () => new Date(timestamp) },
      { next: () => `id-${++nextId}` },
      { issue: () => "token", hash: (value) => value },
      objectStore,
    );

    const job = await service.enqueueAnalyticsExport(
      projectIdentity,
      { format: "csv", filter: { projectId: "project-1" } },
      "request-1",
    );
    expect(job.status).toBe("queued");
    expect(dispatchJob?.kind).toBe("analytics-export");

    await service.analyticsExportJobHandler()(dispatchJob!, new AbortController().signal);

    expect(objectContent).toContain("duration_ms,project_id,result");
    expect(objectContent).toContain("'=unsafe");
    expect(objectStore.putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        objectKey: expect.stringContaining("/analytics-exports/user-project/"),
      }),
    );
    expect(repository.updateAnalyticsExportJob).toHaveBeenCalledWith(
      expect.objectContaining({ status: "succeeded", rowCount: 1, progressPercent: 100 }),
    );
  });
});

describe("PlatformOperationsService retention", () => {
  it("requires an exact confirmation before executing and processing object cleanup", async () => {
    const repository = {
      listRetentionPolicies: vi.fn(async () => [
        {
          category: "log" as const,
          retentionDays: 30,
          minimumDays: 7,
          maximumDays: 730,
          updatedAt: timestamp,
          revision: 1,
        },
      ]),
      executeRetention: vi.fn(async () => ({
        deletedRecords: 4,
        objectKeys: ["objects/one", "objects/two"],
      })),
      claimRetentionCleanupJobs: vi.fn(async () => []),
    } as unknown as PlatformOperationsRepository;
    const service = new PlatformOperationsService(
      repository,
      { now: () => new Date(timestamp) },
      { next: () => "cleanup-owner" },
      { issue: () => "token", hash: (value) => value },
      { delete: vi.fn(async () => undefined) },
    );

    await expect(
      service.executeRetentionNow(settingsAdministrator, "log", {
        confirmation: "artifact",
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: "RETENTION_CONFIRMATION_MISMATCH" });
    expect(repository.executeRetention).not.toHaveBeenCalled();

    await expect(
      service.executeRetentionNow(settingsAdministrator, "log", {
        confirmation: "log",
        limit: 10,
      }),
    ).resolves.toEqual({
      category: "log",
      deletedRecords: 4,
      queuedObjectDeletes: 2,
      completedObjectDeletes: 0,
    });
  });
});

const identity: AuthenticatedIdentity = {
  user: {
    id: "user-1",
    username: "analyst",
    displayName: "Analyst",
    source: "local",
    status: "active",
    forcePasswordChange: false,
    failedLoginAttempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
  },
  sessionId: "session-1",
  systemPermissions: ["run.read"],
  projectPermissions: {},
};

const projectIdentity: AuthenticatedIdentity = {
  ...identity,
  user: { ...identity.user, id: "user-project" },
  systemPermissions: [],
  projectPermissions: { "project-1": ["run.read"] },
};

const settingsAdministrator: AuthenticatedIdentity = {
  ...identity,
  user: { ...identity.user, id: "settings-admin" },
  systemPermissions: ["settings.manage"],
};

function batch(
  id: string,
  runs: RunBatchDetails["runs"],
  attempts: RunBatchDetails["attempts"],
): RunBatchDetails {
  return {
    id,
    projectId: "project-1",
    suiteId: "suite-1",
    suiteName: "Smoke",
    suiteVersion: id === "left" ? 1 : 2,
    status: "succeeded",
    priority: 0,
    retryLimit: 0,
    queueTimeoutMs: 1_000,
    claimTimeoutMs: 1_000,
    executionTimeoutMs: 1_000,
    uploadTimeoutMs: 1_000,
    environmentVariables: [],
    secretBindings: [],
    selectedRunnerIds: [id === "left" ? "runner-a" : "runner-b"],
    totalRuns: runs.length,
    queuedRuns: 0,
    assignedRuns: 0,
    runningRuns: 0,
    succeededRuns: runs.length,
    failedRuns: 0,
    timedOutRuns: 0,
    cancelledRuns: 0,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    runs,
    attempts,
    statusHistory: [],
  };
}

function run(id: string, caseDefinitionId: string, caseVersion: number) {
  return {
    id,
    batchId: "batch",
    caseDefinitionId,
    caseVersion,
    displayName: caseDefinitionId,
    className: `example.${caseDefinitionId}`,
    status: "succeeded" as const,
    attemptCount: 1,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function attempt(
  id: string,
  executionRunId: string,
  outcome: "succeeded" | "failed",
  durationMs: number,
) {
  return {
    id,
    executionRunId,
    runnerId: "runner-1",
    attemptNumber: 1,
    status: outcome,
    schedulingScore: 1,
    version: 1,
    outcome,
    durationMs,
    finishedAt: timestamp,
    createdAt: timestamp,
  };
}
