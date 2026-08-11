import { describe, expect, it } from "vitest";

import { parseSafeAnsi } from "./safe-ansi";

describe("safe ANSI rendering", () => {
  it("maps bounded SGR colors and removes non-rendering controls", () => {
    expect(parseSafeAnsi("plain\u001b[31;1mfailed\u001b[0m\u0000\u001b[2Jdone")).toEqual([
      { text: "plain", classes: [] },
      { text: "failed", classes: ["ansi-bold", "ansi-red"] },
      { text: "done", classes: [] },
    ]);
  });

  it("does not interpret OSC links or incomplete escapes", () => {
    const rendered = parseSafeAnsi("\u001b]8;;https://example.test\u0007label\u001b[broken");
    expect(rendered.map((segment) => segment.text).join("")).not.toContain("https://");
    expect(rendered.map((segment) => segment.text).join("")).toContain("label");
  });
});
