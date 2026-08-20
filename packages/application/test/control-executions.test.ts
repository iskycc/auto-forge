import { describe, expect, it, vi } from "vitest";

import { ExecutionControlService, redactLogContent } from "../src/control-executions";
import type {
  ExecutionControlRepository,
  JarObjectStorePort,
  RunBatchRepository,
  RunBatchSchedulingPort,
  RunnerRepository,
} from "../src/ports";

// 调度事件写入在 claim/complete 路径上只用到 appendSchedulingEvents；
// 其余方法在现有用例中不会被触达，缺失时以运行时错误暴露。
function batchesRepositoryFake(): RunBatchRepository {
  return {
    appendSchedulingEvents: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    listReusableBatchIdsForRunner: vi.fn().mockResolvedValue([]),
  } as unknown as RunBatchRepository;
}

function schedulingFake(): RunBatchSchedulingPort {
  return {
    schedule: vi.fn().mockResolvedValue(undefined),
    scheduleForRunner: vi.fn().mockResolvedValue(0),
  };
}

function credentialCipherFake() {
  return {
    available: true,
    encrypt: vi.fn((value: string) => value),
    decrypt: vi.fn((value: string) => value),
  };
}

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
      credentialCipherFake(),
      {} as JarObjectStorePort,
      { now: () => new Date("2026-08-09T00:00:00.000Z") },
      { next: () => "id-1" },
      batchesRepositoryFake(),
      schedulingFake(),
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
      recoverExpired: vi.fn().mockResolvedValue([]),
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
    const batches = batchesRepositoryFake();
    vi.mocked(batches.listReusableBatchIdsForRunner).mockResolvedValue(["batch-open"]);
    const scheduling = schedulingFake();
    const service = new ExecutionControlService(
      executions,
      runners,
      {
        issue: vi.fn(),
        issueBootstrapToken: vi.fn(),
        hash: (value) => `hash:${value}`,
        verifyBootstrapToken: vi.fn(),
      },
      credentialCipherFake(),
      {} as JarObjectStorePort,
      { now: () => new Date("2026-08-09T00:00:00.000Z") },
      { next: () => "id-1" },
      batches,
      scheduling,
    );

    await expect(
      service.claim("runner-no-cgroup", "credential", {
        schemaVersion: 1,
        requestId: "request-1",
        availableSlots: 1,
        labels: [],
        capabilities: ["executor:testng-v1", "java:21.0.8", "testng:7.11.0"],
        waitSeconds: 0,
        cachedBatchIds: ["batch-open", "batch-closed", "batch-foreign"],
      }),
    ).resolves.toMatchObject({
      assignments: [],
      closedBatchIds: ["batch-closed", "batch-foreign"],
    });
    expect(executions.claim).toHaveBeenCalledOnce();
    expect(scheduling.scheduleForRunner).toHaveBeenCalledWith("runner-no-cgroup");
  });

  it("writes scheduling events for attempts recovered before claiming", async () => {
    const appended: Array<Array<Record<string, unknown>>> = [];
    const executions = {
      recoverExpired: vi.fn().mockResolvedValue([
        {
          attemptId: "attempt-expired",
          batchId: "batch-1",
          executionRunId: "run-1",
          runnerId: null,
          reason: "claim_timeout",
          retryScheduled: false,
        },
      ]),
      resolveAttemptSchedulingContext: vi.fn().mockResolvedValue({
        batchId: "batch-1",
        executionRunId: "run-1",
        runnerId: "runner-offline",
        attemptNumber: 1,
        displayName: "冒烟用例",
      }),
      claim: vi.fn().mockResolvedValue([]),
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
        capabilities: ["executor:testng-v1", "java:21.0.8", "testng:7.11.0"],
        maxConcurrency: 1,
        busySlots: 0,
        lastSeenAt: "2026-08-09T00:00:00.000Z",
        terminalEnabled: false,
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
      }),
    } as unknown as RunnerRepository;
    const batches = {
      appendSchedulingEvents: vi.fn(async (events: Array<Record<string, unknown>>) => {
        appended.push(events);
      }),
    } as unknown as RunBatchRepository;
    const scheduling = schedulingFake();
    const service = new ExecutionControlService(
      executions,
      runners,
      {
        issue: vi.fn(),
        issueBootstrapToken: vi.fn(),
        hash: (value) => `hash:${value}`,
        verifyBootstrapToken: vi.fn(),
      },
      credentialCipherFake(),
      {} as JarObjectStorePort,
      { now: () => new Date("2026-08-09T00:00:00.000Z") },
      { next: () => "id-1" },
      batches,
      scheduling,
    );

    await service.claim("runner-1", "credential", {
      schemaVersion: 1,
      requestId: "request-1",
      availableSlots: 1,
      labels: [],
      capabilities: ["executor:testng-v1", "java:21.0.8", "testng:7.11.0"],
      waitSeconds: 0,
    });

    expect(appended).toHaveLength(1);
    expect(scheduling.scheduleForRunner).toHaveBeenCalledWith("runner-1");
    expect(appended[0]).toEqual([
      expect.objectContaining({
        batchId: "batch-1",
        executionRunId: "run-1",
        attemptId: "attempt-expired",
        eventType: "attempt_completed",
        message:
          "用例「冒烟用例」第 1 次执行失败（ASSIGNMENT_CLAIM_TIMEOUT：任务在领取截止前无人领取）",
        payload: {
          attemptNumber: 1,
          outcome: "failed",
          resultCode: "ASSIGNMENT_CLAIM_TIMEOUT",
          recoveryReason: "claim_timeout",
          retryScheduled: false,
        },
      }),
    ]);
    // claim_timeout 无人领取，事件不带 runnerId，只出现在总体调度日志。
    expect(appended[0]?.[0]).not.toHaveProperty("runnerId");
  });
});

