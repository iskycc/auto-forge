import { describe, expect, it, vi } from "vitest";

import { ExecutionControlService, redactLogContent } from "../src/control-executions";
import type {
  ExecutionControlRepository,
  JarObjectStorePort,
  RunnerRepository,
} from "../src/ports";

describe("execution log redaction", () => {
  it("redacts execution secrets and common credential formats", () => {
    expect(
      redactLogContent(
        "password=hunter2 Authorization: Bearer abcdefghijklmnopqrst.abcdefgh.ijklmnop raw=hunter2",
        ["hunter2"],
      ),
    ).not.toContain("hunter2");
    expect(redactLogContent("Bearer abcdefghijklmnopqrstuv", [])).toBe("[REDACTED]");
  });
});

describe("execution secret acquisition", () => {
  it("decrypts lease-authorized ciphertext with its version purpose", async () => {
    const executions = {
      acquireAttemptSecrets: vi.fn().mockResolvedValue([
        {
          name: "API_TOKEN",
          secretId: "secret-1",
          secretVersionId: "secret-version-1",
          valueEncrypted: "ciphertext",
        },
      ]),
      recordAttemptSecretAccess: vi.fn().mockResolvedValue(undefined),
    } as unknown as ExecutionControlRepository;
    const runners = {
      findByCredentialHash: vi.fn().mockResolvedValue({
        id: "runner-1",
        name: "Runner 1",
        state: "online",
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.2",
        protocolVersion: 1,
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        maxConcurrency: 1,
        busySlots: 0,
        lastSeenAt: "2026-08-09T00:00:00.000Z",
        terminalEnabled: false,
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
      }),
    } as unknown as RunnerRepository;
    const decrypt = vi.fn().mockReturnValue("plaintext-secret");
    const service = new ExecutionControlService(
      executions,
      runners,
      {
        issue: vi.fn(),
        issueBootstrapToken: vi.fn(),
        hash: (value) => `hash:${value}`,
        verifyBootstrapToken: vi.fn(),
      },
      { available: true, encrypt: vi.fn(), decrypt },
      {} as JarObjectStorePort,
      { now: () => new Date("2026-08-09T00:00:00.000Z") },
      { next: () => "audit-1" },
    );

    await expect(
      service.acquireSecrets("runner-1", "credential", "attempt-1", {
        schemaVersion: 1,
        requestId: "request-1",
        leaseToken: "l".repeat(32),
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      requestId: "request-1",
      secrets: [{ name: "API_TOKEN", value: "plaintext-secret" }],
    });
    expect(decrypt).toHaveBeenCalledWith("ciphertext", "execution-secret:secret-version-1");
    expect(executions.acquireAttemptSecrets).toHaveBeenCalledWith(
      expect.objectContaining({ leaseTokenHash: `hash:${"l".repeat(32)}` }),
    );
    expect(executions.recordAttemptSecretAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "audit-1",
        requestId: "request-1",
        secretIds: ["secret-1"],
      }),
    );
    vi.mocked(executions.recordAttemptSecretAccess).mockClear();
    decrypt.mockImplementationOnce(() => {
      throw new Error("wrong master key");
    });
    await expect(
      service.acquireSecrets("runner-1", "credential", "attempt-1", {
        schemaVersion: 1,
        requestId: "request-2",
        leaseToken: "m".repeat(32),
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_SECRET_DECRYPT_FAILED" });
    expect(executions.recordAttemptSecretAccess).not.toHaveBeenCalled();
  });
});

describe("execution data scope", () => {
  it("hides an attempt from identities outside its project before reading logs", async () => {
    const executions = {
      resolveAttemptProjectId: vi.fn().mockResolvedValue("project-b"),
      listLogChunks: vi.fn(),
    } as unknown as ExecutionControlRepository;
    const service = new ExecutionControlService(
      executions,
      {} as RunnerRepository,
      {
        issue: vi.fn(),
        issueBootstrapToken: vi.fn(),
        hash: (value) => `hash:${value}`,
        verifyBootstrapToken: vi.fn(),
      },
      { available: true, encrypt: vi.fn(), decrypt: vi.fn() },
      {} as JarObjectStorePort,
      { now: () => new Date("2026-08-09T00:00:00.000Z") },
      { next: () => "id-1" },
    );

    await expect(
      service.listLogs({
        attemptId: "attempt-b",
        stream: "stdout",
        afterSequence: -1,
        limit: 100,
        projectIds: ["project-a"],
      }),
    ).rejects.toMatchObject({ code: "RUN_ATTEMPT_NOT_FOUND" });
    expect(executions.listLogChunks).not.toHaveBeenCalled();
  });
});

describe("Runner execution compatibility", () => {
  it("allows claims without cgroup isolation when the remaining capabilities are compatible", async () => {
    const executions = {
      recoverExpired: vi.fn().mockResolvedValue(undefined),
      claim: vi.fn().mockResolvedValue([]),
    } as unknown as ExecutionControlRepository;
    const runners = {
      findByCredentialHash: vi.fn().mockResolvedValue({
        id: "runner-no-cgroup",
        name: "Runner without cgroup",
        state: "online",
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.2",
        protocolVersion: 1,
        labels: [],
        capabilities: ["executor:testng-v1", "java:21.0.8", "testng:7.11.0"],
        maxConcurrency: 1,
        busySlots: 0,
        lastSeenAt: "2026-08-09T00:00:00.000Z",
        terminalEnabled: false,
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
      }),
    } as unknown as RunnerRepository;
    const service = new ExecutionControlService(
      executions,
      runners,
      {
        issue: vi.fn(),
        issueBootstrapToken: vi.fn(),
        hash: (value) => `hash:${value}`,
        verifyBootstrapToken: vi.fn(),
      },
      { available: true, encrypt: vi.fn(), decrypt: vi.fn() },
      {} as JarObjectStorePort,
      { now: () => new Date("2026-08-09T00:00:00.000Z") },
      { next: () => "id-1" },
    );

    await expect(
      service.claim("runner-no-cgroup", "credential", {
        schemaVersion: 1,
        requestId: "request-1",
        availableSlots: 1,
        labels: [],
        capabilities: ["executor:testng-v1", "java:21.0.8", "testng:7.11.0"],
        waitSeconds: 0,
      }),
    ).resolves.toMatchObject({ assignments: [] });
    expect(executions.claim).toHaveBeenCalledOnce();
  });
});

describe("artifact transfer orchestration", () => {
  it("issues a direct target and verifies the object before finalizing metadata", async () => {
    const artifact = {
      artifactId: "artifact-1",
      relativePath: "reports/testng/testng-results.xml",
      mediaType: "application/xml",
      sizeBytes: 8,
      sha256: "a".repeat(64),
      required: true,
    };
    const executions = {
      resolveAttemptProjectId: vi.fn().mockResolvedValue("project-1"),
      declareArtifacts: vi.fn().mockResolvedValue([{ ...artifact, status: "declared" }]),
      resolveArtifactUpload: vi.fn().mockResolvedValue({ ...artifact, status: "declared" }),
      markArtifactUploaded: vi.fn().mockResolvedValue(undefined),
    } as unknown as ExecutionControlRepository;
    const runners = {
      findByCredentialHash: vi.fn().mockResolvedValue({
        id: "runner-1",
        name: "Runner 1",
        state: "online",
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.2",
        protocolVersion: 1,
        labels: [],
        capabilities: [],
        maxConcurrency: 1,
        busySlots: 0,
        lastSeenAt: "2026-08-09T00:00:00.000Z",
        terminalEnabled: false,
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
      }),
    } as unknown as RunnerRepository;
    const objectStore = {
      prepareArtifactUpload: vi.fn().mockResolvedValue({
        kind: "direct",
        uploadUrl: "https://minio.internal/signed-object",
        objectKey: `projects/project-1/artifacts/attempt-1/artifact-1/${artifact.sha256}`,
      }),
      verifyArtifactUpload: vi.fn().mockResolvedValue({
        objectKey: `projects/project-1/artifacts/attempt-1/artifact-1/${artifact.sha256}`,
        created: true,
      }),
    } as unknown as JarObjectStorePort;
    const service = new ExecutionControlService(
      executions,
      runners,
      {
        issue: vi.fn(),
        issueBootstrapToken: vi.fn(),
        hash: (value) => `hash:${value}`,
        verifyBootstrapToken: vi.fn(),
      },
      { available: true, encrypt: vi.fn(), decrypt: vi.fn() },
      objectStore,
      { now: () => new Date("2026-08-09T00:00:00.000Z") },
      { next: () => "id-1" },
    );

    await expect(
      service.declareArtifacts("runner-1", "credential", "attempt-1", {
        schemaVersion: 1,
        requestId: "request-1",
        leaseToken: "l".repeat(32),
        artifacts: [artifact],
      }),
    ).resolves.toMatchObject({
      artifacts: [
        {
          artifactId: "artifact-1",
          uploadMethod: "direct",
          uploadPath: "https://minio.internal/signed-object",
          finalizePath: "/api/v1/run-attempts/attempt-1/artifacts/artifact-1/finalize",
        },
      ],
    });
    await expect(
      service.finalizeArtifactUpload({
        runnerId: "runner-1",
        credential: "credential",
        attemptId: "attempt-1",
        artifactId: "artifact-1",
        leaseToken: "l".repeat(32),
      }),
    ).resolves.toMatchObject({ status: "uploaded" });
    expect(executions.resolveArtifactUpload).toHaveBeenCalledWith(
      expect.objectContaining({ leaseTokenHash: `hash:${"l".repeat(32)}` }),
    );
    expect(objectStore.verifyArtifactUpload).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: "artifact-1", sha256: artifact.sha256 }),
    );
    expect(executions.markArtifactUploaded).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: "artifact-1" }),
    );
  });
});
