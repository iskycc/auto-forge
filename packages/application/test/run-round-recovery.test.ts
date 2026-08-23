import { describe, expect, it, vi } from "vitest";

import { RoundRecoveryService } from "../src/run-round-recovery";
import type {
  JenkinsRoundRecoveryTransport,
  RoundRecoveryClaim,
  RoundRecoveryRepository,
  RunBatchRepository,
  RunBatchSchedulingPort,
  SecretCipherPort,
} from "../src/ports";

const now = "2026-08-23T00:00:00.000Z";

describe("RoundRecoveryService", () => {
  it("decrypts the snapshot credential and triggers Rebuild for the last Jenkins build", async () => {
    const repository = repositoryWithClaim(claim({ status: "pending" }));
    const transport = {
      rebuildLast: vi.fn().mockResolvedValue({ sourceBuildNumber: 41 }),
      inspectRebuild: vi.fn(),
    } as JenkinsRoundRecoveryTransport;
    const service = createService(repository, transport);

    await service.dispatchDue("worker-1");

    expect(transport.rebuildLast).toHaveBeenCalledWith({
      jobUrl: "https://jenkins.internal/job/reset/",
      credential: "jenkins-user:api-token",
    });
    expect(repository.markPolling).toHaveBeenCalledWith(
      expect.objectContaining({ sourceBuildNumber: 41, workerId: "worker-1" }),
    );
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("waits after a successful rebuild before releasing the next round", async () => {
    const repository = repositoryWithClaim(claim({ status: "polling", sourceBuildNumber: 41 }));
    const transport = {
      rebuildLast: vi.fn(),
      inspectRebuild: vi.fn().mockResolvedValue({
        status: "succeeded",
        buildNumber: 42,
        buildUrl: "https://jenkins.internal/job/reset/42/",
      }),
    } as JenkinsRoundRecoveryTransport;
    const service = createService(repository, transport);

    await service.dispatchDue("worker-1");

    expect(repository.markWaiting).toHaveBeenCalledWith({
      batchId: "batch-1",
      ruleId: "recovery-1",
      workerId: "worker-1",
      availableAt: "2026-08-23T00:05:00.000Z",
      updatedAt: now,
    });
    expect(repository.resume).not.toHaveBeenCalled();
  });

  it("atomically releases held runs and immediately asks the scheduler to refill", async () => {
    const repository = repositoryWithClaim(claim({ status: "waiting" }));
    const scheduling = { schedule: vi.fn(), scheduleForRunner: vi.fn() };
    const service = createService(
      repository,
      { rebuildLast: vi.fn(), inspectRebuild: vi.fn() },
      scheduling,
    );

    await service.dispatchDue("worker-1");

    expect(repository.resume).toHaveBeenCalledWith({
      batchId: "batch-1",
      ruleId: "recovery-1",
      workerId: "worker-1",
      updatedAt: now,
    });
    expect(scheduling.schedule).toHaveBeenCalledWith("batch-1");
  });

  it("marks orchestration failure without exposing the credential", async () => {
    const repository = repositoryWithClaim(claim({ status: "pending" }));
    const service = createService(repository, {
      rebuildLast: vi.fn().mockRejectedValue(new Error("Jenkins returned HTTP 500")),
      inspectRebuild: vi.fn(),
    });

    await service.dispatchDue("worker-1");

    expect(repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        batchId: "batch-1",
        errorMessage: "Jenkins returned HTTP 500",
      }),
    );
    expect(JSON.stringify(repository.fail.mock.calls)).not.toContain("api-token");
  });
});

function createService(
  repository: ReturnType<typeof repositoryWithClaim>,
  transport: JenkinsRoundRecoveryTransport,
  scheduling: RunBatchSchedulingPort = { schedule: vi.fn(), scheduleForRunner: vi.fn() },
) {
  const cipher: SecretCipherPort = {
    available: true,
    encrypt: vi.fn(),
    decrypt: vi.fn((ciphertext, purpose) => {
      expect(ciphertext).toBe("encrypted-api-key");
      expect(purpose).toBe("case-suite-round-recovery:suite-1:recovery-1");
      return "jenkins-user:api-token";
    }),
  };
  return new RoundRecoveryService(
    repository,
    transport,
    cipher,
    { appendSchedulingEvents: vi.fn() } as unknown as RunBatchRepository,
    scheduling,
    { now: () => new Date(now) },
    { next: () => "event-1" },
  );
}

function repositoryWithClaim(recoveryClaim: RoundRecoveryClaim) {
  return {
    claimDue: vi.fn().mockResolvedValue([recoveryClaim]),
    markPolling: vi.fn().mockResolvedValue(true),
    markWaiting: vi.fn().mockResolvedValue(true),
    resume: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue(true),
  } satisfies RoundRecoveryRepository;
}

function claim(overrides: Partial<RoundRecoveryClaim>): RoundRecoveryClaim {
  return {
    batchId: "batch-1",
    suiteId: "suite-1",
    ruleId: "recovery-1",
    afterRound: 1,
    nextRound: 2,
    jenkinsJobUrl: "https://jenkins.internal/job/reset/",
    apiKeyCiphertext: "encrypted-api-key",
    waitMinutes: 5,
    status: "pending",
    ...overrides,
  };
}
