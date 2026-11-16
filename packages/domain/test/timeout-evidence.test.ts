import { describe, expect, it } from "vitest";
import { describeExecutionTimeout } from "../src/timeout-evidence";

describe("execution timeout evidence", () => {
  it("distinguishes an execution deadline from a still-live lease", () => {
    const summary = describeExecutionTimeout({
      startedAt: "2026-11-13T14:00:00.000Z",
      detectedAt: "2026-11-13T14:10:01.000Z",
      timeoutMs: 600000,
      leaseRenewedAt: "2026-11-13T14:09:55.000Z",
      leaseExpiresAt: "2026-11-13T14:10:40.000Z",
      runnerLastSeenAt: "2026-11-13T14:09:56.000Z",
    });
    expect(summary).toContain("配置期限：600 秒；已计时：601.0 秒");
    expect(summary).toContain("并非租约失联");
    expect(summary).toContain("不能证明 OOM");
  });
  it("does not invent timing or a JVM reason for incomplete historical records", () => {
    expect(
      describeExecutionTimeout({
        startedAt: null,
        detectedAt: "2026-11-13T14:10:00.000Z",
        timeoutMs: 600000,
        leaseRenewedAt: null,
        leaseExpiresAt: null,
        runnerLastSeenAt: null,
      }),
    ).toContain("已计时：未记录");
  });
});
