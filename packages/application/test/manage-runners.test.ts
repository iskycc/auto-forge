import { describe, expect, it, vi } from "vitest";

import type {
  ExecutionControlRepository,
  RunBatchRepository,
  RunBatchSchedulingPort,
  RunnerRepository,
} from "../src/ports";
import { RunnerControlService } from "../src/manage-runners";

const now = new Date("2026-08-09T00:00:00.000Z");

function serviceWith(
  runners: Partial<RunnerRepository>,
  executions?: Partial<ExecutionControlRepository>,
  batches?: Partial<RunBatchRepository>,
  schedulingOverrides?: Partial<RunBatchSchedulingPort>,
) {
  const credentials = {
    issue: vi.fn().mockReturnValue("issued-credential"),
    issueBootstrapToken: vi.fn().mockReturnValue("issued-bootstrap-token"),
    hash: vi.fn((value: string) => `hash:${value}`),
    verifyBootstrapToken: vi.fn().mockReturnValue(true),
    replacementRunnerId: vi.fn().mockReturnValue(undefined),
  };
  const scheduling: RunBatchSchedulingPort = {
    schedule: vi.fn().mockResolvedValue(undefined),
    scheduleForRunner: vi.fn().mockResolvedValue(0),
    ...schedulingOverrides,
  };
  const service = new RunnerControlService(
    runners as RunnerRepository,
    credentials,
    executions as ExecutionControlRepository,
    { now: () => new Date(now.getTime()) },
    { next: vi.fn().mockReturnValue("event-id") },
    (batches ?? { appendSchedulingEvents: vi.fn() }) as RunBatchRepository,
    scheduling,
  );
  return { service, credentials, scheduling };
}

