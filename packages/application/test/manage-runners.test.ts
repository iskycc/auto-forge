import { describe, expect, it, vi } from "vitest";

import type { ExecutionControlRepository, RunnerRepository } from "../src/ports";
import { RunnerControlService } from "../src/manage-runners";

const now = new Date("2026-08-09T00:00:00.000Z");

function serviceWith(
  runners: Partial<RunnerRepository>,
  executions?: Partial<ExecutionControlRepository>,
) {
  const credentials = {
    issue: vi.fn().mockReturnValue("issued-credential"),
    issueBootstrapToken: vi.fn().mockReturnValue("issued-bootstrap-token"),
    hash: vi.fn((value: string) => `hash:${value}`),
    verifyBootstrapToken: vi.fn().mockReturnValue(true),
  };
  const service = new RunnerControlService(
    runners as RunnerRepository,
    credentials,
    executions as ExecutionControlRepository,
    { now: () => new Date(now.getTime()) },
    { next: vi.fn().mockReturnValue("event-id") },
  );
  return { service, credentials };
}

describe("RunnerControlService credentials", () => {
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
    const recoverExpired = vi.fn().mockResolvedValue(1);
    const { service } = serviceWith(
      {
        get: vi.fn().mockResolvedValue({ id: "runner-1", state: "online" }),
        deregister,
      },
      { recoverExpired },
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
