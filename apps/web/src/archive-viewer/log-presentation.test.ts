import { describe, expect, it } from "vitest";
import { presentArchiveLogPage } from "./log-presentation";

describe("offline archive log presentation", () => {
  it("shares ANSI colors and level highlighting, hides protocol metadata and preserves Chinese", () => {
    const page = presentArchiveLogPage([
      { content: "\u001b[31;1mERROR 中文🚀" },
      { content: "\u001b[0m\r\nINFO 完成\nTestCase Run Failed Stack Base64: [c2VjcmV0]\n" },
    ]);
    expect(page.text).toBe("ERROR 中文🚀\nINFO 完成\n");
    expect(page.windows.flat().some((segment) => segment.classes.includes("ansi-red"))).toBe(true);
    expect(page.windows.flat().some((segment) => segment.classes.includes("log-level-info"))).toBe(
      true,
    );
  });
  it("carries incomplete colors across HTTP pages without exposing their bytes", () => {
    const first = presentArchiveLogPage([{ content: "before\u001b[3" }]);
    const second = presentArchiveLogPage([{ content: "2m绿色\u001b[0m" }], first.ansiState);
    expect(first.text + second.text).toBe("before绿色");
    expect(second.windows[0]![0]!.classes).toContain("ansi-green");
  });
  it("bounds each visible window and preserves all text and full surrogate pairs", () => {
    const source = "INFO 中文🚀 ".repeat(20000);
    const page = presentArchiveLogPage([{ content: source }]);
    expect(page.windows.length).toBeGreaterThan(1);
    expect(
      page.windows
        .flat()
        .map((segment) => segment.text)
        .join(""),
    ).toBe(source);
    for (const window of page.windows) {
      expect(window.length).toBeLessThanOrEqual(1500);
      const text = window.map((segment) => segment.text).join("");
      expect(text.length).toBeLessThanOrEqual(65536);
      expect(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(text))).toBe(
        text,
      );
    }
  });
  it("returns plain copy text without terminal links or control codes", () => {
    const page = presentArchiveLogPage([
      { content: "\u001b]8;;https://evil.test\u0007<label>\u001b]8;;\u0007\u001b[2J\u0000" },
    ]);
    expect(page.text).toBe("<label>");
  });
});

it("carries a standalone ESC and split OSC without printing control payloads", () => {
  const a = presentArchiveLogPage([{ content: "plain\u001b" }]);
  const b = presentArchiveLogPage([{ content: "[31m红色\u001b]8;;https://" }], a.ansiState);
  const c = presentArchiveLogPage(
    [{ content: "evil.test\u0007链接\u001b]8;;\u0007" }],
    b.ansiState,
  );
  expect(a.text + b.text + c.text).toBe("plain红色链接");
  expect(c.windows[0]![0]!.classes).toContain("ansi-red");
});
