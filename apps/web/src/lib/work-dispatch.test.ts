import { describe, expect, it, vi } from "vitest";

import type {
  ExecutionControlRepository,
  RunBatchSchedulingPort,
  RunBatchSchedulingService,
} from "@autoforge/application";

import {
  CoalescingSchedulingPort,
  workerBackedExecutionControlRepository,
  prioritizedExecutionControlRepository,
  workerBackedBatchCreation,
  workerBackedExecutionViewReads,
  workerBackedRunnerResourceReads,
} from "./work-dispatch";
import type { WorkDispatcher } from "./work-runtime";

describe("scheduling coalescing", () => {
  it("merges a burst into a leading and one trailing scan without losing a refill", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const local = {
      schedule: vi.fn().mockReturnValue(gate),
      scheduleForRunner: vi.fn().mockReturnValue(gate),
    } satisfies RunBatchSchedulingPort;
    const scheduling = new CoalescingSchedulingPort(local, undefined);

    const first = scheduling.scheduleForRunner("runner-1", 8);
    const second = scheduling.scheduleForRunner("runner-1", 8, 1);
    expect(first).toBe(second);
    expect(local.scheduleForRunner).toHaveBeenCalledOnce();
    expect(local.scheduleForRunner).toHaveBeenNthCalledWith(1, "runner-1", 8, undefined);

    release();
    await Promise.all([first, second]);
    expect(local.scheduleForRunner).toHaveBeenCalledTimes(2);
    expect(local.scheduleForRunner).toHaveBeenNthCalledWith(2, "runner-1", 8, 1);
    await scheduling.scheduleForRunner("runner-1", 8);
    expect(local.scheduleForRunner).toHaveBeenCalledTimes(3);
  });
});

