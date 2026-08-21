import { describe, expect, it } from "vitest";

import {
  DEFAULT_RUNNER_DATA_DIRECTORY,
  installRunnerAgentInputSchema,
  runnerHeartbeatInputSchema,
  runnerHeartbeatResultSchema,
  updateRunnerAgentInputSchema,
  caseSuiteExecutionPolicySchema,
} from "../src/management";

const connection = {
  host: "10.20.30.40",
  port: 22,
  username: "runner-admin",
  password: "correct-password",
};

describe("case suite execution policy", () => {
  it("rejects the retired task parameter template", () => {
    expect(() => caseSuiteExecutionPolicySchema.parse({ parameters: { REGION: "cn" } })).toThrow();
  });
});

const installInput = {
  connection,
  expectedHostKeySha256: `SHA256:${"a".repeat(43)}`,
  name: "runner-west-1",
};

describe("runner data directory contracts", () => {
  it("defaults to the standard directory when the field is omitted", () => {
    expect(DEFAULT_RUNNER_DATA_DIRECTORY).toBe("/var/lib/autoforge-agent");
    const parsed = installRunnerAgentInputSchema.parse(installInput);
    expect(parsed.dataDirectory).toBeUndefined();
  });

  it("accepts an absolute custom directory for install and update", () => {
    expect(
      installRunnerAgentInputSchema.parse({ ...installInput, dataDirectory: "/data/autoforge" })
        .dataDirectory,
    ).toBe("/data/autoforge");
    expect(
      updateRunnerAgentInputSchema.parse({
        connection,
        expectedHostKeySha256: `SHA256:${"a".repeat(43)}`,
        dataDirectory: "/mnt/large/runner",
      }).dataDirectory,
    ).toBe("/mnt/large/runner");
  });

  it("rejects relative paths, empty values, and traversal segments", () => {
    for (const invalid of ["", "relative/path", "/data/../etc", "/data/..", "//", "/a b/c"]) {
      expect(() =>
        installRunnerAgentInputSchema.parse({ ...installInput, dataDirectory: invalid }),
      ).toThrow();
    }
  });
});

describe("runner heartbeat cache reconciliation contracts", () => {
  it("accepts bounded cached batch IDs and defaults the response list", () => {
    const input = runnerHeartbeatInputSchema.parse({
      schemaVersion: 1,
      busySlots: 0,
      labels: [],
      capabilities: [],
      maxConcurrency: 2,
      agentVersion: "0.2.0",
      terminalEnabled: false,
      cachedBatchIds: ["batch-1"],
    });
    expect(input.cachedBatchIds).toEqual(["batch-1"]);
    const result = runnerHeartbeatResultSchema.parse({
      schemaVersion: 1,
      acceptedAt: "2026-08-19T00:00:00.000Z",
      heartbeatIntervalSeconds: 15,
      draining: false,
    });
    expect(result.closedBatchIds).toEqual([]);
    expect(result.disabled).toBe(false);
  });

  it("rejects an unbounded cached batch list", () => {
    expect(() =>
      runnerHeartbeatInputSchema.parse({
        schemaVersion: 1,
        busySlots: 0,
        labels: [],
        capabilities: [],
        maxConcurrency: 2,
        agentVersion: "0.2.0",
        terminalEnabled: false,
        cachedBatchIds: Array.from({ length: 1_025 }, (_, index) => `batch-${index}`),
      }),
    ).toThrow();
  });
});
