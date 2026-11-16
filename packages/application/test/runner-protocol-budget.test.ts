import { expect, it, vi } from "vitest";
import { ExecutionControlService } from "../src/control-executions";
import { DomainError } from "@autoforge/domain";
import type {
  ExecutionControlRepository,
  JarObjectStorePort,
  RunBatchRepository,
  RunBatchSchedulingPort,
  RunnerRepository,
} from "../src/ports";

it("uses persisted authenticated capacity and rejects traffic before accessing the log store", async () => {
  const assertAllowed = vi.fn().mockRejectedValue(new Error("rate denied"));
  const appendLogChunks = vi.fn();
  const executions = { appendLogChunks } as unknown as ExecutionControlRepository;
  const findByCredentialHash = vi
    .fn()
    .mockResolvedValue({ id: "runner", state: "online", protocolVersion: 1, maxConcurrency: 10 });
  const service = new ExecutionControlService(
    executions,
    { findByCredentialHash } as unknown as RunnerRepository,
    {
      issue: () => "",
      issueBootstrapToken: () => "",
      hash: (value) => value,
      verifyBootstrapToken: () => false,
    },
    { available: true, encrypt: (value) => value, decrypt: (value) => value },
    {} as JarObjectStorePort,
    { now: () => new Date("2026-11-13T14:00:00Z") },
    { next: () => "id" },
    {} as RunBatchRepository,
    {} as RunBatchSchedulingPort,
    undefined,
    { assertAllowed },
  );
  await expect(
    service.uploadLogs("runner", "credential", "attempt", {
      schemaVersion: 1,
      requestId: "request",
      leaseToken: "a".repeat(32),
      chunks: [],
    }),
  ).rejects.toThrow("rate denied");
  expect(assertAllowed).toHaveBeenCalledExactlyOnceWith({
    operation: "logs",
    runnerId: "runner",
    maximumConcurrency: 10,
  });
  expect(appendLogChunks).not.toHaveBeenCalled();
  findByCredentialHash.mockResolvedValue(null);
  assertAllowed.mockClear();
  await expect(
    service.uploadLogs("runner", "bad credential", "attempt", {
      schemaVersion: 1,
      requestId: "request",
      leaseToken: "a".repeat(32),
      chunks: [],
    }),
  ).rejects.toMatchObject({ code: "RUNNER_AUTH_REJECTED" });
  expect(assertAllowed).not.toHaveBeenCalled();
});

it("authorizes the lease before staging logs and never sends credentials into the durable queue", async () => {
  const authorizeLogUpload = vi.fn().mockResolvedValue({ batchId: "batch", runId: "run" });
  const persist = vi.fn().mockResolvedValue({ stdout: 0, stderr: -1, agent: -1 });
  const appendLogChunks = vi.fn();
  const executions = {
    authorizeLogUpload,
    appendLogChunks,
  } as unknown as ExecutionControlRepository;
  const service = new ExecutionControlService(
    executions,
    {
      findByCredentialHash: async () => ({
        id: "runner",
        state: "online",
        protocolVersion: 1,
        maxConcurrency: 10,
      }),
    } as unknown as RunnerRepository,
    {
      issue: () => "",
      issueBootstrapToken: () => "",
      hash: (value) => `hash:${value}`,
      verifyBootstrapToken: () => false,
    },
    { available: true, encrypt: (value) => value, decrypt: (value) => value },
    {} as JarObjectStorePort,
    { now: () => new Date("2026-11-14T01:00:00Z") },
    { next: () => "id" },
    {} as RunBatchRepository,
    {} as RunBatchSchedulingPort,
    undefined,
    undefined,
    { persist },
  );
  const upload = {
    schemaVersion: 1 as const,
    requestId: "request",
    leaseToken: "private-lease-token",
    chunks: [
      {
        stream: "stdout" as const,
        sequence: 0,
        content: "password=secret-value\n",
        recordedAt: "2026-11-14T01:00:00.000Z",
      },
    ],
  };
  const result = await service.uploadLogs("runner", "runner-secret-credential", "attempt", upload);
  expect(result).toMatchObject({ acknowledgedSequence: { stdout: 0 } });
  expect(authorizeLogUpload).toHaveBeenCalledExactlyOnceWith({
    runnerId: "runner",
    attemptId: "attempt",
    leaseTokenHash: "hash:private-lease-token",
    receivedAt: "2026-11-14T01:00:00.000Z",
  });
  expect(JSON.stringify(persist.mock.calls)).not.toMatch(
    /secret-value|private-lease-token|runner-secret-credential/,
  );
  expect(persist.mock.calls[0]?.[0]).toMatchObject({
    schemaVersion: 1,
    batchId: "batch",
    attemptId: "attempt",
  });
  expect(appendLogChunks).not.toHaveBeenCalled();
  persist.mockClear();
  authorizeLogUpload.mockRejectedValue(new DomainError("LEASE_AUTH_REJECTED", "invalid lease"));
  await expect(
    service.uploadLogs("runner", "runner-secret-credential", "attempt", upload),
  ).rejects.toMatchObject({ code: "LEASE_AUTH_REJECTED" });
  expect(persist).not.toHaveBeenCalled();
});
