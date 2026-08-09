import { describe, expect, it } from "vitest";

import {
  claimAssignmentsInputSchema,
  completeAttemptInputSchema,
  executionSpecSchema,
} from "../src/execution";

describe("Runner Protocol v1 contracts", () => {
  it("accepts a bounded TestNG execution specification", () => {
    expect(
      executionSpecSchema.parse({
        schemaVersion: 1,
        executor: "testng",
        attemptId: "attempt-1",
        executionRunId: "run-1",
        batchId: "batch-1",
        className: "com.example.SmokeTest",
        inputs: [
          {
            inputId: "source-1",
            kind: "test-jar",
            targetPath: "inputs/tests.jar",
            mediaType: "application/java-archive",
            sizeBytes: 1_024,
            sha256: "a".repeat(64),
          },
        ],
        timeoutMs: 60_000,
        uploadTimeoutMs: 10_000,
        resourceLimits: {
          cpuMillicores: 1_000,
          memoryBytes: 536_870_912,
          diskBytes: 1_073_741_824,
          processCount: 64,
          logBytes: 1_048_576,
          artifactBytes: 10_485_760,
        },
      }),
    ).toMatchObject({ schemaVersion: 1, methodDescriptors: [], environment: [] });
  });

  it("rejects incompatible versions and unbounded claim inputs", () => {
    expect(() =>
      claimAssignmentsInputSchema.parse({
        schemaVersion: 2,
        requestId: "claim-1",
        availableSlots: 1,
      }),
    ).toThrow();
    expect(() =>
      claimAssignmentsInputSchema.parse({
        schemaVersion: 1,
        requestId: "claim-1",
        availableSlots: 1,
        labels: Array.from({ length: 129 }, (_, index) => `label-${index}`),
      }),
    ).toThrow();
  });

  it("limits completion metadata and requires a lease credential", () => {
    expect(() =>
      completeAttemptInputSchema.parse({
        schemaVersion: 1,
        completionId: "completion-1",
        leaseToken: "short",
        result: {
          status: "succeeded",
          resultCode: "PASSED",
          summary: "passed",
          durationMs: 10,
        },
      }),
    ).toThrow();
  });
});
