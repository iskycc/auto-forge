import { describe, expect, it } from "vitest";
import type { RunBatch } from "@autoforge/domain";
import { caseDebugResult } from "./case-debug-result";

const completed = {
  status: "succeeded",
  totalRuns: 1,
  succeededRuns: 0,
  failedRuns: 1,
  timedOutRuns: 0,
  cancelledRuns: 0,
} satisfies Parameters<typeof caseDebugResult>[0];

describe("debug result separates case outcome from batch completion", () => {
  it("shows failure for a normally completed batch with failed cases", () => {
    expect(caseDebugResult(completed)).toEqual({ label: "执行失败", color: "error" });
  });

  it("shows success only when the completed batch has actual passing cases", () => {
    expect(caseDebugResult({ ...completed, failedRuns: 0, succeededRuns: 1 })).toEqual({
      label: "执行通过",
      color: "success",
    });
    expect(caseDebugResult({ ...completed, failedRuns: 0 })).toEqual({
      label: "结果待确认",
      color: "default",
    });
    expect(caseDebugResult({ ...completed, totalRuns: 0, failedRuns: 0 })?.color).not.toBe(
      "success",
    );
  });

  it("keeps timeouts, cancellation and abnormal completion distinct", () => {
    expect(caseDebugResult({ ...completed, failedRuns: 0, timedOutRuns: 1 })).toEqual({
      label: "执行超时",
      color: "warning",
    });
    expect(caseDebugResult({ ...completed, status: "cancelled", cancelledRuns: 1 })).toEqual({
      label: "已终止",
      color: "default",
    });
    expect(caseDebugResult({ ...completed, status: "failed", failedRuns: 0 })?.color).toBe("error");
  });

  it.each<RunBatch["status"]>(["queued", "dispatching", "scheduled", "running"])(
    "does not display a final outcome while %s, even after an earlier attempt failed",
    (status) => {
      expect(caseDebugResult({ ...completed, status })).toBeUndefined();
    },
  );
});
