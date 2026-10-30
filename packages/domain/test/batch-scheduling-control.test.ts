import { describe, expect, it } from "vitest";
import { shouldChangeBatchScheduling } from "../src/batch-scheduling-control";

describe("batch scheduling control", () => {
  const running = {
    status: "running" as const,
    terminationRequestedAt: null,
    pauseRequestedAt: null,
  };
  it("makes repeated pause and resume idempotent", () => {
    expect(shouldChangeBatchScheduling(running, "pause")).toBe(true);
    expect(shouldChangeBatchScheduling(running, "resume")).toBe(false);
    const paused = { ...running, pauseRequestedAt: "2026-10-30T00:00:00.000Z" };
    expect(shouldChangeBatchScheduling(paused, "pause")).toBe(false);
    expect(shouldChangeBatchScheduling(paused, "resume")).toBe(true);
  });
  it.each(["succeeded", "failed", "cancelled"] as const)("does not reopen a %s batch", (status) => {
    expect(() => shouldChangeBatchScheduling({ ...running, status }, "resume")).toThrow(
      "不能暂停或继续调度",
    );
  });
  it("gives termination priority over pause and resume", () => {
    expect(() =>
      shouldChangeBatchScheduling(
        { ...running, terminationRequestedAt: "2026-10-30T00:00:00.000Z" },
        "pause",
      ),
    ).toThrow("正在终止");
  });
});
