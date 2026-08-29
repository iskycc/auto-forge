import { describe, expect, it } from "vitest";

import {
  attemptEventPageSchema,
  claimAssignmentsInputSchema,
  completeAttemptInputSchema,
  declareArtifactsInputSchema,
  executionSpecSchema,
  uploadLogChunksInputSchema,
} from "../src/execution";

describe("Runner Protocol v1 contracts", () => {
  it("accepts a bounded TestNG execution specification", () => {
    expect(
      executionSpecSchema.parse({
        ...validExecutionSpec(),
        inputs: [
          {
            inputId: "source-1",
            kind: "test-jar",
            targetPath: "inputs/tests.jar",
            mediaType: "application/java-archive",
            sizeBytes: 1_024,
            sha256: "a".repeat(64),
          },
          {
            inputId: "dependency-1",
            kind: "dependency-jar",
            targetPath: "inputs/lib/support.jar",
            mediaType: "application/java-archive",
            sizeBytes: 2_048,
            sha256: "b".repeat(64),
          },
        ],
      }),
    ).toMatchObject({
      schemaVersion: 1,
      methodDescriptors: [],
      environment: [],
      inputs: [{ kind: "test-jar" }, { kind: "dependency-jar" }],
      runtimeRequirements: {
        os: "linux",
        architectures: ["amd64", "arm64"],
        minimumJavaMajorVersion: 11,
        testNgVersion: "7.11.0",
      },
      resourceLimits: { fileCount: 10_000 },
    });
  });

  it("normalizes the retired cgroup v2 requirement from persisted v1 specifications", () => {
    const specification = validExecutionSpec();

    expect(
      executionSpecSchema.parse({
        ...specification,
        requiredCapabilities: ["executor:testng-v1", "isolation:cgroup-v2"],
      }).requiredCapabilities,
    ).toEqual(["executor:testng-v1"]);
  });

  it("requires one test JAR and unique bounded dependency inputs", () => {
    const specification = validExecutionSpec();
    const testJAR = specification.inputs[0]!;
    const dependencyJAR = {
      ...testJAR,
      inputId: "dependency-1",
      kind: "dependency-jar" as const,
      targetPath: "inputs/dependency.jar",
      sha256: "b".repeat(64),
    };

    expect(() => executionSpecSchema.parse({ ...specification, inputs: [dependencyJAR] })).toThrow(
      /只能包含一个/,
    );
    expect(() =>
      executionSpecSchema.parse({
        ...specification,
        inputs: [testJAR, { ...testJAR, inputId: "source-2", targetPath: "inputs/tests-2.jar" }],
      }),
    ).toThrow(/只能包含一个/);
    expect(() =>
      executionSpecSchema.parse({
        ...specification,
        inputs: [testJAR, { ...dependencyJAR, inputId: testJAR.inputId }],
      }),
    ).toThrow(/inputId/);
    expect(() =>
      executionSpecSchema.parse({
        ...specification,
        inputs: [
          { ...testJAR, sizeBytes: 9 * 1_024 * 1_024 },
          { ...dependencyJAR, sizeBytes: 9 * 1_024 * 1_024 },
        ],
        resourceLimits: { ...specification.resourceLimits, diskBytes: 16 * 1_024 * 1_024 },
      }),
    ).toThrow(/磁盘限制/);
    expect(() =>
      executionSpecSchema.parse({
        ...specification,
        resourceLimits: { ...specification.resourceLimits, fileCount: 15 },
      }),
    ).toThrow();
  });

  it("accepts one adapter-bound DDT class data input and rejects it without Adapter", () => {
    const specification = validExecutionSpec();
    const classData = {
      inputId: "class-data-run-1",
      kind: "class-data" as const,
      targetPath: "inputs/class-data/run-1.json",
      mediaType: "application/json" as const,
      sizeBytes: 128,
      sha256: "d".repeat(64),
    };
    expect(
      executionSpecSchema
        .parse({
          ...specification,
          adapter: { suiteName: "DDT", testName: "case" },
          inputs: [...specification.inputs, classData],
        })
        .inputs.at(-1),
    ).toMatchObject({ kind: "class-data", mediaType: "application/json" });
    expect(() =>
      executionSpecSchema.parse({
        ...specification,
        inputs: [...specification.inputs, classData],
      }),
    ).toThrow(/Adapter/);
    expect(() =>
      executionSpecSchema.parse({
        ...specification,
        adapter: { suiteName: "DDT", testName: "case" },
        inputs: [...specification.inputs, classData, { ...classData, inputId: "class-data-run-2" }],
      }),
    ).toThrow(/DDT/);
  });

  it("accepts project JDK and JAR archives with verified external links", () => {
    const specification = validExecutionSpec();
    expect(
      executionSpecSchema.parse({
        ...specification,
        adapter: { suiteName: "Suite", testName: "Test", environmentAddress: "10.0.0.8" },
        inputs: [
          ...specification.inputs,
          {
            inputId: "jdk-1",
            kind: "jdk-archive",
            targetPath: "runtime-inputs/jdk.tar.gz",
            mediaType: "application/gzip",
            sizeBytes: 1_024,
            sha256: "b".repeat(64),
            downloadUrl: "http://10.0.0.9/jdk.tar.gz",
          },
          {
            inputId: "jars-1",
            kind: "jar-bundle",
            targetPath: "runtime-inputs/jars.zip",
            mediaType: "application/zip",
            sizeBytes: 2_048,
            sha256: "c".repeat(64),
          },
        ],
      }),
    ).toMatchObject({
      adapter: { suiteName: "Suite", testName: "Test", environmentAddress: "10.0.0.8" },
      inputs: [
        { kind: "test-jar" },
        { kind: "jdk-archive", downloadUrl: "http://10.0.0.9/jdk.tar.gz" },
        { kind: "jar-bundle" },
      ],
    });
    expect(() =>
      executionSpecSchema.parse({
        ...specification,
        inputs: [
          ...specification.inputs,
          {
            inputId: "jdk-1",
            kind: "jdk-archive",
            targetPath: "runtime-inputs/jdk.zip",
            mediaType: "application/gzip",
            sizeBytes: 1_024,
            sha256: "b".repeat(64),
            downloadUrl: "http://user:password@10.0.0.9/jdk.zip",
          },
        ],
      }),
    ).toThrow();
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
        cachedBatchIds: Array.from({ length: 1_025 }, (_, index) => `batch-${index}`),
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

  it("validates explicit runtime and offline toolchain requirements", () => {
    const specification = validExecutionSpec();
    expect(() =>
      executionSpecSchema.parse({
        ...specification,
        runtimeRequirements: {
          os: "linux",
          architectures: ["amd64", "amd64"],
          minimumJavaMajorVersion: 11,
          testNgVersion: "7.11.0",
        },
      }),
    ).toThrow();
    expect(() =>
      executionSpecSchema.parse({
        ...specification,
        runtimeRequirements: {
          os: "linux",
          architectures: ["amd64"],
          minimumJavaMajorVersion: 8,
          testNgVersion: "7.11.0",
        },
      }),
    ).toThrow();
  });

  it("requires method names with valid JVM descriptors for exact selection", () => {
    const base = validExecutionSpec();
    expect(
      executionSpecSchema.parse({
        ...base,
        methodDescriptors: ["smoke()V", "smoke(Ljava/lang/String;[I)Z"],
        parameters: { browser: "chromium", region: "offline=west" },
      }),
    ).toMatchObject({
      methodDescriptors: ["smoke()V", "smoke(Ljava/lang/String;[I)Z"],
      parameters: { browser: "chromium", region: "offline=west" },
    });
    for (const invalid of ["()V", "smoke", "smoke(V)V", "smoke()", "smoke()Vignored"]) {
      expect(() => executionSpecSchema.parse({ ...base, methodDescriptors: [invalid] })).toThrow();
    }
    expect(() =>
      executionSpecSchema.parse({ ...base, parameters: { "invalid name": "value" } }),
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

  it("accepts safe generated artifact names and rejects paths that can escape the workspace", () => {
    const declaration = {
      artifactId: "artifact-1",
      relativePath: "reports/testng/Command line suite/Command line test.html",
      mediaType: "text/html; charset=utf-8",
      sizeBytes: 1_024,
      sha256: "a".repeat(64),
      required: false,
    };
    const request = {
      schemaVersion: 1,
      requestId: "artifact-request-1",
      leaseToken: "x".repeat(32),
      artifacts: [declaration],
    };

    expect(declareArtifactsInputSchema.parse(request)).toMatchObject({
      artifacts: [{ relativePath: declaration.relativePath }],
    });
    for (const relativePath of [
      "/reports/result.xml",
      "reports/../result.xml",
      "reports\\result.xml",
      "reports//result.xml",
      "reports/result.xml ",
      "reports/result\u0000.xml",
    ]) {
      expect(() =>
        declareArtifactsInputSchema.parse({
          ...request,
          artifacts: [{ ...declaration, relativePath }],
        }),
      ).toThrow();
    }
  });

  it("validates bounded hierarchical TestNG results and their counts", () => {
    const input = {
      schemaVersion: 1,
      completionId: "completion-1",
      leaseToken: "x".repeat(32),
      result: {
        status: "succeeded",
        resultCode: "TESTNG_SUCCEEDED",
        summary: "passed",
        durationMs: 12,
        testNg: testNgResult(),
      },
    };
    expect(completeAttemptInputSchema.parse(input)).toMatchObject({
      result: {
        testNg: {
          total: 1,
          suites: [{ tests: [{ classes: [{ methods: [{ name: "passes" }] }] }] }],
        },
      },
    });
    expect(() =>
      completeAttemptInputSchema.parse({
        ...input,
        result: {
          ...input.result,
          testNg: { ...input.result.testNg, total: 2 },
        },
      }),
    ).toThrow(/计数不一致/);
  });

  it("bounds ordered log uploads", () => {
    expect(
      uploadLogChunksInputSchema.parse({
        schemaVersion: 1,
        requestId: "logs-1",
        leaseToken: "x".repeat(32),
        chunks: [
          {
            stream: "stdout",
            sequence: 0,
            content: "hello",
            recordedAt: "2026-08-09T00:00:00.000Z",
          },
        ],
      }),
    ).toMatchObject({ chunks: [{ stream: "stdout", sequence: 0 }] });
    expect(() =>
      uploadLogChunksInputSchema.parse({
        schemaVersion: 1,
        requestId: "logs-1",
        leaseToken: "x".repeat(32),
        chunks: [],
      }),
    ).toThrow();
  });

  it("validates bounded attempt state event pages", () => {
    expect(
      attemptEventPageSchema.parse({
        items: [
          {
            eventId: "event-1",
            attemptId: "attempt-1",
            eventType: "attempt.completed",
            fromStatus: "running",
            toStatus: "succeeded",
            actorType: "runner",
            actorId: "runner-1",
            details: { resultCode: "PASSED" },
            recordedAt: "2026-08-09T00:00:00.000Z",
          },
        ],
      }),
    ).toMatchObject({ items: [{ eventType: "attempt.completed" }] });
  });
});

function testNgResult() {
  const counts = { total: 1, passed: 1, failed: 0, skipped: 0, configurationFailures: 0 };
  return {
    ...counts,
    detailsTruncated: false,
    suites: [
      {
        ...counts,
        name: "Smoke suite",
        durationMs: 12,
        tests: [
          {
            ...counts,
            name: "Smoke test",
            durationMs: 12,
            classes: [
              {
                ...counts,
                name: "example.SmokeTest",
                durationMs: 12,
                methods: [
                  {
                    name: "passes",
                    signature: "passes()",
                    status: "passed" as const,
                    configuration: false,
                    durationMs: 12,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function validExecutionSpec() {
  return {
    schemaVersion: 1,
    executor: "testng" as const,
    attemptId: "attempt-1",
    executionRunId: "run-1",
    batchId: "batch-1",
    className: "com.example.SmokeTest",
    inputs: [
      {
        inputId: "source-1",
        kind: "test-jar" as const,
        targetPath: "inputs/tests.jar",
        mediaType: "application/java-archive" as const,
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
  };
}
