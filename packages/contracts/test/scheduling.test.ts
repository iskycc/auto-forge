import { describe, expect, it } from "vitest";

import { createRunBatchInputSchema, runBatchPreflightResultSchema } from "../src/scheduling";

describe("createRunBatchInputSchema", () => {
  it("accepts bounded environment variables", () => {
    expect(
      createRunBatchInputSchema.parse({
        suiteId: "suite-1",
        runnerIds: ["runner-1"],
        retryLimit: 2,
        environmentVariables: [{ name: "TEST_ENV", value: "staging" }],
      }),
    ).toMatchObject({
      retryLimit: 2,
      queueTimeoutMs: 86_400_000,
      claimTimeoutMs: 300_000,
      executionTimeoutMs: 3_600_000,
      uploadTimeoutMs: 600_000,
    });
  });

  it("rejects duplicate runners and environment names", () => {
    expect(() =>
      createRunBatchInputSchema.parse({
        suiteId: "suite-1",
        runnerIds: ["runner-1", "runner-1"],
        retryLimit: 0,
        environmentVariables: [
          { name: "TEST_ENV", value: "a" },
          { name: "TEST_ENV", value: "b" },
        ],
      }),
    ).toThrow();
  });

  it("rejects timeout policies outside the recoverable server bounds", () => {
    expect(() =>
      createRunBatchInputSchema.parse({
        suiteId: "suite-1",
        runnerIds: ["runner-1"],
        retryLimit: 0,
        queueTimeoutMs: 999,
      }),
    ).toThrow();
  });

  it("defines bounded, addressable preflight blockers", () => {
    expect(
      runBatchPreflightResultSchema.parse({
        ready: false,
        blockers: [
          {
            code: "RUNNER_JAVA_VERSION_UNKNOWN",
            category: "toolchain",
            message: "Runner 未上报 Java 工具链版本。",
            path: ["runnerIds", 0],
            runnerId: "runner-1",
          },
        ],
      }),
    ).toMatchObject({ ready: false, blockers: [{ runnerId: "runner-1" }] });
  });
});
