import { describe, expect, it } from "vitest";
import { executionRoundSelection } from "./execution-round-selection";

describe("execution round selection", () => {
  it.each([null, "", "missing", "0", "-1", "999", "recovery-2"])(
    "defaults %s to summary instead of the latest executed round",
    (requested) => {
      expect(executionRoundSelection(requested, [1, 2, 3], [1])).toBe("summary");
    },
  );
  it.each(["summary", "all", "1", "3", "recovery-1"])(
    "preserves an explicitly selected %s scope",
    (requested) => {
      expect(executionRoundSelection(requested, [1, 2, 3], [1])).toBe(requested);
    },
  );
  it("can show the summary before round statistics have been prepared", () => {
    expect(executionRoundSelection(null, [], [])).toBe("summary");
  });
});
