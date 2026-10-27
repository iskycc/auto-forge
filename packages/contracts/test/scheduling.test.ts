import { describe, expect, it } from "vitest";

import {
  createRunBatchInputSchema,
  createSingleCaseRunInputSchema,
  runBatchPreflightResultSchema,
  rerunCaseFromAttemptInputSchema,
  caseLogRerunConfigurationSchema,
} from "../src/scheduling";

describe("createRunBatchInputSchema", () => {
  it("only accepts the task id and bounded scheduling delay", () => {
    expect(createRunBatchInputSchema.parse({ suiteId: "suite-1" })).toEqual({
      suiteId: "suite-1",
      delaySeconds: 0,
    });
    expect(createRunBatchInputSchema.parse({ suiteId: "suite-1", delaySeconds: 300 })).toEqual({
      suiteId: "suite-1",
      delaySeconds: 300,
    });
    expect(() =>
      createRunBatchInputSchema.parse({ suiteId: "suite-1", delaySeconds: 604_801 }),
    ).toThrow();
    expect(() => createRunBatchInputSchema.parse({ suiteId: "suite-1", retryLimit: 2 })).toThrow();
  });

  it("rejects duplicate runners for a single-case shortcut", () => {
    expect(() =>
      createSingleCaseRunInputSchema.parse({
        runnerIds: ["runner-1", "runner-1"],
      }),
    ).toThrow();
  });

  it("rejects single-case queue policies outside the recoverable server bounds", () => {
    expect(() =>
      createSingleCaseRunInputSchema.parse({
        runnerIds: ["runner-1"],
        queueTimeoutMs: 999,
      }),
    ).toThrow();
  });

  it("rejects removed single-case parameter overrides", () => {
    expect(() =>
      createSingleCaseRunInputSchema.parse({
        runnerIds: ["runner-1"],
        parameters: { REGION: "cn" },
      }),
    ).toThrow();
  });

  it("accepts exactly one resource selection mode for a single-case shortcut", () => {
    expect(createSingleCaseRunInputSchema.parse({ runnerGroupId: "group-1" })).toMatchObject({
      runnerIds: [],
      runnerGroupId: "group-1",
    });
    for (const resourceSelection of [{}, { runnerIds: ["runner-1"], runnerGroupId: "group-1" }]) {
      expect(() => createSingleCaseRunInputSchema.parse(resourceSelection)).toThrow();
    }
  });

  it("requires and preserves Adapter environment addresses for a single case", () => {
    const parsed = createSingleCaseRunInputSchema.parse({
      runnerIds: ["runner-1"],
      adapter: {
        enabled: true,
        suiteName: "IP Suite",
        testName: "IP Test",
        environmentAddresses: ["10.0.0.21"],
      },
    });
    expect(parsed.adapter.environmentAddresses).toEqual(["10.0.0.21"]);
    expect(() =>
      createSingleCaseRunInputSchema.parse({
        runnerIds: ["runner-1"],
        adapter: {
          enabled: true,
          suiteName: "IP Suite",
          testName: "IP Test",
          environmentAddresses: [],
        },
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

describe("log rerun environment override", () => {
  it("keeps the existing task address length for read-only legacy defaults", () => {
    const environmentIp = "x".repeat(2048);
    expect(caseLogRerunConfigurationSchema.parse({ adapterEnabled: true, environmentIp })).toEqual({
      adapterEnabled: true,
      environmentIp,
    });
  });
  it("accepts an optional single IPv4 or IPv6 address and trims it", () => {
    expect(rerunCaseFromAttemptInputSchema.parse({})).toEqual({});
    expect(rerunCaseFromAttemptInputSchema.parse({ environmentIp: " 10.0.0.99 " })).toEqual({
      environmentIp: "10.0.0.99",
    });
    expect(rerunCaseFromAttemptInputSchema.parse({ environmentIp: "2001:db8::99" })).toEqual({
      environmentIp: "2001:db8::99",
    });
  });
  it.each(["", "10.0.0.999", "node.example", "10.0.0.1,10.0.0.2", "http://10.0.0.1"])(
    "rejects an invalid edited IP: %s",
    (environmentIp) => {
      expect(rerunCaseFromAttemptInputSchema.safeParse({ environmentIp }).success).toBe(false);
    },
  );
  it("rejects task or Adapter configuration changes", () => {
    expect(
      rerunCaseFromAttemptInputSchema.safeParse({ environmentIp: "10.0.0.99", suiteId: "task" })
        .success,
    ).toBe(false);
  });
});
