import { describe, expect, it } from "vitest";
import { textPasteExceedsLimit } from "./bounded-text-paste";

describe("bounded input paste", () => {
  it("rejects huge input before it replaces existing text", () => {
    expect(
      textPasteExceedsLimit({
        value: "http://original",
        pastedText: "x".repeat(65536),
        maximumLength: 2048,
        selectionStart: 0,
        selectionEnd: 15,
      }),
    ).toBe(true);
  });
  it("counts replacement selections and UTF-16 exactly like HTML maxlength", () => {
    expect(
      textPasteExceedsLimit({
        value: "abcd",
        pastedText: "🚀",
        maximumLength: 4,
        selectionStart: 1,
        selectionEnd: 3,
      }),
    ).toBe(false);
    expect(
      textPasteExceedsLimit({
        value: "abcd",
        pastedText: "🚀",
        maximumLength: 4,
        selectionStart: 1,
        selectionEnd: 2,
      }),
    ).toBe(true);
  });
  it("handles insertion and unsupported selection ranges conservatively", () => {
    expect(
      textPasteExceedsLimit({
        value: "abc",
        pastedText: "d",
        maximumLength: 4,
        selectionStart: null,
        selectionEnd: null,
      }),
    ).toBe(false);
    expect(
      textPasteExceedsLimit({
        value: "abc",
        pastedText: "de",
        maximumLength: 4,
        selectionStart: null,
        selectionEnd: null,
      }),
    ).toBe(true);
  });
});
