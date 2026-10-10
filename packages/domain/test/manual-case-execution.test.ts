import { describe, expect, it } from "vitest";
import { isManualCaseExecution, type RunBatchKind } from "../src/run-batch";

describe("manual case execution boundary", () => {
  it.each<[RunBatchKind | undefined, string, boolean]>([
    ["case_log_rerun", "suite-1", true],
    ["standard", "single:case-1", true],
    [undefined, "single:case-1", true],
    ["standard", "suite-1", false],
    ["final_failure_rerun", "single:case-1", false],
    ["final_failure_rerun", "suite-1", false],
  ])("classifies %s / %s as manual=%s", (kind, suiteId, expected) => {
    expect(isManualCaseExecution({ kind, suiteId })).toBe(expected);
  });
});