describe("attempt completion scheduling events", () => {
  function buildService(options: {
    response: { disposition: "accepted" | "duplicate" | "late"; retryScheduled: boolean };
    context: Awaited<ReturnType<ExecutionControlRepository["resolveAttemptSchedulingContext"]>>;
  }) {
    const appended: Array<Array<Record<string, unknown>>> = [];
    const executions = {
      completeAttempt: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        completionId: "completion-1",
        acceptedAt: "2026-08-09T00:00:00.000Z",
        ...options.response,
      }),
      resolveAttemptSchedulingContext: vi.fn().mockResolvedValue(options.context),
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
        capabilities: ["executor:testng-v1", "java:21.0.8", "testng:7.11.0"],
        maxConcurrency: 1,
        busySlots: 0,
        lastSeenAt: "2026-08-09T00:00:00.000Z",
        terminalEnabled: false,
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
      }),
    } as unknown as RunnerRepository;
    const batches = {
      appendSchedulingEvents: vi.fn(async (events: Array<Record<string, unknown>>) => {
        appended.push(events);
      }),
    } as unknown as RunBatchRepository;
    const service = new ExecutionControlService(
      executions,
      runners,
      {
        issue: vi.fn(),
        issueBootstrapToken: vi.fn(),
        hash: (value) => `hash:${value}`,
        verifyBootstrapToken: vi.fn(),
      },
      credentialCipherFake(),
      {} as JarObjectStorePort,
      { now: () => new Date("2026-08-09T00:00:00.000Z") },
      { next: () => "event-id" },
      batches,
      schedulingFake(),
    );
    return { service, appended, executions };
  }

  const completionInput = {
    schemaVersion: 1 as const,
    completionId: "completion-1",
    leaseToken: "l".repeat(32),
    result: {
      status: "failed" as const,
      resultCode: "TESTNG_FAILURE",
      summary: "1 个用例失败",
      durationMs: 12_000,
      artifacts: [],
    },
  };

  it("writes attempt_completed and run_held_for_round when a failed retry is scheduled", async () => {
    const { service, appended } = buildService({
      response: { disposition: "accepted", retryScheduled: true },
      context: {
        batchId: "batch-1",
        executionRunId: "run-1",
        runnerId: "runner-1",
        attemptNumber: 2,
        displayName: "冒烟用例",
        heldRound: 1,
      },
    });

    await service.complete("runner-1", "credential", "attempt-1", completionInput);

    expect(appended).toHaveLength(1);
    expect(appended[0]).toEqual([
      {
        id: "event-id",
        batchId: "batch-1",
        runnerId: "runner-1",
        executionRunId: "run-1",
        attemptId: "attempt-1",
        eventType: "attempt_completed",
        message: "用例「冒烟用例」第 2 次执行失败（TESTNG_FAILURE：1 个用例失败）",
        payload: {
          attemptNumber: 2,
          outcome: "failed",
          durationMs: 12_000,
          resultCode: "TESTNG_FAILURE",
          summary: "1 个用例失败",
        },
        recordedAt: "2026-08-09T00:00:00.000Z",
      },
      {
        id: "event-id",
        batchId: "batch-1",
        executionRunId: "run-1",
        attemptId: "attempt-1",
        eventType: "run_held_for_round",
        message: "该用例已失败，等待下一轮重试（TESTNG_FAILURE）",
        payload: {
          heldRound: 1,
          resultCode: "TESTNG_FAILURE",
          summary: "1 个用例失败",
        },
        recordedAt: "2026-08-09T00:00:00.000Z",
      },
    ]);
  });

  it("writes only attempt_completed for duplicate or late completions", async () => {
    const { service, appended, executions } = buildService({
      response: { disposition: "duplicate", retryScheduled: true },
      context: {
        batchId: "batch-1",
        executionRunId: "run-1",
        runnerId: "runner-1",
        attemptNumber: 1,
        displayName: "冒烟用例",
      },
    });

    await service.complete("runner-1", "credential", "attempt-1", completionInput);

    expect(appended).toHaveLength(0);
    expect(executions.resolveAttemptSchedulingContext).not.toHaveBeenCalled();
  });

  it("omits the retry event when the failure is terminal", async () => {
    const { service, appended } = buildService({
      response: { disposition: "accepted", retryScheduled: false },
      context: {
        batchId: "batch-1",
        executionRunId: "run-1",
        runnerId: "runner-1",
        attemptNumber: 3,
        displayName: "冒烟用例",
      },
    });

    await service.complete("runner-1", "credential", "attempt-1", {
      ...completionInput,
      result: { ...completionInput.result, status: "succeeded" },
    });

    expect(appended).toHaveLength(1);
    expect(appended[0]).toHaveLength(1);
    expect(appended[0]?.[0]).toMatchObject({
      eventType: "attempt_completed",
      message: "用例「冒烟用例」第 3 次执行成功",
      payload: { attemptNumber: 3, outcome: "succeeded", durationMs: 12_000 },
    });
    // 成功事件的 message 保持原样，payload 不带失败摘要。
    expect(appended[0]?.[0]?.payload).not.toHaveProperty("summary");
  });

  it("enriches the failure message with the summary extracted from the log tail", async () => {
    const { service, appended } = buildService({
      response: { disposition: "accepted", retryScheduled: false },
      context: {
        batchId: "batch-1",
        executionRunId: "run-1",
        runnerId: "runner-1",
        attemptNumber: 1,
        displayName: "冒烟用例",
      },
    });

    await service.complete("runner-1", "credential", "attempt-1", {
      ...completionInput,
      result: {
        ...completionInput.result,
        resultCode: "ARTIFACT_DISCOVERY_REJECTED",
        summary: "discover artifacts: artifact scan rejected\nsymbolic link /tmp/evil",
      },
    });

    const event = appended[0]?.[0];
    expect(event?.message).toBe(
      "用例「冒烟用例」第 1 次执行失败（ARTIFACT_DISCOVERY_REJECTED：discover artifacts: artifact scan rejected symbolic link /tmp/evil）",
    );
    expect(event?.payload).toMatchObject({
      resultCode: "ARTIFACT_DISCOVERY_REJECTED",
      summary: "discover artifacts: artifact scan rejected symbolic link /tmp/evil",
    });
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
      credentialCipherFake(),
      objectStore,
      { now: () => new Date("2026-08-09T00:00:00.000Z") },
      { next: () => "id-1" },
      batchesRepositoryFake(),
      schedulingFake(),
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

describe("failure summary log fallback", () => {
  type LogTailResponse = {
    items: Array<{ stream: string; sequence: number; content: string }>;
    acknowledgedSequence: number;
    truncated: boolean;
  };

  function buildService(logResponses: {
    probe?: { items: unknown[]; acknowledgedSequence: number; truncated: boolean };
    tail?: LogTailResponse;
    stdoutTail?: LogTailResponse;
    stderrTail?: LogTailResponse;
    markerSearch?: LogTailResponse;
    markerWindow?: LogTailResponse;
    error?: unknown;
  }) {
    const listLogChunks = vi
      .fn()
      .mockImplementation(
        (input: { afterSequence: number; limit: number; query?: string; stream: string }) => {
          if (logResponses.error) return Promise.reject(logResponses.error);
          if (input.limit === 1) return Promise.resolve(logResponses.probe);
          const tail =
            (input.stream === "stdout" ? logResponses.stdoutTail : logResponses.stderrTail) ??
            logResponses.tail;
          if (input.query) {
            if (logResponses.markerSearch) return Promise.resolve(logResponses.markerSearch);
            return Promise.resolve(
              tail
                ? {
                    ...tail,
                    items: tail.items.filter((item) =>
                      item.content.includes("TestCase Run Failed Stack"),
                    ),
                  }
                : { items: [], acknowledgedSequence: -1, truncated: false },
            );
          }
          if (logResponses.markerWindow && input.afterSequence >= 0) {
            return Promise.resolve(logResponses.markerWindow);
          }
          return Promise.resolve(tail);
        },
      );
    const executions = {
      completeAttempt: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        completionId: "completion-1",
        acceptedAt: "2026-08-09T00:00:00.000Z",
        disposition: "accepted",
        retryScheduled: false,
      }),
      resolveAttemptSchedulingContext: vi.fn().mockResolvedValue(null),
      listLogChunks,
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
    const service = new ExecutionControlService(
      executions,
      runners,
      {
        issue: vi.fn(),
        issueBootstrapToken: vi.fn(),
        hash: (value) => `hash:${value}`,
        verifyBootstrapToken: vi.fn(),
      },
      credentialCipherFake(),
      {} as JarObjectStorePort,
      { now: () => new Date("2026-08-09T00:00:00.000Z") },
      { next: () => "event-id" },
      batchesRepositoryFake(),
      schedulingFake(),
    );
    return { service, executions, listLogChunks };
  }

  const completionInput = {
    schemaVersion: 1 as const,
    completionId: "completion-1",
    leaseToken: "l".repeat(32),
    result: {
      status: "failed" as const,
      resultCode: "TESTNG_EXIT_NONZERO",
      summary: "TestNG exited with code 1.",
      durationMs: 8_000,
      artifacts: [],
    },
  };

  it("replaces the summary with the last exception line from stderr when no structured result exists", async () => {
    const { service, executions } = buildService({
      probe: { items: [], acknowledgedSequence: 12, truncated: false },
      tail: {
        items: [
          {
            stream: "stderr",
            sequence: 12,
            content:
              "running suite\njava.lang.AssertionError: expected checkout to succeed\n\tat com.example.CheckoutTest.pays(CheckoutTest.java:42)\n",
          },
        ],
        acknowledgedSequence: 12,
        truncated: false,
      },
    });

    await service.complete("runner-1", "credential", "attempt-1", completionInput);

    expect(executions.completeAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          summary: "java.lang.AssertionError: expected checkout to succeed",
        }),
      }),
    );
  });

  it("keeps the original summary when the log tail has no failure line", async () => {
    const { service, executions } = buildService({
      probe: { items: [], acknowledgedSequence: 2, truncated: false },
      tail: {
        items: [{ stream: "stderr", sequence: 2, content: "process finished\n" }],
        acknowledgedSequence: 2,
        truncated: false,
      },
    });

    await service.complete("runner-1", "credential", "attempt-1", completionInput);

    expect(executions.completeAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ summary: "TestNG exited with code 1." }),
      }),
    );
  });

  it("keeps reconcile-reported summaries instead of mining the killed attempt log", async () => {
    // 回归：AGENT_RESTARTED_DURING_EXECUTION 的日志属于被强杀的旧进程，
    // 不得用启发式异常行替换上报方自带摘要，否则页面原因码被摘要顶掉。
    const { service, executions } = buildService({
      probe: { items: [], acknowledgedSequence: 5, truncated: false },
      tail: {
        items: [
          {
            stream: "stderr",
            sequence: 5,
            content: "java.lang.AssertionError: stale line from the killed process\n",
          },
        ],
        acknowledgedSequence: 5,
        truncated: false,
      },
    });

    await service.complete("runner-1", "credential", "attempt-1", {
      ...completionInput,
      result: {
        ...completionInput.result,
        resultCode: "AGENT_RESTARTED_DURING_EXECUTION",
        summary: "Runner Agent restarted before the attempt completed.",
      },
    });

    expect(executions.completeAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          summary: "Runner Agent restarted before the attempt completed.",
        }),
      }),
    );
  });

  it("accepts the completion even when the log store cannot be read", async () => {
    const { service, executions } = buildService({ error: new Error("store gone") });

    await expect(
      service.complete("runner-1", "credential", "attempt-1", completionInput),
    ).resolves.toMatchObject({ disposition: "accepted" });
    expect(executions.completeAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ summary: "TestNG exited with code 1." }),
      }),
    );
  });

  it("prefers the adapter failure marker over later unrelated exception lines", async () => {
    // 回归：stderr 尾部有更靠后的 ClassFormatError，但摘要必须取 stdout 中 adapter
    // 失败标记的内容（即报告中 "Stack Trace:" 之后的第一行），不得误抓 stderr。
    const reportBlock = [
      "===== TestNG Failed Cases =====",
      "Case: com.example.PaymentTest#pays",
      "Stack Trace:",
      "java.lang.AssertionError: expected <200> but was <500>",
      "\tat com.example.PaymentTest.pays(PaymentTest.java:42)",
      "TestCase Run Failed Stack: [java.lang.AssertionError: expected <200> but was <500>]",
      "",
    ].join("\n");
    const { service, executions } = buildService({
      probe: { items: [], acknowledgedSequence: 30, truncated: false },
      stdoutTail: {
        items: [{ stream: "stdout", sequence: 30, content: reportBlock }],
        acknowledgedSequence: 30,
        truncated: false,
      },
      stderrTail: {
        items: [
          {
            stream: "stderr",
            sequence: 31,
            content:
              'Exception in thread "main" java.lang.ClassFormatError: Absent Code attribute in method that is not native or abstract\n',
          },
        ],
        acknowledgedSequence: 31,
        truncated: false,
      },
    });

    await service.complete("runner-1", "credential", "attempt-1", completionInput);

    expect(executions.completeAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          summary: "java.lang.AssertionError: expected <200> but was <500>",
        }),
      }),
    );
  });

  it("finds an early adapter marker even when more than 500 later chunks leave the tail", async () => {
    const marker =
      "TestCase Run Failed Stack: [java.lang.AssertionError: early authoritative failure]\n";
    const markerPage = {
      items: [{ stream: "stdout", sequence: 10, content: marker }],
      acknowledgedSequence: 1_000,
      truncated: false,
    };
    const { service, executions } = buildService({
      probe: { items: [], acknowledgedSequence: 1_000, truncated: false },
      markerSearch: markerPage,
      markerWindow: markerPage,
      stdoutTail: {
        items: [
          {
            stream: "stdout",
            sequence: 1_000,
            content: "later output without the marker\n",
          },
        ],
        acknowledgedSequence: 1_000,
        truncated: false,
      },
    });

    await service.complete("runner-1", "credential", "attempt-1", completionInput);

    expect(executions.completeAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          summary: "java.lang.AssertionError: early authoritative failure",
        }),
      }),
    );
  });

  it("replaces the structured TestNG summary with the adapter failure marker", async () => {
    const counts = { total: 1, passed: 0, failed: 1, skipped: 0, configurationFailures: 0 };
    const structuredInput = {
      ...completionInput,
      result: {
        ...completionInput.result,
        testNg: {
          ...counts,
          detailsTruncated: false,
          suites: [
            {
              ...counts,
              name: "Suite",
              durationMs: 8_000,
              tests: [
                {
                  ...counts,
                  name: "Test",
                  durationMs: 8_000,
                  classes: [
                    {
                      ...counts,
                      name: "com.example.PaymentTest",
                      durationMs: 8_000,
                      methods: [
                        {
                          name: "pays",
                          status: "failed" as const,
                          configuration: false,
                          durationMs: 8_000,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    };
    const { service, executions } = buildService({
      probe: { items: [], acknowledgedSequence: 30, truncated: false },
      stdoutTail: {
        items: [
          {
            stream: "stdout",
            sequence: 30,
            content:
              "TestCase Run Failed Stack: [java.lang.AssertionError: expected <200> but was <500>]\n",
          },
        ],
        acknowledgedSequence: 30,
        truncated: false,
      },
    });

    await service.complete("runner-1", "credential", "attempt-1", structuredInput);

    expect(executions.completeAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          summary: "java.lang.AssertionError: expected <200> but was <500>",
        }),
      }),
    );
  });

  it("never replaces a structured failure with the class-and-method placeholder", async () => {
    const counts = { total: 1, passed: 0, failed: 1, skipped: 0, configurationFailures: 0 };
    const { service, executions } = buildService({
      probe: { items: [], acknowledgedSequence: 4, truncated: false },
      stderrTail: {
        items: [
          {
            stream: "stderr",
            sequence: 4,
            content: "java.lang.AssertionError: 中文详情必须保留\n",
          },
        ],
        acknowledgedSequence: 4,
        truncated: false,
      },
    });

    await service.complete("runner-1", "credential", "attempt-1", {
      ...completionInput,
      result: {
        ...completionInput.result,
        testNg: {
          ...counts,
          detailsTruncated: false,
          suites: [
            {
              ...counts,
              name: "Suite",
              durationMs: 1,
              tests: [
                {
                  ...counts,
                  name: "Test",
                  durationMs: 1,
                  classes: [
                    {
                      ...counts,
                      name: "com.example.PaymentTest",
                      durationMs: 1,
                      methods: [
                        {
                          name: "pays",
                          status: "failed" as const,
                          configuration: false,
                          durationMs: 1,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    });

    expect(executions.completeAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ summary: "java.lang.AssertionError: 中文详情必须保留" }),
      }),
    );
  });

  it("decodes a multiline, long and Chinese adapter failure marker without truncation", async () => {
    const failureSummary =
      "java.lang.AssertionError: 中文断言失败\n第二行错误详情：" +
      "预期值与实际值不一致；".repeat(500);
    const encodedSummary = Buffer.from(failureSummary, "utf8").toString("base64");
    const { service, executions } = buildService({
      probe: { items: [], acknowledgedSequence: 31, truncated: false },
      stdoutTail: {
        items: [
          {
            stream: "stdout",
            sequence: 30,
            content: "TestCase Run Failed Stack Base64: [" + encodedSummary.slice(0, 120),
          },
          {
            stream: "stdout",
            sequence: 31,
            content: `${encodedSummary.slice(120)}]\nStack frame argument [unrelated]\n`,
          },
        ],
        acknowledgedSequence: 31,
        truncated: false,
      },
    });

    await service.complete("runner-1", "credential", "attempt-1", completionInput);

    expect(failureSummary.length).toBeGreaterThan(4_096);
    expect(executions.completeAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ summary: failureSummary.replace(/\s+/g, " ") }),
      }),
    );
  });

  it("parses legacy multiline markers and keeps long heuristic exception lines intact", async () => {
    const legacySummary = "java.lang.AssertionError: first line\nsecond line with 中文详情";
    const { service, executions } = buildService({
      probe: { items: [], acknowledgedSequence: 8, truncated: false },
      stdoutTail: {
        items: [
          {
            stream: "stdout",
            sequence: 8,
            content: `TestCase Run Failed Stack: [${legacySummary}]\n`,
          },
        ],
        acknowledgedSequence: 8,
        truncated: false,
      },
    });

    await service.complete("runner-1", "credential", "attempt-1", completionInput);

    expect(executions.completeAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ summary: legacySummary.replace(/\s+/g, " ") }),
      }),
    );
  });

  it("keeps only the assertion expression from a multiline power-assert block", async () => {
    const { service, executions } = buildService({
      probe: { items: [], acknowledgedSequence: 11, truncated: false },
      stdoutTail: {
        items: [
          {
            stream: "stdout",
            sequence: 11,
            content: [
              "running checkout case",
              'assert OrderId != ""',
              "&#x20;      |       |",
              "&#x20;      ''      false",
              "",
            ].join("\n"),
          },
        ],
        acknowledgedSequence: 11,
        truncated: false,
      },
    });

    await service.complete("runner-1", "credential", "attempt-1", completionInput);

    expect(executions.completeAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          summary: 'assert OrderId != ""',
        }),
      }),
    );
  });

  it("drops a power-assert value diagram from an encoded adapter marker", async () => {
    const failureSummary = [
      "Assertion failed:",
      'assert OrderId != ""',
      "&#x20;      |       |",
      "&#x20;      ''      false",
    ].join("\n");
    const encodedSummary = Buffer.from(failureSummary, "utf8").toString("base64");
    const { service, executions } = buildService({
      probe: { items: [], acknowledgedSequence: 12, truncated: false },
      stdoutTail: {
        items: [
          {
            stream: "stdout",
            sequence: 12,
            content: `TestCase Run Failed Stack Base64: [${encodedSummary}]\n`,
          },
        ],
        acknowledgedSequence: 12,
        truncated: false,
      },
    });

    await service.complete("runner-1", "credential", "attempt-1", completionInput);

    expect(executions.completeAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ summary: 'assert OrderId != ""' }),
      }),
    );
  });
});
