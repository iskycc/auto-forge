import { describe, expect, it } from "vitest";

import { visibleAttemptLogText } from "./log-presentation";

describe("visibleAttemptLogText", () => {
  it("hides a complete adapter failure-summary control record", () => {
    expect(
      visibleAttemptLogText(
        "ERROR 中文断言失败\nTestCase Run Failed Stack Base64: [5Lit5paH]\nnext line\n",
      ),
    ).toBe("ERROR 中文断言失败\nnext line\n");
  });

  it("hides an incomplete control record at the end of a live log snapshot", () => {
    expect(visibleAttemptLogText("ERROR failed\nTestCase Run Failed Stack Base64: [YWJj")).toBe(
      "ERROR failed\n",
    );
  });

  it("preserves similar user output that is not a valid control record", () => {
    const logText = "prefix TestCase Run Failed Stack Base64: [YWJj]\ninvalid: [not base64!]\n";
    expect(visibleAttemptLogText(logText)).toBe(logText);
  });
});
