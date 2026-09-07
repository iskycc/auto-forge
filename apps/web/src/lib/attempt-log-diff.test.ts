import { describe, expect, it } from "vitest";

import { compareAttemptLogs, MAXIMUM_COMPARISON_LINES } from "./attempt-log-diff";

describe("attempt log comparison", () => {
  it("aligns unchanged lines around insertions, replacements and removals", () => {
    const { rows } = compareAttemptLogs(
      "start\nold\nanchor\ndeleted\nend",
      "start\nnew\nextra\nanchor\nend",
    );
    expect(rows.map((row) => row.kind)).toEqual([
      "equal",
      "changed",
      "added",
      "equal",
      "removed",
      "equal",
    ]);
    expect(rows[3]).toMatchObject({
      previous: { number: 3, text: "anchor" },
      current: { number: 4, text: "anchor" },
    });
    expect(rows[4]).toMatchObject({ previous: { number: 4, text: "deleted" } });
  });

  it("preserves repeated lines without cascading differences", () => {
    const { rows } = compareAttemptLogs("repeat\nrepeat\nend", "repeat\ninsert\nrepeat\nend");
    expect(rows.filter((row) => row.kind !== "equal")).toEqual([
      { kind: "added", current: { number: 2, text: "insert" } },
    ]);
  });

  it("normalizes ANSI and CRLF while hiding execution protocol control records", () => {
    const { rows } = compareAttemptLogs(
      "\u001b[31m错误\u001b[0m\r\nTestCase Run Failed Stack Base64: [YWJj]\r\n",
      "错误\n",
    );
    expect(rows).toEqual([
      {
        kind: "equal",
        previous: { number: 1, text: "错误" },
        current: { number: 1, text: "错误" },
      },
    ]);
  });

  it("handles empty logs and keeps untrusted log content as text", () => {
    expect(compareAttemptLogs("", "").rows).toEqual([]);
    expect(compareAttemptLogs("", "<script>alert(1)</script>").rows).toEqual([
      { kind: "added", current: { number: 1, text: "<script>alert(1)</script>" } },
    ]);
  });

  it("bounds comparison work and reports omitted lines", () => {
    const previous = Array.from(
      { length: MAXIMUM_COMPARISON_LINES + 10 },
      (_, index) => `before ${index}`,
    ).join("\n");
    const current = previous.replaceAll("before", "after");
    const result = compareAttemptLogs(previous, current);
    expect(result.limited).toBe(true);
    expect(result.rows).toHaveLength(MAXIMUM_COMPARISON_LINES);
    expect(result.rows.every((row) => row.kind === "changed")).toBe(true);
  });
});
