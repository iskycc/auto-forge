import { describe, expect, it, vi } from "vitest";

import { PublicExecutionAccessService } from "../src/public-execution-access";
import type {
  PublicExecutionAccessRepository,
  RunBatchRepository,
  ExecutionControlRepository,
} from "../src/ports";

function fixture() {
  const batches = new Set<string>();
  const attempts = new Set<string>();
  const access: PublicExecutionAccessRepository = {
    publishBatch: vi.fn(async ({ batchId }) => {
      batches.add(batchId);
    }),
    publishAttempts: vi.fn(async (records) => {
      for (const record of records) attempts.add(record.attemptId);
    }),
    isBatchPublic: async (id) => batches.has(id),
    isAttemptPublic: async (id) => attempts.has(id),
  };
  const contexts = new Map([
    [
      "attempt-1",
      {
        attemptId: "attempt-1",
        batchId: "batch-1",
        executionRunId: "run-1",
        runnerId: "runner",
        attemptNumber: 1,
        displayName: "Case One",
      },
    ],
    [
      "attempt-2",
      {
        attemptId: "attempt-2",
        batchId: "batch-2",
        executionRunId: "run-2",
        runnerId: "runner",
        attemptNumber: 1,
        displayName: "Case Two",
      },
    ],
  ]);
  const executions = {
    resolveAttemptSchedulingContext: async (id: string) => contexts.get(id) ?? null,
    resolveAttemptSchedulingContexts: async (ids: readonly string[]) =>
      ids.flatMap((id) => (contexts.has(id) ? [contexts.get(id)!] : [])),
    resolveAttemptProjectId: async (id: string) => (contexts.has(id) ? "project-1" : null),
  } as Pick<
    ExecutionControlRepository,
    | "resolveAttemptSchedulingContext"
    | "resolveAttemptSchedulingContexts"
    | "resolveAttemptProjectId"
  >;
  const logs = {
    getSharedAttemptLogForBatch: vi.fn().mockResolvedValue({ attemptId: "attempt-1" }),
  };
  const metadata = { getMetadata: vi.fn().mockResolvedValue({ id: "batch-1" }) } as unknown as Pick<
    RunBatchRepository,
    "getMetadata"
  >;
  const service = new PublicExecutionAccessService(access, metadata, executions, logs, {
    now: () => new Date("2026-10-10T00:00:00.000Z"),
  });
  return { service, access, logs, batches, attempts, metadata };
}

describe("public execution access by business ID", () => {
  it("does not expose an unpublished attempt or batch when its ID is known", async () => {
    const { service, logs } = fixture();
    expect(await service.isBatchPublic("batch-1")).toBe(false);
    expect(await service.readAttemptLog("attempt-1")).toBeNull();
    expect(logs.getSharedAttemptLogForBatch).not.toHaveBeenCalled();
  });

  it("creates stable business URLs and publishes duplicate attempts only once per call", async () => {
    const { service, access } = fixture();
    const links = await service.ensureLinksForAttempts(["attempt-1", "attempt-1"], "reader");
    expect(links).toEqual(new Map([["attempt-1", "/CaseLog?ExecutionId=attempt-1"]]));
    expect(access.publishAttempts).toHaveBeenCalledWith([
      { attemptId: "attempt-1", createdBy: "reader", createdAt: "2026-10-10T00:00:00.000Z" },
    ]);
    expect(await service.ensureLinkForAttempt("attempt-1", "reader", ["project-1"])).toBe(
      links.get("attempt-1"),
    );
  });

  it("checks project scope before publishing a log", async () => {
    const { service, access } = fixture();
    await expect(
      service.ensureLinkForAttempt("attempt-1", "reader", ["other-project"]),
    ).rejects.toMatchObject({ code: "RUN_ATTEMPT_NOT_FOUND" });
    expect(access.publishAttempts).not.toHaveBeenCalled();
  });

  it("rejects foreign-batch and missing attempts before any publication", async () => {
    const { service, access } = fixture();
    await expect(
      service.ensureLinksForAttemptsInBatch(["attempt-1", "attempt-2"], "batch-1", "reader"),
    ).rejects.toMatchObject({ code: "RUN_ATTEMPT_NOT_FOUND" });
    await expect(
      service.ensureLinksForAttempts(["attempt-1", "missing"], "reader"),
    ).rejects.toMatchObject({ code: "RUN_ATTEMPT_NOT_FOUND" });
    expect(access.publishAttempts).not.toHaveBeenCalled();
  });

  it("reuses the existing bounded log and history reader after an explicit log grant", async () => {
    const { service, logs } = fixture();
    await service.ensureLinkForAttempt("attempt-1", "reader");
    await service.readAttemptLog("attempt-1", "selected-round");
    expect(logs.getSharedAttemptLogForBatch).toHaveBeenCalledWith(
      "batch-1",
      "attempt-1",
      "selected-round",
    );
    expect(await service.readAttemptLog("attempt-2")).toBeNull();
  });

  it("publishes batch details without granting another batch's logs", async () => {
    const { service, logs, metadata } = fixture();
    expect(await service.publishBatch("batch-1", "reader", ["project-1"])).toBe(
      "/Execution?BatchId=batch-1",
    );
    expect(metadata.getMetadata).toHaveBeenCalledWith("batch-1", ["project-1"]);
    expect(await service.isBatchPublic("batch-1")).toBe(true);
    await service.readAttemptLog("attempt-1");
    expect(logs.getSharedAttemptLogForBatch).toHaveBeenCalledOnce();
    expect(await service.readAttemptLog("attempt-2")).toBeNull();
  });

  it("does not publish a missing or out-of-scope batch", async () => {
    const { service, access, metadata } = fixture();
    vi.mocked(metadata.getMetadata).mockResolvedValue(null);
    await expect(service.publishBatch("missing", "reader")).rejects.toMatchObject({
      code: "RUN_BATCH_NOT_FOUND",
    });
    expect(access.publishBatch).not.toHaveBeenCalled();
  });

  it("does no I/O for an empty export page", async () => {
    const { service, access } = fixture();
    expect(await service.ensureLinksForAttemptsInBatch([], "batch-1", "reader")).toEqual(new Map());
    expect(access.publishAttempts).not.toHaveBeenCalled();
  });
});
