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
    const repository = repositoryWithClaims(claim({ status: "pending" }));
    const transport = {
      inspectJob: vi.fn(),
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

  it("triggers every Jenkins recovery at the same round boundary in one dispatch", async () => {
    const repository = repositoryWithClaims(
      claim({ status: "pending", jenkinsJobUrl: "https://jenkins.internal/job/reset-a/" }),
      claim({
        ruleId: "recovery-2",
        status: "pending",
        jenkinsJobUrl: "https://jenkins.internal/job/reset-b/",
      }),
    );
    const transport = {
      inspectJob: vi.fn(),
      rebuildLast: vi
        .fn()
        .mockResolvedValueOnce({ sourceBuildNumber: 41 })
        .mockResolvedValueOnce({ sourceBuildNumber: 91 }),
      inspectRebuild: vi.fn(),
    } as JenkinsRoundRecoveryTransport;
    const service = createService(repository, transport);

    await service.dispatchDue("worker-1");

    expect(transport.rebuildLast).toHaveBeenCalledTimes(2);
    expect(transport.rebuildLast).toHaveBeenCalledWith({
      jobUrl: "https://jenkins.internal/job/reset-a/",
      credential: "jenkins-user:api-token",
    });
    expect(transport.rebuildLast).toHaveBeenCalledWith({
      jobUrl: "https://jenkins.internal/job/reset-b/",
      credential: "jenkins-user:api-token",
    });
    expect(repository.markPolling).toHaveBeenCalledTimes(2);
  });

  it("waits after a successful rebuild before releasing the next round", async () => {
    const repository = repositoryWithClaims(claim({ status: "polling", sourceBuildNumber: 41 }));
    const transport = {
      inspectJob: vi.fn(),
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
    expect(repository.completeWaitingStep).not.toHaveBeenCalled();
  });

  it("releases held runs only after every same-round recovery step is ready", async () => {
    const repository = repositoryWithClaims(
      claim({ status: "waiting" }),
      claim({ ruleId: "recovery-2", status: "waiting" }),
    );
    repository.completeWaitingStep.mockImplementation(async ({ ruleId }) =>
      ruleId === "recovery-1"
        ? { outcome: "step_completed", remainingSteps: 1 }
        : { outcome: "round_releasing" },
    );
    const scheduling = { schedule: vi.fn(), scheduleForRunner: vi.fn() };
    const service = createService(
      repository,
      { inspectJob: vi.fn(), rebuildLast: vi.fn(), inspectRebuild: vi.fn() },
      scheduling,
    );

    await service.dispatchDue("worker-1");

    expect(repository.completeWaitingStep).toHaveBeenCalledWith({
      batchId: "batch-1",
      ruleId: "recovery-1",
      workerId: "worker-1",
      updatedAt: now,
    });
    expect(repository.completeWaitingStep).toHaveBeenCalledWith({
      batchId: "batch-1",
      ruleId: "recovery-2",
      workerId: "worker-1",
      updatedAt: now,
    });
    expect(repository.completeWaitingStep).toHaveBeenCalledTimes(2);
    expect(scheduling.schedule).toHaveBeenCalledWith("batch-1");
    expect(scheduling.schedule).toHaveBeenCalledTimes(1);
    expect(repository.completeRoundRelease).toHaveBeenCalledWith({
      batchId: "batch-1",
      ruleId: "recovery-2",
      workerId: "worker-1",
      updatedAt: now,
    });
  });

  it("keeps a released round retryable when the scheduling handoff fails", async () => {
    const repository = repositoryWithClaims(claim({ status: "waiting" }));
    const scheduling = {
      schedule: vi.fn().mockRejectedValue(new Error("scheduler unavailable")),
      scheduleForRunner: vi.fn(),
    };
    const service = createService(
      repository,
      { inspectJob: vi.fn(), rebuildLast: vi.fn(), inspectRebuild: vi.fn() },
      scheduling,
    );

    await service.dispatchDue("worker-1");

    expect(repository.completeWaitingStep).toHaveBeenCalledOnce();
    expect(repository.completeRoundRelease).not.toHaveBeenCalled();
    expect(repository.retryRoundRelease).toHaveBeenCalledWith({
      batchId: "batch-1",
      ruleId: "recovery-1",
      workerId: "worker-1",
      errorMessage: "scheduler unavailable",
      availableAt: "2026-08-23T00:00:05.000Z",
      updatedAt: now,
    });
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("retries an interrupted round release without polling or rebuilding Jenkins again", async () => {
    const repository = repositoryWithClaims(claim({ status: "releasing" }));
    const transport = {
      inspectJob: vi.fn(),
      rebuildLast: vi.fn(),
      inspectRebuild: vi.fn(),
    };
    const scheduling = { schedule: vi.fn(), scheduleForRunner: vi.fn() };
    const service = createService(repository, transport, scheduling);

    await service.dispatchDue("worker-2");

    expect(scheduling.schedule).toHaveBeenCalledWith("batch-1");
    expect(repository.completeRoundRelease).toHaveBeenCalledWith({
      batchId: "batch-1",
      ruleId: "recovery-1",
      workerId: "worker-2",
      updatedAt: now,
    });
    expect(transport.rebuildLast).not.toHaveBeenCalled();
    expect(transport.inspectRebuild).not.toHaveBeenCalled();
  });

  it("marks orchestration failure without exposing the credential", async () => {
    const repository = repositoryWithClaims(claim({ status: "pending" }));
    const service = createService(repository, {
      inspectJob: vi.fn(),
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
  repository: ReturnType<typeof repositoryWithClaims>,
  transport: JenkinsRoundRecoveryTransport,
  scheduling: RunBatchSchedulingPort = { schedule: vi.fn(), scheduleForRunner: vi.fn() },
) {
  const cipher: SecretCipherPort = {
    available: true,
    encrypt: vi.fn(),
    decrypt: vi.fn((ciphertext, purpose) => {
      expect(ciphertext).toBe("encrypted-api-key");
      expect(purpose).toMatch(/^case-suite-round-recovery:suite-1:recovery-[12]$/u);
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

function repositoryWithClaims(...recoveryClaims: RoundRecoveryClaim[]) {
  return {
    claimDue: vi.fn().mockResolvedValue(recoveryClaims),
    markPolling: vi.fn().mockResolvedValue(true),
    markWaiting: vi.fn().mockResolvedValue(true),
    completeWaitingStep: vi.fn().mockResolvedValue({ outcome: "round_releasing" }),
    completeRoundRelease: vi.fn().mockResolvedValue(true),
    retryRoundRelease: vi.fn().mockResolvedValue(true),
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
