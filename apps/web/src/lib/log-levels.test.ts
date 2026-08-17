import { describe, expect, it } from "vitest";

import { highlightLogLevels } from "./log-levels";
import { parseSafeAnsi } from "./safe-ansi";

describe("log level highlighting", () => {
  it("highlights common level tokens case-insensitively", () => {
    const segments = highlightLogLevels(
      parseSafeAnsi("2026-08-15 INFO started\n2026-08-15 error boom"),
    );
    expect(segments).toEqual([
      { text: "2026-08-15 ", classes: [] },
      { text: "INFO", classes: ["log-level-info"] },
      { text: " started\n2026-08-15 ", classes: [] },
      { text: "error", classes: ["log-level-error"] },
      { text: " boom", classes: [] },
    ]);
  });

  it("maps warning to the same style as warn", () => {
    const segments = highlightLogLevels(parseSafeAnsi("WARNING: disk full"));
    expect(segments).toEqual([
      { text: "WARNING", classes: ["log-level-warn"] },
      { text: ": disk full", classes: [] },
    ]);
  });

  it("keeps ANSI classes on non-level text and still marks levels inside colored segments", () => {
    const segments = highlightLogLevels(parseSafeAnsi("\u001b[31mfailed with ERROR\u001b[0m ok"));
    expect(segments).toEqual([
      { text: "failed with ", classes: ["ansi-red"] },
      { text: "ERROR", classes: ["ansi-red", "log-level-error"] },
      { text: " ok", classes: [] },
    ]);
  });

  it("does not highlight level words embedded in longer identifiers", () => {
    const segments = highlightLogLevels(parseSafeAnsi("my_error_code informational infoX"));
    expect(segments).toEqual([{ text: "my_error_code informational infoX", classes: [] }]);
  });
});