describe("execution control work dispatch", () => {
  it("dispatches individual cancellation to control without using a read process", async () => {
    const cancelRun = vi.fn();
    const cancelExecutionRun = vi.fn().mockResolvedValue(true);
    const input = {
      runId: "run",
      actorId: "actor",
      eventId: "event",
      reason: "cancel",
      requestedAt: "2026-10-10T00:00:00.000Z",
    };
    const local = { cancelRun } as unknown as ExecutionControlRepository;
    const dispatcher = { cancelExecutionRun } as unknown as WorkDispatcher;
    await expect(
      workerBackedExecutionControlRepository(local, dispatcher).cancelRun(input),
    ).resolves.toBe(true);
    expect(cancelExecutionRun).toHaveBeenCalledWith(input);
    expect(cancelRun).not.toHaveBeenCalled();
  });
  it.each([
    "readExceptionRecords",
    "getAttemptLogSnapshot",
    "listAttemptsForExecutionRun",
    "listCaseLogRerunBatches",
    "listCasePage",
    "listMetadataPage",
    "getSummary",
    "get",
  ] as const)("moves %s scans away from HTTP and execution control", async (method) => {
    const local = {
      [method]: vi.fn(),
    } as unknown as import("@autoforge/application").RunBatchRepository;
    const readExecutionView = vi.fn().mockResolvedValue({ id: "isolated" });
    const dispatcher = { readExecutionView } as unknown as WorkDispatcher;
    const isolated = workerBackedExecutionViewReads(local, dispatcher);
    const input = { batchId: "batch", limit: 50 };
    const operation = Reflect.get(isolated, method) as (input: unknown) => Promise<unknown>;
    await expect(operation(input)).resolves.toEqual({ id: "isolated" });
    expect(readExecutionView).toHaveBeenCalledWith({ method, args: [input] });
    expect(Reflect.get(local, method)).not.toHaveBeenCalled();
  });
  it("isolates diagnostic reads while retaining local writes, method binding and fallback", async () => {
    const localBatches = {
      listSchedulingEvents: vi.fn(),
      appendSchedulingEvents: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("@autoforge/application").RunBatchRepository;
    const localRunners = {
      resourceSamples: vi.fn(),
      heartbeat: vi.fn().mockResolvedValue({ id: "runner" }),
    } as unknown as import("@autoforge/application").RunnerRepository;
    const dispatcher = {
      listSchedulingEvents: vi.fn().mockResolvedValue({ items: [] }),
      readRunnerResourceSamples: vi.fn().mockResolvedValue([]),
    } as unknown as WorkDispatcher;
    const batches = workerBackedExecutionViewReads(localBatches, dispatcher);
    const runners = workerBackedRunnerResourceReads(localRunners, dispatcher);
    const query = { batchId: "batch", runnerId: "runner", latest: true, limit: 500 };
    await expect(batches.listSchedulingEvents(query)).resolves.toEqual({ items: [] });
    expect(dispatcher.listSchedulingEvents).toHaveBeenCalledWith(query);
    await expect(runners.resourceSamples("runner", "start", "end")).resolves.toEqual([]);
    expect(dispatcher.readRunnerResourceSamples).toHaveBeenCalledWith({
      runnerId: "runner",
      since: "start",
      until: "end",
    });
    expect(localBatches.listSchedulingEvents).not.toHaveBeenCalled();
    expect(localRunners.resourceSamples).not.toHaveBeenCalled();
    await batches.appendSchedulingEvents([]);
    expect(localBatches.appendSchedulingEvents).toHaveBeenCalledWith([]);
    expect(workerBackedExecutionViewReads(localBatches, undefined)).toBe(localBatches);
    expect(workerBackedRunnerResourceReads(localRunners, undefined)).toBe(localRunners);
  });
  it.each(["local", "ldap"] as const)(
    "preserves a %s initiator through Lite batch dispatch",
    async (source) => {
      const createBatch = vi.fn().mockResolvedValue({ id: "worker-batch" });
      const local = { create: vi.fn() } as unknown as RunBatchSchedulingService;
      const dispatcher = { createBatch } as unknown as WorkDispatcher;
      const requestedBy = { username: "execution-operator", source };
      const input = { suiteId: "suite" };
      await workerBackedBatchCreation(local, dispatcher).create(input, requestedBy);
      expect(createBatch).toHaveBeenCalledWith({ input, requestedBy });
      expect(local.create).not.toHaveBeenCalled();
    },
  );

  it.each(["local", "ldap"] as const)(
    "preserves a %s initiator through DDT dispatch in both modes",
    async (source) => {
      const createSingleDdtCase = vi.fn().mockResolvedValue({ id: "ddt-batch" });
      const local = { createSingleDdtCase: vi.fn() } as unknown as RunBatchSchedulingService;
      const dispatcher = { createSingleDdtCase } as unknown as WorkDispatcher;
      const scope = { projectId: "project", projectVersionId: "version", testStageId: "stage" };
      const input = { runnerIds: ["runner"] };
      const requestedBy = { username: "execution-operator", source };
      for (const batchDispatcher of [dispatcher, undefined]) {
        await workerBackedBatchCreation(local, batchDispatcher, dispatcher).createSingleDdtCase(
          scope,
          "DDT-1",
          input,
          requestedBy,
        );
        expect(createSingleDdtCase).toHaveBeenLastCalledWith({
          scope,
          caseId: "DDT-1",
          input,
          requestedBy,
        });
      }
      expect(local.createSingleDdtCase).not.toHaveBeenCalled();
    },
  );

  it("offloads DDT snapshot creation in both modes without sending case data through the Web", async () => {
    const local = {
      create: vi.fn().mockResolvedValue({ id: "full-batch" }),
      createSingleDdtCase: vi.fn(),
    } as unknown as RunBatchSchedulingService;
    const createSingleDdtCase = vi.fn().mockResolvedValue({ id: "ddt-batch" });
    const dispatcher = { createSingleDdtCase } as unknown as WorkDispatcher;
    const scope = { projectId: "project", projectVersionId: "version", testStageId: "stage" };
    const input = { runnerIds: ["runner"] };
    for (const batchDispatcher of [dispatcher, undefined]) {
      const service = workerBackedBatchCreation(local, batchDispatcher, dispatcher);
      await expect(service.createSingleDdtCase(scope, "DDT-1", input)).resolves.toEqual({
        id: "ddt-batch",
      });
      expect(createSingleDdtCase).toHaveBeenLastCalledWith({ scope, caseId: "DDT-1", input });
    }
    expect(local.createSingleDdtCase).not.toHaveBeenCalled();
    await workerBackedBatchCreation(local, undefined, dispatcher).create({ suiteId: "suite" });
    expect(local.create).toHaveBeenCalledWith({ suiteId: "suite" });
  });
  it("creates a Lite batch in the worker while keeping reads bound to their repository", async () => {
    const local = {
      id: "local-summary",
      create: vi.fn(),
      getSummary() {
        return Promise.resolve(this.id);
      },
    };
    const createBatch = vi.fn().mockResolvedValue({ id: "worker-batch" });
    const dispatcher = { createBatch } as unknown as WorkDispatcher;
    const service = local as unknown as RunBatchSchedulingService;
    const isolated = workerBackedBatchCreation(service, dispatcher);
    await expect(isolated.create({ suiteId: "suite" })).resolves.toEqual({ id: "worker-batch" });
    expect(createBatch).toHaveBeenCalledWith({ input: { suiteId: "suite" } });
    expect(local.create).not.toHaveBeenCalled();
    await expect(isolated.getSummary("batch")).resolves.toBe("local-summary");
    expect(workerBackedBatchCreation(service, undefined)).toBe(service);
  });
  it("tracks actual Full control work while allowing dependent snapshot reads to progress", async () => {
    const finish = vi.fn();
    const begin = vi.fn(() => finish);
    const local = {
      listLogChunks: vi.fn(async () => ({ items: [] })),
      reconcile: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    } as unknown as ExecutionControlRepository;
    const repository = prioritizedExecutionControlRepository(local, begin);
    await repository.listLogChunks({
      attemptId: "one",
      stream: "stdout",
      afterSequence: -1,
      limit: 1,
    });
    expect(begin).not.toHaveBeenCalled();
    await expect(
      repository.reconcile({
        runnerId: "runner",
        now: "2026-09-07T00:00:00.000Z",
        request: { schemaVersion: 1, requestId: "reconcile", attempts: [] },
      }),
    ).rejects.toThrow("database unavailable");
    expect(begin).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
  });
  it("moves whole-batch termination away from the Web event loop", async () => {
    const input = {
      batchId: "batch-1",
      actorId: "operator-1",
      reason: "maintenance",
      eventId: "event-1",
      requestedAt: "2026-08-21T00:00:00.000Z",
    };
    const localTerminate = vi.fn().mockResolvedValue(0);
    const workerTerminate = vi.fn().mockResolvedValue(42);
    const local = { terminateBatch: localTerminate } as unknown as ExecutionControlRepository;
    const dispatcher = { terminateBatch: workerTerminate } as unknown as WorkDispatcher;
    const repository = workerBackedExecutionControlRepository(local, dispatcher);

    await expect(repository.terminateBatch(input)).resolves.toBe(42);
    expect(workerTerminate).toHaveBeenCalledWith(input);
    expect(localTerminate).not.toHaveBeenCalled();
  });

  it("moves log authorization and persistence to a dedicated worker lane", async () => {
    const input = {
      runnerId: "runner-1",
      attemptId: "attempt-1",
      leaseTokenHash: "lease-hash",
      receivedAt: "2026-08-21T00:00:00.000Z",
      chunks: [
        {
          stream: "stdout" as const,
          sequence: 0,
          content: "ready\n",
          recordedAt: "2026-08-21T00:00:00.000Z",
        },
      ],
    };
    const localAppend = vi.fn().mockResolvedValue({ acknowledgedSequence: { stdout: -1 } });
    const workerAppend = vi.fn().mockResolvedValue({ acknowledgedSequence: { stdout: 0 } });
    const local = { appendLogChunks: localAppend } as unknown as ExecutionControlRepository;
    const dispatcher = { appendAttemptLogChunks: workerAppend } as unknown as WorkDispatcher;
    const repository = workerBackedExecutionControlRepository(local, dispatcher);

    await expect(repository.appendLogChunks(input)).resolves.toEqual({
      acknowledgedSequence: { stdout: 0 },
    });
    expect(workerAppend).toHaveBeenCalledWith(input);
    expect(localAppend).not.toHaveBeenCalled();
  });
});