describe("RunnerControlService credentials", () => {
  it("recovers the existing logical Runner id during an authenticated reinstall", async () => {
    const register = vi.fn().mockImplementation(async (record) => ({
      id: record.id,
      name: record.name,
      state: "online",
    }));
    const { service, credentials } = serviceWith({ register });
    credentials.replacementRunnerId = vi.fn().mockReturnValue("runner-existing");

    await expect(
      service.register("reinstall-bootstrap", {
        schemaVersion: 1,
        name: "runner-a",
        os: "linux",
        architecture: "amd64",
        agentVersion: "1.2.7",
        protocolVersion: 1,
        labels: ["linux"],
        capabilities: ["executor:testng-v1"],
        maxConcurrency: 2,
        terminalEnabled: true,
      }),
    ).resolves.toMatchObject({
      runner: { id: "runner-existing" },
      result: { runnerId: "runner-existing" },
    });
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "runner-existing",
        recoverExistingIdentity: true,
        credentialHash: "hash:issued-credential",
      }),
    );
  });

  it("tells a re-enabled runner to resume assignment claims", async () => {
    const { service } = serviceWith({
      findByCredentialHash: vi.fn().mockResolvedValue({
        id: "runner-1",
        state: "online",
      }),
      heartbeat: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      service.heartbeat("runner-1", "runner-credential", {
        schemaVersion: 1,
        busySlots: 0,
        labels: ["linux"],
        capabilities: [],
        maxConcurrency: 2,
        agentVersion: "0.2.0",
        terminalEnabled: false,
      }),
    ).resolves.toMatchObject({ draining: false, disabled: false });
  });

  it("reconciles idle batch caches through heartbeat while the runner is disabled", async () => {
    const recordHeartbeat = vi.fn().mockResolvedValue(undefined);
    const listReusableBatchIdsForRunner = vi.fn().mockResolvedValue(["batch-open"]);
    const { service } = serviceWith(
      {
        findByCredentialHash: vi.fn().mockResolvedValue({
          id: "runner-1",
          state: "disabled",
        }),
        heartbeat: recordHeartbeat,
      },
      undefined,
      { listReusableBatchIdsForRunner },
    );

    await expect(
      service.heartbeat("runner-1", "runner-credential", {
        schemaVersion: 1,
        busySlots: 0,
        labels: ["linux"],
        capabilities: [],
        maxConcurrency: 2,
        agentVersion: "0.2.0",
        terminalEnabled: false,
        cachedBatchIds: ["batch-open", "batch-closed", "batch-foreign", "batch-closed"],
      }),
    ).resolves.toMatchObject({
      draining: true,
      disabled: true,
      closedBatchIds: ["batch-closed", "batch-foreign"],
    });
    expect(listReusableBatchIdsForRunner).toHaveBeenCalledWith("runner-1", [
      "batch-open",
      "batch-closed",
      "batch-foreign",
    ]);
    expect(recordHeartbeat).toHaveBeenCalledOnce();
  });

  it("records an administrator rotation request for the next heartbeat", async () => {
    const requestCredentialRotation = vi.fn().mockResolvedValue({
      id: "runner-1",
      state: "online",
      credentialRotationRequestedAt: now.toISOString(),
    });
    const { service } = serviceWith({
      get: vi.fn().mockResolvedValue({ id: "runner-1", state: "online" }),
      requestCredentialRotation,
    });

    await expect(service.requestCredentialRotation("runner-1")).resolves.toMatchObject({
      credentialRotationRequestedAt: now.toISOString(),
    });
    expect(requestCredentialRotation).toHaveBeenCalledWith({
      runnerId: "runner-1",
      requestedAt: now.toISOString(),
    });
  });

  it("rotates the credential with a fifteen minute grace period", async () => {
    const runner = { id: "runner-1", state: "online", credentialVersion: 1 };
    const rotateCredential = vi.fn().mockResolvedValue({ ...runner, credentialVersion: 2 });
    const { service } = serviceWith({
      findByCredentialHash: vi.fn().mockResolvedValue(runner),
      rotateCredential,
    });

    const rotation = await service.rotateCredential("runner-1", "current-credential");

    expect(rotateCredential).toHaveBeenCalledWith({
      runnerId: "runner-1",
      credentialHash: "hash:issued-credential",
      previousCredentialValidUntil: "2026-08-09T00:15:00.000Z",
      rotatedAt: "2026-08-09T00:00:00.000Z",
    });
    expect(rotation).toEqual({
      schemaVersion: 1,
      credential: "issued-credential",
      credentialVersion: 2,
      previousCredentialValidUntil: "2026-08-09T00:15:00.000Z",
    });
  });

  it("rejects rotation when the credential has been revoked", async () => {
    const { service } = serviceWith({
      findByCredentialHash: vi.fn().mockResolvedValue({
        id: "runner-1",
        state: "online",
        credentialRevokedAt: "2026-08-09T00:00:30.000Z",
      }),
      rotateCredential: vi.fn(),
    });

    await expect(service.rotateCredential("runner-1", "revoked-credential")).rejects.toMatchObject({
      code: "RUNNER_AUTH_REJECTED",
    });
  });

  it("rejects rotation for deregistered runners", async () => {
    const { service } = serviceWith({
      findByCredentialHash: vi.fn().mockResolvedValue({
        id: "runner-1",
        state: "disabled",
        deregisteredAt: "2026-08-09T00:00:30.000Z",
      }),
      rotateCredential: vi.fn(),
    });

    await expect(service.rotateCredential("runner-1", "old-credential")).rejects.toMatchObject({
      code: "RUNNER_AUTH_REJECTED",
    });
  });

  it("deregisters the runner and immediately recovers expired leases", async () => {
    const deregister = vi.fn().mockResolvedValue({ id: "runner-1", state: "disabled" });
    const recoverExpired = vi.fn().mockResolvedValue([
      {
        attemptId: "attempt-1",
        batchId: "batch-1",
        executionRunId: "run-1",
        runnerId: "runner-1",
        reason: "lease_expired",
        retryScheduled: true,
      },
    ]);
    const resolveAttemptSchedulingContext = vi.fn().mockResolvedValue({
      batchId: "batch-1",
      executionRunId: "run-1",
      runnerId: "runner-1",
      attemptNumber: 2,
      displayName: "冒烟用例",
    });
    const appendSchedulingEvents = vi.fn().mockResolvedValue(undefined);
    const { service, scheduling } = serviceWith(
      {
        get: vi.fn().mockResolvedValue({ id: "runner-1", state: "online" }),
        deregister,
      },
      { recoverExpired, resolveAttemptSchedulingContext },
      { appendSchedulingEvents },
    );

    await service.deregisterRunner("runner-1");

    expect(deregister).toHaveBeenCalledWith({
      runnerId: "runner-1",
      deregisteredAt: "2026-08-09T00:00:00.000Z",
    });
    expect(recoverExpired).toHaveBeenCalledWith({
      now: "2026-08-09T00:00:00.000Z",
      eventIds: expect.arrayContaining(["event-id"]),
      limit: 100,
    });
    expect(appendSchedulingEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        batchId: "batch-1",
        runnerId: "runner-1",
        executionRunId: "run-1",
        attemptId: "attempt-1",
        eventType: "attempt_completed",
        message:
          "用例「冒烟用例」第 2 次执行失败（LEASE_EXPIRED：执行机掉线，租约过期未完成），将安排重试",
        payload: {
          attemptNumber: 2,
          outcome: "failed",
          resultCode: "LEASE_EXPIRED",
          recoveryReason: "lease_expired",
          retryScheduled: true,
        },
      }),
      expect.objectContaining({
        batchId: "batch-1",
        runnerId: "runner-1",
        executionRunId: "run-1",
        attemptId: "attempt-1",
        eventType: "runner_fault_rescheduled",
        message: "非用例异常导致用例「冒烟用例」自动重新调度（LEASE_EXPIRED）",
        payload: {
          resultCode: "LEASE_EXPIRED",
          summary: "执行机掉线，租约过期未完成",
          recoveryReason: "lease_expired",
        },
      }),
    ]);
    expect(scheduling.schedule).toHaveBeenCalledWith("batch-1");
  });

  it("purges a deregistered runner record", async () => {
    const purge = vi.fn().mockResolvedValue({
      id: "runner-1",
      state: "disabled",
      deregisteredAt: "2026-08-08T23:59:00.000Z",
      purgedAt: now.toISOString(),
    });
    const { service } = serviceWith({
      get: vi.fn().mockResolvedValue({
        id: "runner-1",
        state: "disabled",
        deregisteredAt: "2026-08-08T23:59:00.000Z",
      }),
      purge,
    });

    await expect(service.purgeRunner("runner-1")).resolves.toMatchObject({
      purgedAt: "2026-08-09T00:00:00.000Z",
    });
    expect(purge).toHaveBeenCalledWith({
      runnerId: "runner-1",
      purgedAt: "2026-08-09T00:00:00.000Z",
    });
  });

  it("rejects purging a runner that has not been deregistered", async () => {
    const purge = vi.fn();
    const { service } = serviceWith({
      get: vi.fn().mockResolvedValue({ id: "runner-1", state: "online" }),
      purge,
    });

    await expect(service.purgeRunner("runner-1")).rejects.toMatchObject({
      code: "RUNNER_NOT_DELETABLE",
    });
    expect(purge).not.toHaveBeenCalled();
  });

  it("returns the already purged runner without rewriting it", async () => {
    const purged = {
      id: "runner-1",
      state: "disabled",
      deregisteredAt: "2026-08-08T23:59:00.000Z",
      purgedAt: "2026-08-08T23:59:30.000Z",
    };
    const purge = vi.fn();
    const { service } = serviceWith({
      get: vi.fn().mockResolvedValue(purged),
      purge,
    });

    await expect(service.purgeRunner("runner-1")).resolves.toBe(purged);
    expect(purge).not.toHaveBeenCalled();
  });

  it("rejects authentication for purged runners", async () => {
    const { service } = serviceWith({
      findByCredentialHash: vi.fn().mockResolvedValue({
        id: "runner-1",
        state: "disabled",
        deregisteredAt: "2026-08-08T23:59:00.000Z",
        purgedAt: "2026-08-08T23:59:30.000Z",
      }),
      rotateCredential: vi.fn(),
    });

    await expect(service.rotateCredential("runner-1", "old-credential")).rejects.toMatchObject({
      code: "RUNNER_AUTH_REJECTED",
    });
  });

  it("marks the credential as revoked", async () => {
    const revokeCredential = vi.fn().mockResolvedValue({ id: "runner-1" });
    const { service } = serviceWith({
      get: vi.fn().mockResolvedValue({ id: "runner-1", state: "online" }),
      revokeCredential,
    });

    await service.revokeCredential("runner-1");

    expect(revokeCredential).toHaveBeenCalledWith({
      runnerId: "runner-1",
      revokedAt: "2026-08-09T00:00:00.000Z",
    });
  });
});
