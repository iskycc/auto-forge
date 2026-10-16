import { describe, expect, it } from "vitest";
import { singleCaseExecutionStatus } from "./case-execution-presentation";

describe("single-case execution result presentation", () => {
  it.each(["queued", "assigned", "running"] as const)(
    "shows the current %s state while retrying a failed attempt",
    (status) => {
      expect(singleCaseExecutionStatus(status, "failed")).toBe(status);
    },
  );

  it("preserves the timeout outcome when the run has finished as failed", () => {
    expect(singleCaseExecutionStatus("failed", "timed_out")).toBe("timed_out");
  });

  it("uses the terminal run status when no attempt outcome exists", () => {
    expect(singleCaseExecutionStatus("cancelled", undefined)).toBe("cancelled");
    expect(singleCaseExecutionStatus("failed", undefined)).toBe("failed");
  });

  it("shows cancellation while an earlier failed attempt is waiting for retry", () => {
    expect(singleCaseExecutionStatus("cancelled", "failed")).toBe("cancelled");
  });

  it("shows successful completion and pending preparation", () => {
    expect(singleCaseExecutionStatus("succeeded", "succeeded")).toBe("succeeded");
    expect(singleCaseExecutionStatus(undefined, undefined)).toBe("queued");
  });
});
